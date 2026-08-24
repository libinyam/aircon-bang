// 师傅钱包:余额与流水查询、微信支付充值下单
// - 充值金额只在下单时校验并预写 pending 流水;实际入账由 payCallback 按本地记录的金额回调
// - 余额扣款不在这里:接单扣费内嵌在 grabOrder(抢单失败原路退回),人工调账在 admin
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const { nextBizNo } = require('./bizNo')
const log = require('./logger')('wallet')

const PAGE_SIZE = 20
// 充值档位(分):固定档位下单,服务端只认这几个值,不开放任意金额
const RECHARGE_OPTIONS = [5000, 10000, 20000, 50000]

function bad(msg) { return { ok: false, msg } }

const actions = {
  // 余额 + 最近流水(钱包页首屏一次拉齐;无钱包文档视作余额 0)
  async get({ page = 0 }, openid) {
    const w = (await db.collection('wallets').where({ _id: openid }).get()).data[0]
    const logs = (await db.collection('wallet_logs').where({ openid })
      .orderBy('createdAt', 'desc').skip(page * PAGE_SIZE).limit(PAGE_SIZE).get()).data
    return {
      ok: true,
      balance: w && Number.isFinite(w.balance) ? w.balance : 0,
      logs,
      hasMore: logs.length === PAGE_SIZE
    }
  },

  // 微信支付充值下单:固定档位 -> 预写 pending 流水 -> cloudPay 统一下单 -> payment 参数
  // 前端拿 payment 调 wx.requestPayment;结果由微信推送到 payCallback 云函数入账。
  // 没有配置商户号(config/app 的 payMchId)时明确报错,前端降级为人工充值指引
  async recharge({ amount }, openid) {
    const totalFee = Number(amount)
    if (!RECHARGE_OPTIONS.includes(totalFee)) return bad('请选择充值档位')

    const cfg = (await db.collection('config').doc('app').get().catch(() => ({ data: {} }))).data
    if (!cfg.payMchId) return bad('在线充值暂未开通,请联系平台客服人工充值')

    const outTradeNo = await nextBizNo('W', async no =>
      (await db.collection('wallet_logs').where({ _id: `recharge:${no}` }).count()).total > 0)
    if (!outTradeNo) return bad('单号生成失败,请重试')

    // 预写 pending 流水:outTradeNo -> amount 的本地映射,回调只按这份金额入账
    await db.collection('wallet_logs').add({
      data: {
        _id: `recharge:${outTradeNo}`,
        openid,
        type: 'recharge',
        amount: totalFee,
        status: 'pending',
        outTradeNo,
        createdAt: db.serverDate()
      }
    })

    try {
      const res = await cloud.cloudPay.unifiedOrder({
        body: '接单服务费充值',
        outTradeNo,
        spbillCreateIp: '127.0.0.1',
        subMchId: cfg.payMchId,
        totalFee,
        envId: cloud.getWXContext().ENV,
        functionName: 'payCallback'
      })
      log.info('recharge order created', { openid, outTradeNo, totalFee })
      return { ok: true, outTradeNo, payment: res.payment }
    } catch (e) {
      // 下单失败不留悬念的 pending:标 failed,同一单号不会被回调入账
      await db.collection('wallet_logs').where({ _id: `recharge:${outTradeNo}`, status: 'pending' })
        .update({ data: { status: 'failed' } }).catch(() => {})
      log.error('unifiedOrder failed', { openid, outTradeNo, totalFee }, e)
      return bad('发起支付失败,请稍后重试或联系客服人工充值')
    }
  }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const fn = actions[event.action]
  if (!fn) return bad('未知操作')
  return fn(event, OPENID)
}

// 仅供离线单测使用
exports._internals = { RECHARGE_OPTIONS }
