// wallet 云函数:余额/流水查询 + 微信支付充值下单(cloudPay 由 stub 提供)
const { fakeDb } = require('./stubs/fakeDb')

async function callWallet(event, fx, { cloudPay } = {}) {
  jest.resetModules()
  global.__mockDb = fakeDb(fx)
  global.__mockCtx = { OPENID: 'master-1' }
  if (cloudPay !== undefined) global.__mockCloudPay = cloudPay
  const { main } = require('../cloudfunctions/wallet/index')
  const res = await main(event)
  delete global.__mockDb
  delete global.__mockCtx
  delete global.__mockCloudPay
  return res
}

describe('wallet get', () => {
  test('有钱包:返回余额与按时间倒序的流水', async () => {
    const fx = {
      wallets: [{ _id: 'master-1', balance: 30000 }],
      wallet_logs: [
        { _id: 'grab:o1', openid: 'master-1', type: 'grab', amount: -2000, createdAt: new Date('2026-08-02') },
        { _id: 'recharge:W1', openid: 'master-1', type: 'recharge', amount: 50000, status: 'success', createdAt: new Date('2026-08-01') }
      ]
    }
    const r = await callWallet({ action: 'get', page: 0 }, fx)
    expect(r.ok).toBe(true)
    expect(r.balance).toBe(30000)
    expect(r.logs.map(l => l._id)).toEqual(['grab:o1', 'recharge:W1'])
  })

  test('无钱包文档:余额 0 而不是报错(新师傅未充值是常态)', async () => {
    const r = await callWallet({ action: 'get', page: 0 }, { wallets: [], wallet_logs: [] })
    expect(r.ok).toBe(true)
    expect(r.balance).toBe(0)
    expect(r.logs).toEqual([])
  })
})

describe('wallet recharge', () => {
  const cfg = [{ _id: 'app', payMchId: '1900000109' }]

  test.each([
    ['非档位金额', 12345],
    ['零', 0],
    ['负数', -5000]
  ])('%s -> 拒绝', async (_label, amount) => {
    const r = await callWallet({ action: 'recharge', amount }, { config: cfg, wallets: [], wallet_logs: [] })
    expect(r.ok).toBe(false)
    expect(r.msg).toContain('档位')
  })

  test('未配置商户号:明确引导人工充值,不留下任何流水', async () => {
    const fx = { config: [{ _id: 'app' }], wallets: [], wallet_logs: [] }
    const r = await callWallet({ action: 'recharge', amount: 5000 }, fx)
    expect(r.ok).toBe(false)
    expect(r.msg).toContain('人工充值')
    expect(fx.wallet_logs).toHaveLength(0)
  })

  test('下单成功:预写 pending 流水(W 前缀单号),返回 payment 参数', async () => {
    const fx = { config: cfg, wallets: [], wallet_logs: [] }
    const r = await callWallet({ action: 'recharge', amount: 5000 }, fx)
    expect(r.ok).toBe(true)
    expect(r.outTradeNo).toMatch(/^W\d{10}-\d{8}$/)
    expect(r.payment.paySign).toBeDefined()   // 前端 wx.requestPayment 直接用
    expect(fx.wallet_logs).toHaveLength(1)
    expect(fx.wallet_logs[0]).toMatchObject({
      openid: 'master-1', type: 'recharge', amount: 5000, status: 'pending'
    })
  })

  test('统一下单抛错:流水标 failed,不留悬念的 pending', async () => {
    const fx = { config: cfg, wallets: [], wallet_logs: [] }
    const r = await callWallet({ action: 'recharge', amount: 5000 }, fx, { cloudPay: async () => { throw new Error('mch not bound') } })
    expect(r.ok).toBe(false)
    expect(r.msg).toContain('支付失败')
    expect(fx.wallet_logs).toHaveLength(1)
    expect(fx.wallet_logs[0].status).toBe('failed')
  })
})
