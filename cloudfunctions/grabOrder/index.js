// 师傅抢单:资格校验 -> 钱包原子扣款(按订单场景) -> 原子条件更新抢单(没抢到自动退款)
// 接单费制(取代会员制):家用/商用按 _shared/biz.js 的 SCENES.grabFee 扣费
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const { STATUS, SCENES, normalizeCity } = require('./biz')
const log = require('./logger')('grabOrder')

function bad(msg) { return { ok: false, msg } }

// 退款失败落库:不再只留 console 日志——写 status:need_manual 的退款流水,
// cronTimeout 对账认领后自动补退(每小时),admin 的 walletQuery 也能检索到;连这条流水
// 都写不进去时才是真正的人工调账,留 error 日志
async function markRefundManual(orderId, openid, fee, scene, err) {
  log.error('退款失败,落待补流水等 cron 自动退回', { orderId, openid, fee }, err)
  await db.collection('wallet_logs').add({
    data: {
      _id: `refund:grab:${orderId}:${openid}`, openid, type: 'refund', amount: fee,
      orderId, scene, status: 'need_manual', createdAt: db.serverDate()
    }
  }).catch(e => log.error('待补退款流水写入失败,需人工调账', { orderId, openid, fee }, e))
}

exports.main = async (event) => {
  const start = Date.now()
  const { OPENID } = cloud.getWXContext()
  const { orderId } = event
  if (!orderId) return bad('参数错误')

  // 抢单资格:审核通过(不再校验会员有效期,会员制已由按单接单费取代)
  const master = (await db.collection('masters').where({ openid: OPENID }).get()).data[0]
  if (!master || master.status !== 'approved') return bad('请先入驻并通过审核')

  // 接单费按订单场景计;老订单(无 scene 字段)一律按家用
  const preOrder = (await db.collection('orders').doc(orderId).get().catch(() => ({ data: null }))).data
  if (!preOrder) return bad('订单不存在')
  // 前置闸:终态/已被接的单直接拒绝,不再"先扣款再走 miss 分支退回"
  // 白穿两个易碎点;最终原子性仍由下方条件更新保证
  if (preOrder.status !== STATUS.PUBLISHED) return bad('手慢了,该订单已被接走或已取消')
  const scene = SCENES[preOrder.scene] ? preOrder.scene : 'home'
  const fee = SCENES[scene].grabFee

  // 原子扣款:余额不足(含没有钱包文档)时命中 0 行——单文档条件更新天然防负余额、防并发双花
  const debit = await db.collection('wallets').where({
    _id: OPENID,
    balance: _.gte(fee)
  }).update({ data: { balance: _.inc(-fee), updatedAt: db.serverDate() } })
  if (debit.stats.updated === 0) {
    return bad(`钱包余额不足,接本单(${SCENES[scene].name}单)需 ¥${fee / 100},请先充值`)
  }

  // 扣款流水:_id 带上 openid——同一单会被多个师傅先后尝试,只有一人成功,
  // 每个尝试者的扣款/退款流水都要留痕,单靠 orderId 做 _id 必然冲突
  try {
    await db.collection('wallet_logs').add({
      data: { _id: `grab:${orderId}:${OPENID}`, openid: OPENID, type: 'grab', amount: -fee, orderId, scene, createdAt: db.serverDate() }
    })
  } catch (e) {
    // 理论不可达(同一人同一单只可能走到一次);万一写入冲突:宁可让师傅重试一次,
    // 不能带着账务疑点接单 —— 退回后明确失败
    log.error('grab wallet_log write failed, refund', { orderId, openid: OPENID, fee }, e)
    await db.collection('wallets').where({ _id: OPENID })
      .update({ data: { balance: _.inc(fee) } })
      .catch(err => markRefundManual(orderId, OPENID, fee, scene, err))
    return bad('扣款异常,请重试')
  }

  // 原子抢单:仅当订单仍是"待接单"、同城、未过期且不是自己发的,才写入接单信息
  // cityKey 条件封死绕过订单池直接跨城抢单(归一化匹配键,);
  // publishedAt 条件兜住定时器间隙内的过期单;
  // 品类与池同规则(多选发单):老单按 category、新单按 categories 任一交集
  const res = await db.collection('orders').where(_.and([
    {
      _id: orderId,
      status: STATUS.PUBLISHED,
      userOpenid: _.neq(OPENID),
      cityKey: master.cityKey || normalizeCity(master.serviceCity),
      publishedAt: _.gt(new Date(Date.now() - 48 * 3600 * 1000)),
      expectEnd: _.gt(new Date())
    },
    _.or([{ category: _.in(master.categories || []) }, { categories: _.in(master.categories || []) }])
  ])).update({
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
    // 没抢到:接单费原路退回(退款流水 refund:grab:{orderId} 幂等,重放不重复加钱)
    try {
      await db.collection('wallets').where({ _id: OPENID })
        .update({ data: { balance: _.inc(fee), updatedAt: db.serverDate() } })
      await db.collection('wallet_logs').add({
        data: { _id: `refund:grab:${orderId}:${OPENID}`, openid: OPENID, type: 'refund', amount: fee, orderId, scene, createdAt: db.serverDate() }
      }).catch(e => log.error('退款流水写入失败,需人工核对', { orderId, openid: OPENID, fee }, e))
    } catch (e) {
      // 线上退款失败:落 need_manual 待补流水,cronTimeout 每小时自动补退
      await markRefundManual(orderId, OPENID, fee, scene, e)
      return bad('手慢了,该订单已被接走或已取消,接单费将自动退回')
    }
    return bad('手慢了,该订单已被接走或已取消,接单费已退回')
  }

  const order = (await db.collection('orders').doc(orderId).get()).data
  log.info('grab success', { orderId, openid: OPENID, fee, ms: Date.now() - start })

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

  // 返回用户联系方式与完整地址,师傅端直接可拨打;feeCharged 供前端提示"已扣接单费 ¥X"
  return {
    ok: true,
    feeCharged: fee,
    sceneName: SCENES[scene].name,
    userPhone: order.userPhone,
    userName: order.userName,
    address: order.address + (order.addressDetail ? ' ' + order.addressDetail : '')
  }
}
