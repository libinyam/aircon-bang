// 投诉/举报:订单投诉(订单双方)+ 商品举报(买空调频道,任何浏览者),管理端统一处理
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const textSafe = require('./textSafe')(cloud)

function bad(msg) { return { ok: false, msg } }

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const { orderId, listingId, content = '' } = event

  if ((!orderId && !listingId) || content.trim().length < 5) return bad('请描述投诉内容(至少5个字)')
  if (content.length > 500) return bad('内容太长了')

  // 商品举报:与订单投诉共用集合与管理端处理流,按 targetType 区分渲染
  if (listingId) {
    const listing = (await db.collection('listings').doc(listingId).get().catch(() => ({ data: null }))).data
    if (!listing) return bad('商品不存在')
    if (listing.sellerOpenid === OPENID) return bad('不能举报自己发布的商品')
    if (!(await textSafe(content))) return bad('内容含违规信息,请修改后重试')

    // 去重键 listingId+举报人:同一人对同一商品最多一条待处理举报,不同买家可各自举报。
    // count+add 的并发窗口在举报场景保留:按人去重没有可原子抢占的标记位
    // (商品 disputeHold 会挡住不同买家的正当举报),穿透最多多一条运营工单,不涉账务;
    // 订单侧已用 disputeHold 抢占收口,见下方
    const dup = await db.collection('complaints').where({
      listingId, fromOpenid: OPENID, status: 'open'
    }).count()
    if (dup.total > 0) return bad('您已举报过该商品,平台会尽快处理')

    // 限频防刷:24小时内最多3条(与订单投诉共享额度)
    const recent = await db.collection('complaints').where({
      fromOpenid: OPENID,
      createdAt: db.command.gt(new Date(Date.now() - 24 * 3600 * 1000))
    }).count()
    if (recent.total >= 3) return bad('今日投诉次数已达上限,可致电平台客服')

    await db.collection('complaints').add({
      data: {
        targetType: 'listing',
        listingId,
        listingNo: listing.listingNo,
        listingTitle: listing.title,
        fromOpenid: OPENID,
        fromRole: 'viewer',
        content: content.trim(),
        status: 'open',
        handleNote: '',
        createdAt: db.serverDate()
      }
    })
    return { ok: true }
  }

  const order = (await db.collection('orders').doc(orderId).get().catch(() => ({ data: null }))).data
  if (!order) return bad('订单不存在')
  if (order.userOpenid !== OPENID && order.masterOpenid !== OPENID) return bad('无权操作')
  if (!(await textSafe(content))) return bad('内容含违规信息,请修改后重试')

  // 限频防刷:同一用户24小时内最多投诉3条(在抢占之前查,被限频的不占用去重闸)
  const recent = await db.collection('complaints').where({
    fromOpenid: OPENID,
    createdAt: db.command.gt(new Date(Date.now() - 24 * 3600 * 1000))
  }).count()
  if (recent.total >= 3) return bad('今日投诉次数已达上限,可致电平台客服')

  // 单订单去重:同一订单最多一条待处理投诉,已关闭的允许重新发起(纠纷复发)。
  // 先 count 预查挡住常见重复与存量数据(历史投诉的订单没有 disputeHold 标记),
  // 再用条件更新抢占 disputeHold 收口并发穿透——首个请求把标记从
  // "非 true"翻成 true 成功,预查后并发进来的后来者 updated===0 被拒。
  // 抢占同时就是投诉冻结:cron 自动确认的原子条件带 disputeHold,
  // 这个顺序保证投诉落在 pending_confirm 期间的订单不会被并发的自动确认翻成 completed;
  // 管理端关单时把标记翻回 false,重新发起的通道保持打开
  const dup = await db.collection('complaints').where({ orderId, status: 'open' }).count()
  if (dup.total > 0) return bad('该订单已有待处理投诉,平台会尽快联系您')

  const claim = await db.collection('orders').where({
    _id: orderId, disputeHold: _.neq(true)
  }).update({ data: { disputeHold: true } })
  if (claim.stats.updated === 0) return bad('该订单已有待处理投诉,平台会尽快联系您')

  try {
    await db.collection('complaints').add({
      data: {
        targetType: 'order',
        orderId,
        orderNo: order.orderNo,
        orderStatus: order.status,
        fromOpenid: OPENID,
        fromRole: order.userOpenid === OPENID ? 'user' : 'master',
        content: content.trim(),
        status: 'open',
        handleNote: '',
        createdAt: db.serverDate()
      }
    })
  } catch (e) {
    // 建投诉失败回滚标记:cron 的残留自愈只覆盖 pending_confirm 订单,其余状态会一直挡住重新投诉
    await db.collection('orders').where({ _id: orderId, disputeHold: true })
      .update({ data: { disputeHold: false } })
      .catch(e2 => console.error('disputeHold rollback failed', orderId, e2))
    return bad('投诉提交失败,请稍后重试')
  }
  return { ok: true }
}
