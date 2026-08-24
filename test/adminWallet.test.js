// admin 钱包管理:walletQuery / walletAdjust(人工入账/退款调平,幂等 + 防超扣)
const { fakeDb } = require('./stubs/fakeDb')

async function callAdmin(event, fx) {
  jest.resetModules()
  global.__mockDb = fakeDb(fx)
  global.__mockCtx = { OPENID: 'admin-1' }
  const { main } = require('../cloudfunctions/admin/index')
  const res = await main(event)
  delete global.__mockDb
  delete global.__mockCtx
  return res
}

function fixtures() {
  return {
    config: [{ _id: 'app', adminOpenids: ['admin-1'] }],
    masters: [{ _id: 'master-1', openid: 'master-1', status: 'approved', serviceCity: '广州市', categories: ['repair'] }],
    wallets: [{ _id: 'master-1', balance: 30000 }],
    wallet_logs: []
  }
}

describe('walletQuery', () => {
  test('返回余额与流水;无钱包视作 0', async () => {
    const fx = fixtures()
    fx.wallet_logs = [{ _id: 'grab:o1', openid: 'master-1', type: 'grab', amount: -2000, createdAt: new Date() }]
    const r = await callAdmin({ action: 'walletQuery', openid: 'master-1' }, fx)
    expect(r.ok).toBe(true)
    expect(r.balance).toBe(30000)
    expect(r.logs).toHaveLength(1)

    const r2 = await callAdmin({ action: 'walletQuery', openid: 'nobody' }, fx)
    expect(r2.ok).toBe(true)
    expect(r2.balance).toBe(0)
  })
})

describe('walletAdjust 调账', () => {
  test('加款(元转分):余额累加并写流水', async () => {
    const fx = fixtures()
    const r = await callAdmin({ action: 'walletAdjust', openid: 'master-1', amountYuan: '50', remark: '微信转账入账', requestId: 'rq-1' }, fx)
    expect(r.ok).toBe(true)
    expect(r.balance).toBe(30000 + 5000)
    expect(fx.wallet_logs[0]).toMatchObject({ _id: 'admin:rq-1', type: 'admin_adjust', amount: 5000, remark: '微信转账入账' })
  })

  test('减款:从余额扣除;余额不足明确拒绝且不留流水', async () => {
    const fx = fixtures()
    const r = await callAdmin({ action: 'walletAdjust', openid: 'master-1', amountYuan: '-20', requestId: 'rq-2' }, fx)
    expect(r.ok).toBe(true)
    expect(r.balance).toBe(30000 - 2000)

    fx.wallet_logs = []
    const r2 = await callAdmin({ action: 'walletAdjust', openid: 'master-1', amountYuan: '-99999', requestId: 'rq-3' }, fx)
    expect(r2.ok).toBe(false)
    expect(r2.msg).toContain('不足')
    expect(fx.wallets[0].balance).toBe(28000)
    expect(fx.wallet_logs).toHaveLength(0)
  })

  test('幂等:同一 requestId 重复提交被拒,余额只动一次', async () => {
    const fx = fixtures()
    const ev = { action: 'walletAdjust', openid: 'master-1', amountYuan: '100', requestId: 'rq-dup' }
    const r1 = await callAdmin(ev, fx)
    const r2 = await callAdmin(ev, fx)
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(false)
    expect(r2.msg).toContain('重复')
    expect(fx.wallets[0].balance).toBe(30000 + 10000)
    expect(fx.wallet_logs).toHaveLength(1)
  })

  test('给没有钱包的师傅加款:首建文档(upsert)', async () => {
    const fx = fixtures()
    const r = await callAdmin({ action: 'walletAdjust', openid: 'master-new', amountYuan: '100', requestId: 'rq-4' }, fx)
    expect(r.ok).toBe(true)
    expect(r.balance).toBe(10000)
    expect(fx.wallets.some(w => w._id === 'master-new' && w.balance === 10000)).toBe(true)
  })

  test.each([
    ['零金额', '0'],
    ['非数字', 'abc'],
    ['超范围', '99999999']
  ])('%s -> 拒绝', async (_label, amountYuan) => {
    const r = await callAdmin({ action: 'walletAdjust', openid: 'master-1', amountYuan, requestId: 'rq-x' }, fixtures())
    expect(r.ok).toBe(false)
  })
})

describe('allMasters 附带钱包余额', () => {
  test('师傅列表 join wallets,没有钱包显示 0', async () => {
    const fx = fixtures()
    fx.masters.push({ _id: 'master-2', openid: 'master-2', status: 'approved', serviceCity: '广州市', categories: ['repair'] })
    const r = await callAdmin({ action: 'allMasters' }, fx)
    expect(r.ok).toBe(true)
    const by = {}
    for (const m of r.data) by[m.openid] = m.walletBalance
    expect(by['master-1']).toBe(30000)
    expect(by['master-2']).toBe(0)
  })
})
