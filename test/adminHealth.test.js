// admin health 运营体检:定时器心跳 + 各类积压计数
const { fakeDb } = require('./stubs/fakeDb')

const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000)

async function health(fx) {
  jest.resetModules()
  global.__mockDb = fakeDb(fx)
  global.__mockCtx = { OPENID: 'admin-1' }
  const { main } = require('../cloudfunctions/admin/index')
  const res = await main({ action: 'health' })
  delete global.__mockDb
  delete global.__mockCtx
  return res
}

const BASE = () => ({
  config: [{ _id: 'app', adminOpenids: ['admin-1'] }],
  cron_logs: [],
  media_checks: [],
  complaints: [],
  deletion_requests: [],
  masters: []
})

describe('admin health', () => {
  test('定时器1小时前跑过:健康,计数正确', async () => {
    const fx = BASE()
    fx.cron_logs = [{ startedAt: hoursAgo(1), closed: 2, autoConfirmed: 1, privacyCleaned: 0, error: '' }]
    fx.media_checks = [
      { status: 'pending', createdAt: hoursAgo(3) },  // 卡住(>2h)
      { status: 'pending', createdAt: hoursAgo(1) },  // 正常等待中
      { status: 'pass', createdAt: hoursAgo(5) }
    ]
    fx.complaints = [{ status: 'open' }, { status: 'closed' }]
    fx.deletion_requests = [{ status: 'open' }]
    fx.masters = [{ status: 'pending' }, { status: 'approved' }]

    const r = await health(fx)
    expect(r.ok).toBe(true)
    expect(r.cron.stale).toBe(false)
    expect(r.cron.closed).toBe(2)
    expect(r.mediaStuck).toBe(1)
    expect(r.openComplaints).toBe(1)
    expect(r.openDeletions).toBe(1)
    expect(r.pendingMasters).toBe(1)
  })

  test('从未运行:标记 stale,提示查触发器', async () => {
    const r = await health(BASE())
    expect(r.cron.stale).toBe(true)
    expect(r.cron.ageHours).toBeNull()
  })

  test('超过2.5小时没跑:标记 stale,并透出上次报错', async () => {
    const fx = BASE()
    fx.cron_logs = [{ startedAt: hoursAgo(5), closed: 0, autoConfirmed: 0, privacyCleaned: 0, error: 'db timeout' }]
    const r = await health(fx)
    expect(r.cron.stale).toBe(true)
    expect(r.cron.error).toBe('db timeout')
  })

  test('非管理员看不到体检数据', async () => {
    jest.resetModules()
    global.__mockDb = fakeDb(BASE())
    global.__mockCtx = { OPENID: 'nobody' }
    const { main } = require('../cloudfunctions/admin/index')
    const r = await main({ action: 'health' })
    delete global.__mockDb
    delete global.__mockCtx
    expect(r.ok).toBe(false)
  })
})
