// 微信支付充值回调:wallet.recharge 下单时 functionName 指到这里,支付结果由微信推送
// 幂等入账:recharge:{outTradeNo} 流水 pending->success 条件认领(重放/并发推送只有一个赢家),
// 金额用下单时本地预写的 amount,不信任回调数值;入账失败则回滚认领,微信重推可自愈
// 来源与真实性:本函数对任何登录用户开放直调,而支付回调是系统推送、上下文无
// OPENID——拒绝客户端来源;入账前再 queryOrder
// 反查微信侧订单,SUCCESS 判定不建立在可直接投递的 event 字段上
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const log = require('./logger')('payCallback')

// 认领回滚:success -> pending,让后续推送/重试能重新走全流程
async function rollbackClaim(outTradeNo) {
  await db.collection('wallet_logs').where({ _id: `recharge:${outTradeNo}`, status: 'success' })
    .update({ data: { status: 'pending' } })
    .catch(err => log.error('claim rollback failed, 需人工核对', { outTradeNo }, err))
}

exports.main = async (event) => {
  // 云开发支付回调的应答必须是 errcode:0,否则微信会持续重推;瞬时故障用非 0 换一次重推
  const done = { errcode: 0, errmsg: 'OK' }
  const retry = { errcode: 1, errmsg: 'RETRY' }
  try {
    // 来源校验:客户端直调必然带 OPENID,拒绝——堵死伪造 SUCCESS 免费充值
    const { OPENID } = cloud.getWXContext()
    if (OPENID) return done

    if (!event.outTradeNo) return done
    const logId = `recharge:${event.outTradeNo}`
    const paid = event.returnCode === 'SUCCESS' && event.resultCode === 'SUCCESS'

    if (!paid) {
      // 支付失败/用户取消:pending 标 failed;非 pending(已处理/已失败)不动,幂等
      await db.collection('wallet_logs').where({ _id: logId, status: 'pending' })
        .update({ data: { status: 'failed' } })
      return done
    }

    // 认领:pending -> success,条件原子更新挡住重复回调重复入账
    const claim = await db.collection('wallet_logs').where({ _id: logId, status: 'pending' })
      .update({ data: { status: 'success', paidAt: db.serverDate() } })
    if (claim.stats.updated === 0) return done // 已入账过(重放)

    const entry = (await db.collection('wallet_logs').doc(logId).get()).data
    if (!entry || !entry.openid || !Number.isFinite(entry.amount)) {
      log.error('recharge log malformed', { outTradeNo: event.outTradeNo })
      return done
    }

    // 纵深防御:反查微信侧订单,tradeState 须真实为 SUCCESS;回传金额时须与
    // 本地预写一致(部分接口形态不带 totalFee,缺失时不作为拒付依据)。
    // 查单异常按瞬时故障处理:回滚认领并以非 0 应答换微信重推,不把入账建立在失败的查询上
    const cfg = (await db.collection('config').doc('app').get().catch(() => ({ data: {} }))).data
    if (!cfg.payMchId) {
      log.error('payMchId missing, cannot verify order', { outTradeNo: event.outTradeNo })
      await rollbackClaim(event.outTradeNo)
      return done
    }
    let q = null
    try {
      q = await cloud.cloudPay.queryOrder({ subMchId: cfg.payMchId, outTradeNo: event.outTradeNo })
    } catch (e) {
      log.error('queryOrder failed, rollback for retry', { outTradeNo: event.outTradeNo }, e)
      await rollbackClaim(event.outTradeNo)
      return retry
    }
    const tradeState = q && (q.tradeState || q.trade_state)
    const feeBack = q && q.totalFee !== undefined ? q.totalFee : (q && q.total_fee)
    if (tradeState !== 'SUCCESS' || (feeBack !== undefined && Number(feeBack) !== entry.amount)) {
      log.error('queryOrder mismatch, refuse to credit', { outTradeNo: event.outTradeNo, tradeState, feeBack, amount: entry.amount })
      await rollbackClaim(event.outTradeNo)
      return done
    }

    // 入账:无钱包文档则首建;并发首充撞 _id 时退回 inc 更新重试一次
    const credit = await db.collection('wallets').where({ _id: entry.openid })
      .update({ data: { balance: _.inc(entry.amount), updatedAt: db.serverDate() } })
    if (credit.stats.updated === 0) {
      try {
        await db.collection('wallets').add({
          data: { _id: entry.openid, balance: entry.amount, createdAt: db.serverDate(), updatedAt: db.serverDate() }
        })
      } catch (e) {
        // 并发首充另一单先建了文档:再走一次 inc
        const retry2 = await db.collection('wallets').where({ _id: entry.openid })
          .update({ data: { balance: _.inc(entry.amount), updatedAt: db.serverDate() } })
        if (retry2.stats.updated === 0) throw e
      }
    }

    log.info('recharge credited', { outTradeNo: event.outTradeNo, openid: entry.openid, amount: entry.amount })
    return done
  } catch (e) {
    // 已认领但入账失败:回滚认领让微信重推重走全流程;回滚也失败则留痕人工核对
    log.error('payCallback failed', { outTradeNo: event.outTradeNo }, e)
    if (event.outTradeNo) await rollbackClaim(event.outTradeNo)
    return done
  }
}
