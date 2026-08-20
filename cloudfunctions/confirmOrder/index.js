// 用户对"待确认"订单的裁决:
// - 确认完成:pending_confirm -> completed,师傅完成数 +1
// - 驳回:pending_confirm -> accepted,记录驳回次数,防师傅"秒点完成"刷单
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const { STATUS } = require('./biz')
const textSafe = require('./textSafe')(cloud)

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const { orderId, reject = false, reason = '' } = event
  if (!orderId) return { ok: false, msg: '参数错误' }

  if (reject) {
    // 驳回原因写库并展示给师傅:类型/长度/内容安全在状态回退前拦;
    // 校验失败不推进订单状态
    if (typeof reason !== 'string') return { ok: false, msg: '参数错误' }
    if (reason.length > 100) return { ok: false, msg: '驳回原因太长了(不超过100字)' }
    if (reason.trim() && !(await textSafe(reason))) return { ok: false, msg: '原因含违规信息,请修改后重试' }
    const res = await db.collection('orders').where({
      _id: orderId,
      status: STATUS.PENDING_CONFIRM,
      userOpenid: OPENID
    }).update({
      data: {
        status: STATUS.ACCEPTED,
        rejectCount: _.inc(1),
        lastRejectReason: (reason || '').trim(),
        lastRejectedAt: db.serverDate()
      }
    })
    if (res.stats.updated === 0) return { ok: false, msg: '订单状态已变化,请刷新' }

    // 驳回后师傅不能蒙在鼓里:尽力推订阅消息,模板未配置或未订阅则跳过
    try {
      const cfg = (await db.collection('config').doc('app').get()).data
      if (cfg.tplOrderRejected) {
        const order = (await db.collection('orders').doc(orderId).get()).data
        if (order.masterOpenid) {
          await cloud.openapi.subscribeMessage.send({
            touser: order.masterOpenid,
            templateId: cfg.tplOrderRejected,
            page: `pages/orderDetail/orderDetail?id=${orderId}`,
            // 模板 12850"订单异常提醒":订单编号/异常内容/备注
            data: {
              character_string6: { value: order.orderNo },
              thing10: { value: '用户反馈服务未完成,请联系客户处理' },
              thing5: { value: ((reason || '').trim() || '用户未填写原因').slice(0, 20) }
            }
          })
        }
      }
    } catch (e) { console.error('reject notify failed(不影响驳回)', orderId, e) }
    return { ok: true }
  }

  const res = await db.collection('orders').where({
    _id: orderId,
    status: STATUS.PENDING_CONFIRM,
    userOpenid: OPENID
  }).update({
    // statsCredited 与状态翻转同单落盘:记账与翻转解耦,失败由 cron 补账
    data: { status: STATUS.COMPLETED, statsCredited: false, confirmedAt: db.serverDate() }
  })
  if (res.stats.updated === 0) return { ok: false, msg: '订单状态已变化,请刷新' }

  const order = (await db.collection('orders').doc(orderId).get()).data
  // 完成数记账"先原子认领再累计":认领 updated===0 说明已被 cron 补账路径记走;
  // 累计抛错回滚认领,cron 下一轮按 statsCredited:false 重新拾起,不再永久漏计
  if (order.masterOpenid) {
    const claim = await db.collection('orders').where({ _id: orderId, statsCredited: false })
      .update({ data: { statsCredited: true } })
    if (claim.stats.updated > 0) {
      try {
        const upd = await db.collection('masters').where({ openid: order.masterOpenid })
          .update({ data: { 'stats.done': _.inc(1) } })
        // 师傅档案已不存在(注销等):记账落空但不重试,留日志可查(与 cron 同口径)
        if (upd.stats.updated === 0) console.error('stats.done inc: master not found', orderId)
      } catch (e) {
        console.error('stats.done inc failed, cron will retry', orderId, e)
        await db.collection('orders').where({ _id: orderId, statsCredited: true })
          .update({ data: { statsCredited: false } })
          .catch(e2 => console.error('statsCredited rollback failed, needs manual reconcile', orderId, e2))
      }
    }
  }

  return { ok: true }
}
