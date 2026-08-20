// 用户评价已完成订单:以 orderId 作评价文档ID,天然一单一评
// 顺序:先写评价、再翻订单标记——任一步失败都可安全重试,不会出现"已评价却查不到评价"
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const textSafe = require('./textSafe')(cloud)
const { STATUS } = require('./biz')

function bad(msg) { return { ok: false, msg } }

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const { orderId, stars, content = '' } = event

  const s = parseInt(stars, 10)
  if (!orderId || !(s >= 1 && s <= 5)) return bad('参数错误')
  // content 必须是字符串:显式传 null/数字/对象时 .length/.trim 会抛 500;
  // 缺省/undefined 仍按空字符串处理
  if (typeof content !== 'string') return bad('参数错误')
  if (content.length > 300) return bad('评价内容太长了')
  if (!(await textSafe(content))) return bad('内容含违规信息,请修改后重试')

  const order = (await db.collection('orders').doc(orderId).get().catch(() => ({ data: null }))).data
  if (!order) return bad('订单不存在')
  if (order.status !== STATUS.COMPLETED || order.userOpenid !== OPENID) return bad('该订单不可评价')
  if (order.reviewed) return bad('该订单已评价过')

  try {
    await db.collection('reviews').add({
      data: {
        _id: orderId,
        orderId,
        orderNo: order.orderNo,
        categoryName: order.categoryName,
        masterOpenid: order.masterOpenid,
        userOpenid: OPENID,
        stars: s,
        content: content.trim(),
        // 统计记账标记:先落 false,累计成功翻 true;翻不动的由 cron 补账
        statsApplied: false,
        createdAt: db.serverDate()
      }
    })
  } catch (e) {
    // 只有确认是"_id 已存在"的幂等冲突才自愈补翻标记;其他写失败(超时/抖动)必须让用户
    // 重试,不能错误推进 reviewed——否则出现"已评价却查不到评价"且无法重评
    const isDuplicate = (e && e.errCode === -502001) ||
      /duplicate|already exist/i.test((e && (e.errMsg || e.message)) || '')
    if (!isDuplicate) {
      console.error('review add failed (non-duplicate), user can retry', orderId, e)
      return bad('评价提交失败,请稍后重试')
    }
    // 评价文档已存在(并发/上次标记未翻成功):自愈补翻标记后拒绝重复
    await db.collection('orders').doc(orderId).update({ data: { reviewed: true } }).catch(e => console.error('self-heal reviewed flag failed', orderId, e))
    return bad('该订单已评价过')
  }

  // 标记失败可下次自愈(上面的 catch 分支),不阻断
  await db.collection('orders').doc(orderId).update({ data: { reviewed: true } })
    .catch(e => console.error('set reviewed failed, will self-heal on retry', e))

  // 评价统计"先原子认领再累计":认领 updated===0 说明已被 cron 补账路径记走;
  // 累计抛错回滚认领,cron 下一轮按 statsApplied:false 的评价文档补记,不再永久漏计
  const claim = await db.collection('reviews').where({ _id: orderId, statsApplied: false })
    .update({ data: { statsApplied: true } })
  if (claim.stats.updated > 0) {
    try {
      const upd = await db.collection('masters').where({ openid: order.masterOpenid }).update({
        data: { 'stats.reviewCount': _.inc(1), 'stats.totalStars': _.inc(s) }
      })
      if (upd.stats.updated === 0) console.error('review stats inc: master not found', orderId)
    } catch (e) {
      console.error('review stats inc failed, cron will retry', orderId, e)
      await db.collection('reviews').where({ _id: orderId, statsApplied: true })
        .update({ data: { statsApplied: false } })
        .catch(e2 => console.error('statsApplied rollback failed, needs manual reconcile', orderId, e2))
    }
  }

  return { ok: true }
}
