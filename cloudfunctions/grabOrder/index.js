// 师傅抢单:资格校验 -> 原子条件更新(天然防止两个师傅抢到同一单)
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const { STATUS, normalizeCity } = require('./biz')
const log = require('./logger')('grabOrder')

function bad(msg) { return { ok: false, msg } }

exports.main = async (event) => {
  const start = Date.now()
  const { OPENID } = cloud.getWXContext()
  const { orderId } = event
  if (!orderId) return bad('参数错误')

  // 抢单资格:审核通过 + 会员在有效期内
  const master = (await db.collection('masters').where({ openid: OPENID }).get()).data[0]
  if (!master || master.status !== 'approved') return bad('请先入驻并通过审核')
  if (!master.memberExpireAt || new Date(master.memberExpireAt) < new Date()) {
    return bad('会员已到期,请联系平台续费后接单')
  }

  // 原子抢单:仅当订单仍是"待接单"、同城、未过期且不是自己发的,才写入接单信息
  // cityKey 条件封死绕过订单池直接跨城抢单(归一化匹配键,);
  // publishedAt 条件兜住定时器间隙内的过期单
  const res = await db.collection('orders').where({
    _id: orderId,
    status: STATUS.PUBLISHED,
    userOpenid: db.command.neq(OPENID),
    cityKey: master.cityKey || normalizeCity(master.serviceCity),
    category: db.command.in(master.categories || []),
    publishedAt: db.command.gt(new Date(Date.now() - 48 * 3600 * 1000)),
    expectEnd: db.command.gt(new Date())
  }).update({
    data: {
      status: STATUS.ACCEPTED,
      masterOpenid: OPENID,
      masterName: master.realName,
      masterPhone: master.phone,
      acceptedAt: db.serverDate()
    }
  })

  if (res.stats.updated === 0) {
    // 抢单冲突也留痕:单量上来后可据此看热度/供需
    log.info('grab miss', { orderId, openid: OPENID, ms: Date.now() - start })
    return bad('手慢了,该订单已被接走或已取消')
  }

  const order = (await db.collection('orders').doc(orderId).get()).data
  log.info('grab success', { orderId, openid: OPENID, ms: Date.now() - start })

  // 尽力通知用户"已接单"
  try {
    const cfg = (await db.collection('config').doc('app').get()).data
    if (cfg.tplOrderTaken) {
      await cloud.openapi.subscribeMessage.send({
        touser: order.userOpenid,
        templateId: cfg.tplOrderTaken,
        page: 'pages/orders/orders',
        // 字段名需与申请的模板一致,申请后按实际字段调整这里
        data: {
          character_string1: { value: order.orderNo },
          name3: { value: master.realName },
          phone_number6: { value: master.phone }
        }
      })
    }
  } catch (e) { log.error('order-taken notify failed(不影响抢单)', { orderId }, e) }

  // 返回用户联系方式与完整地址,师傅端直接可拨打
  return {
    ok: true,
    userPhone: order.userPhone,
    userName: order.userName,
    address: order.address + (order.addressDetail ? ' ' + order.addressDetail : '')
  }
}
