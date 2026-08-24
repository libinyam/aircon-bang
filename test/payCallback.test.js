// payCallback 微信支付回调:幂等入账(pending->success 条件认领)+ 按本地金额加钱
// 来源与真实性:拒绝客户端直调(带 OPENID);入账前 queryOrder 反查微信侧订单
const { fakeDb } = require('./stubs/fakeDb')

const AMOUNT = 5000

async function pay(event, fx, { ctx = {}, queryOrder } = {}) {
  jest.resetModules()
  global.__mockDb = fakeDb(fx)
  global.__mockCtx = ctx                                   // 支付回调是系统推送:默认无 OPENID
  global.__mockQueryOrder = queryOrder || (() => ({ tradeState: 'SUCCESS', totalFee: AMOUNT }))
  const { main } = require('../cloudfunctions/payCallback/index')
  const res = await main(event)
  delete global.__mockDb
  delete global.__mockCtx
  delete global.__mockQueryOrder
  return res
}

const PAID = { returnCode: 'SUCCESS', resultCode: 'SUCCESS', outTradeNo: 'W2608011000-00000001' }
const logId = () => `recharge:${PAID.outTradeNo}`

function fixtures() {
  return {
    // 金额只认下单时本地预写的 amount,不信任回调数值(回调里干脆不带 amount)
    wallet_logs: [{ _id: logId(), openid: 'master-1', type: 'recharge', amount: AMOUNT, status: 'pending', outTradeNo: PAID.outTradeNo, createdAt: new Date() }],
    wallets: [{ _id: 'master-1', balance: 2000 }],
    config: [{ _id: 'app', payMchId: 'mch-test' }]
  }
}

describe('支付成功入账', () => {
  test('pending 认领 + queryOrder 核验通过 + 余额按本地金额累加,应答 errcode 0', async () => {
    const fx = fixtures()
    const r = await pay(PAID, fx)
    expect(r).toEqual({ errcode: 0, errmsg: 'OK' })
    expect(fx.wallet_logs[0].status).toBe('success')
    expect(fx.wallets[0].balance).toBe(2000 + AMOUNT)
  })

  test('重复回调(重放):幂等,不再加钱', async () => {
    const fx = fixtures()
    await pay(PAID, fx)
    await pay(PAID, fx)
    expect(fx.wallets[0].balance).toBe(2000 + AMOUNT)
    expect(fx.wallet_logs).toHaveLength(1)
  })

  test('首充无钱包文档:upsert 建档', async () => {
    const fx = fixtures()
    fx.wallets = []
    await pay(PAID, fx)
    expect(fx.wallets[0]).toMatchObject({ _id: 'master-1', balance: AMOUNT })
  })
})

describe('来源校验:客户端直调拒绝', () => {
  test('带 OPENID 的直调:安静忽略,不认领不入账,流水保持 pending', async () => {
    const fx = fixtures()
    const r = await pay(PAID, fx, { ctx: { OPENID: 'attacker' } })
    expect(r).toEqual({ errcode: 0, errmsg: 'OK' })
    expect(fx.wallet_logs[0].status).toBe('pending')
    expect(fx.wallets[0].balance).toBe(2000)
  })
})

describe('queryOrder 反查:SUCCESS 不看 event 字段', () => {
  test('查单异常(瞬时故障):回滚认领、非 0 应答换微信重推,余额不动', async () => {
    const fx = fixtures()
    const r = await pay(PAID, fx, { queryOrder: () => { throw new Error('api timeout') } })
    expect(r.errcode).toBe(1)
    expect(fx.wallet_logs[0].status).toBe('pending')
    expect(fx.wallets[0].balance).toBe(2000)
  })

  test('微信侧未支付(tradeState NOTPAY):回滚认领,不 credit', async () => {
    const fx = fixtures()
    const r = await pay(PAID, fx, { queryOrder: () => ({ tradeState: 'NOTPAY' }) })
    expect(r.errcode).toBe(0)
    expect(fx.wallet_logs[0].status).toBe('pending')
    expect(fx.wallets[0].balance).toBe(2000)
  })

  test('回传金额与本地预写不符:回滚认领,不 credit', async () => {
    const fx = fixtures()
    const r = await pay(PAID, fx, { queryOrder: () => ({ tradeState: 'SUCCESS', totalFee: 100 }) })
    expect(r.errcode).toBe(0)
    expect(fx.wallet_logs[0].status).toBe('pending')
    expect(fx.wallets[0].balance).toBe(2000)
  })

  test('回传不带金额字段(接口形态差异):仅凭 tradeState 核验,照常入账', async () => {
    const fx = fixtures()
    await pay(PAID, fx, { queryOrder: () => ({ tradeState: 'SUCCESS' }) })
    expect(fx.wallets[0].balance).toBe(2000 + AMOUNT)
  })

  test('config 缺 payMchId(无法反查):回滚认领不入账,流水留待人工核对', async () => {
    const fx = fixtures()
    delete fx.config[0].payMchId
    const r = await pay(PAID, fx)
    expect(r.errcode).toBe(0)
    expect(fx.wallet_logs[0].status).toBe('pending')
    expect(fx.wallets[0].balance).toBe(2000)
  })
})

describe('支付失败/异常', () => {
  test('支付失败(resultCode FAIL):pending 标 failed,不动钱包', async () => {
    const fx = fixtures()
    await pay({ returnCode: 'SUCCESS', resultCode: 'FAIL', outTradeNo: PAID.outTradeNo }, fx)
    expect(fx.wallet_logs[0].status).toBe('failed')
    expect(fx.wallets[0].balance).toBe(2000)
  })

  test('未知单号回调:安静应答 errcode 0(不重试也不崩)', async () => {
    const fx = fixtures()
    const r = await pay({ returnCode: 'SUCCESS', resultCode: 'SUCCESS', outTradeNo: 'W-unknown' }, fx)
    expect(r.errcode).toBe(0)
    expect(fx.wallets[0].balance).toBe(2000)
  })
})
