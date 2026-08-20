// grantMember 会员开通:requestId 幂等+ 顺延日期计算()+ 金额口径()
const { fakeDb } = require('./stubs/fakeDb')

const NOW = new Date('2026-08-01T12:00:00Z').getTime()
const DAY = 24 * 3600 * 1000

function fixtures(masterOver = {}) {
  return {
    config: [{ _id: 'app', adminOpenids: ['admin-1'] }],
    masters: [Object.assign({ _id: 'M1', openid: 'master-1', status: 'approved', realName: '李师傅', memberExpireAt: null }, masterOver)],
    member_logs: []
  }
}

async function grant(params, fx, openid = 'admin-1') {
  jest.resetModules()
  global.__mockDb = fakeDb(fx)
  global.__mockCtx = { OPENID: openid }
  const { main } = require('../cloudfunctions/admin/index')
  const res = await main(Object.assign({ action: 'grantMember' }, params))
  delete global.__mockDb
  delete global.__mockCtx
  return res
}

beforeAll(() => { jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] }) })
afterAll(() => { jest.useRealTimers() })

describe('权限与参数闸门', () => {
  test('非管理员调用:拒绝', async () => {
    const r = await grant({ masterId: 'M1', months: 3, amount: 100, requestId: 'r1' }, fixtures(), 'not-admin')
    expect(r.ok).toBe(false)
    expect(r.msg).toContain('无管理权限')
  })
  test.each([
    ['月数为0', { masterId: 'M1', months: 0, amount: 100, requestId: 'r1' }, '月数'],
    ['月数超36', { masterId: 'M1', months: 37, amount: 100, requestId: 'r1' }, '月数'],
    ['缺 requestId', { masterId: 'M1', months: 3, amount: 100 }, '请求标识'],
    ['金额空串(区分免费0元)', { masterId: 'M1', months: 3, amount: '', requestId: 'r1' }, '实收金额'],
    ['金额为负', { masterId: 'M1', months: 3, amount: -1, requestId: 'r1' }, '金额不合法']
  ])('%s -> 拒绝', async (_label, params, msgPart) => {
    const r = await grant(params, fixtures())
    expect(r.ok).toBe(false)
    expect(r.msg).toContain(msgPart)
  })
  test('未过审的师傅不能开通', async () => {
    const r = await grant({ masterId: 'M1', months: 3, amount: 100, requestId: 'r1' }, fixtures({ status: 'pending' }))
    expect(r.ok).toBe(false)
    expect(r.msg).toContain('入驻审核')
  })
  test('免费开通 0 元是合法的(与"没填"可区分)', async () => {
    const fx = fixtures()
    const r = await grant({ masterId: 'M1', months: 1, amount: 0, requestId: 'r1' }, fx)
    expect(r.ok).toBe(true)
    expect(fx.member_logs[0].amount).toBe(0)
  })
})

describe('顺延日期计算(1个月=30天口径)', () => {
  test('无会员记录:从现在起 +3×30 天', async () => {
    const fx = fixtures()
    const r = await grant({ masterId: 'M1', months: 3, amount: 300, requestId: 'r1' }, fx)
    expect(r.ok).toBe(true)
    expect(new Date(fx.masters[0].memberExpireAt).getTime()).toBe(NOW + 90 * DAY)
  })
  test('会员未到期:在原到期日基础上顺延(续费不吃亏)', async () => {
    const future = new Date(NOW + 10 * DAY)
    const fx = fixtures({ memberExpireAt: future })
    await grant({ masterId: 'M1', months: 1, amount: 100, requestId: 'r1' }, fx)
    expect(new Date(fx.masters[0].memberExpireAt).getTime()).toBe(NOW + 40 * DAY)
  })
  test('会员已过期:从现在起算,不从过期日起算', async () => {
    const past = new Date(NOW - 100 * DAY)
    const fx = fixtures({ memberExpireAt: past })
    await grant({ masterId: 'M1', months: 1, amount: 100, requestId: 'r1' }, fx)
    expect(new Date(fx.masters[0].memberExpireAt).getTime()).toBe(NOW + 30 * DAY)
  })
})

describe('auditMaster 前置态条件更新', () => {
  async function audit(params, fx) {
    jest.resetModules()
    global.__mockDb = fakeDb(fx)
    global.__mockCtx = { OPENID: 'admin-1' }
    const { main } = require('../cloudfunctions/admin/index')
    const res = await main(Object.assign({ action: 'auditMaster' }, params))
    delete global.__mockDb
    delete global.__mockCtx
    return res
  }

  test('pending 可通过;再审同一人命中 0 行拒绝,状态不被覆盖', async () => {
    const fx = fixtures({ status: 'pending' })
    const r1 = await audit({ masterId: 'M1', pass: true }, fx)
    expect(r1.ok).toBe(true)
    expect(fx.masters[0].status).toBe('approved')

    const r2 = await audit({ masterId: 'M1', pass: false, reason: '重复驳回' }, fx)
    expect(r2.ok).toBe(false)
    expect(r2.msg).toContain('已被处理')
    expect(fx.masters[0].status).toBe('approved') // 不被第二次操作改写
  })

  test('驳回写入原因', async () => {
    const fx = fixtures({ status: 'pending' })
    const r = await audit({ masterId: 'M1', pass: false, reason: '照片模糊' }, fx)
    expect(r.ok).toBe(true)
    expect(fx.masters[0].status).toBe('rejected')
    expect(fx.masters[0].rejectReason).toBe('照片模糊')
  })
})

describe('requestId 幂等(:失败重试不能重复延长会员)', () => {
  test('同一 requestId 第二次提交:拒绝,到期日不再变,日志只有一条', async () => {
    const fx = fixtures()
    const p = { masterId: 'M1', months: 3, amount: 300, requestId: 'same-req' }
    const r1 = await grant(p, fx)
    const afterFirst = new Date(fx.masters[0].memberExpireAt).getTime()
    const r2 = await grant(p, fx)
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(false)
    expect(r2.msg).toContain('重复提交')
    expect(new Date(fx.masters[0].memberExpireAt).getTime()).toBe(afterFirst)
    expect(fx.member_logs).toHaveLength(1)
  })
  test('不同 requestId:正常累计两次', async () => {
    const fx = fixtures()
    await grant({ masterId: 'M1', months: 1, amount: 100, requestId: 'r1' }, fx)
    await grant({ masterId: 'M1', months: 1, amount: 100, requestId: 'r2' }, fx)
    expect(new Date(fx.masters[0].memberExpireAt).getTime()).toBe(NOW + 60 * DAY)
    expect(fx.member_logs).toHaveLength(2)
  })
  test('账务日志记录完整(操作人/新旧到期日/金额)', async () => {
    const fx = fixtures()
    await grant({ masterId: 'M1', months: 2, amount: 200, requestId: 'r1', note: '微信转账' }, fx)
    const log = fx.member_logs[0]
    expect(log._id).toBe('r1')
    expect(log.operator).toBe('admin-1')
    expect(log.oldExpireAt).toBeNull()
    expect(new Date(log.newExpireAt).getTime()).toBe(NOW + 60 * DAY)
    expect(log.amount).toBe(200)
    expect(log.note).toBe('微信转账')
  })
})
