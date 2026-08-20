// 取消订单:待接单时发布者可直接取消;已接单后双方均可取消但必须填原因(留记录)
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const { STATUS } = require('./biz')
const textSafe = require('./textSafe')(cloud)

function bad(msg) { return { ok: false, msg } }

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const { orderId, reason = '' } = event
  if (!orderId) return bad('参数错误')
  // 原因要写库并展示给另一方:类型/长度/内容安全都在写库前拦;
  // 缺省/undefined 按空字符串处理,显式 null/数字/对象返回参数错误而非抛 500
  if (typeof reason !== 'string') return bad('参数错误')
  if (reason.length > 100) return bad('取消原因太长了(不超过100字)')

  const order = (await db.collection('orders').doc(orderId).get().catch(() => ({ data: null }))).data
  if (!order) return bad('订单不存在')

  const isOwner = order.userOpenid === OPENID
  const isMaster = order.masterOpenid === OPENID

  if (order.status === STATUS.PUBLISHED) {
    if (!isOwner) return bad('无权操作')
  } else if (order.status === STATUS.ACCEPTED) {
    if (!isOwner && !isMaster) return bad('无权操作')
    if (!reason.trim()) return bad('已接单的订单取消需填写原因')
  } else {
    return bad('当前状态不能取消')
  }

  // 非空原因过内容安全(fail-open:命中 87014 才拦),未接单直接取消的空原因不送检
  if (reason.trim() && !(await textSafe(reason))) return bad('原因含违规信息,请修改后重试')

  // 条件更新防并发:状态已被别人改掉就返回失败
  const res = await db.collection('orders').where({
    _id: orderId,
    status: order.status
  }).update({
    data: {
      status: STATUS.CANCELLED,
      cancelBy: isOwner ? 'user' : 'master',
      cancelReason: reason.trim(),
      cancelledAt: db.serverDate()
    }
  })
  if (res.stats.updated === 0) return bad('订单状态已变化,请刷新')

  // 师傅接单后取消要计数,供后台识别"抢单收手机号后取消"的异常行为
  if (!isOwner && order.status === STATUS.ACCEPTED) {
    await db.collection('masters').where({ openid: OPENID })
      .update({ data: { 'stats.cancelled': db.command.inc(1) } })
      .catch(e => console.error('stats.cancelled inc failed', e))
  }
  return { ok: true }
}
