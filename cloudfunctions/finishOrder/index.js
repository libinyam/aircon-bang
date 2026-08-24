// 师傅对"已接单"订单的完成操作:
// - 标记完成:accepted -> pending_confirm,等用户确认;推"待确认"订阅消息给用户
// - 撤销完成:pending_confirm -> accepted,误点后的自救出口,不计驳回次数
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const { STATUS, orderCategories, categoryText } = require('./biz')

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const { orderId, undo = false } = event
  if (!orderId) return { ok: false, msg: '参数错误' }

  if (undo) {
    const res = await db.collection('orders').where({
      _id: orderId,
      status: STATUS.PENDING_CONFIRM,
      masterOpenid: OPENID
    }).update({
      data: { status: STATUS.ACCEPTED, undoneAt: db.serverDate() }
    })
    if (res.stats.updated === 0) return { ok: false, msg: '订单状态已变化,请刷新' }
    return { ok: true }
  }

  const res = await db.collection('orders').where({
    _id: orderId,
    status: STATUS.ACCEPTED,
    masterOpenid: OPENID
  }).update({
    data: { status: STATUS.PENDING_CONFIRM, finishedAt: db.serverDate() }
  })

  if (res.stats.updated === 0) return { ok: false, msg: '订单状态已变化,请刷新' }

  // 尽力通知用户来确认:模板未配置或用户未订阅则跳过,不影响完成动作
  try {
    const cfg = (await db.collection('config').doc('app').get()).data
    if (cfg.tplOrderFinish) {
      const order = (await db.collection('orders').doc(orderId).get()).data
      // thing 限 20 字:品类用短名拼接(多选全选 11 字也不超);极端缺键的旧文档退回 categoryName 文本
      const svcText = categoryText(orderCategories(order), true) || order.categoryName || '维修服务'
      await cloud.openapi.subscribeMessage.send({
        touser: order.userOpenid,
        templateId: cfg.tplOrderFinish,
        page: `pages/orderDetail/orderDetail?id=${orderId}`,
        // 模板 1025"订单完成通知":订单编号/服务内容/温馨提示
        data: {
          character_string5: { value: order.orderNo },
          thing6: { value: svcText + '已完成' },
          thing16: { value: '请验收并确认,72小时未确认将自动完成' }
        }
      })
    }
  } catch (e) { console.error('finish notify failed(不影响完成)', orderId, e) }

  return { ok: true }
}
