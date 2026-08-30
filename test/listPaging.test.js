// orders 列表页请求锁与代次控制:连续触底只发一个请求;乱序旧响应不覆盖新列表
// 页面桩:捕获 Page(config),手工构造实例;callFn 底层的 wx.cloud.callFunction 用可控 deferred
const { fakeDb } = require('./stubs/fakeDb')
function deferred() {
  let resolve, reject
  const p = new Promise((res, rej) => { resolve = res; reject = rej })
  return { p, resolve, reject }
}
const flush = () => new Promise(r => setImmediate(r))

function mountOrdersPage(calls) {
  jest.resetModules()
  let cfg
  global.Page = (c) => { cfg = c }
  global.getApp = () => ({ getUser: async () => ({}) })
  global.wx = {
    setNavigationBarTitle() {},
    showToast() {},
    cloud: {
      callFunction({ name, data }) {
        const d = deferred()
        calls.push({ name, data, d })
        return d.p
      }
    }
  }
  require('../miniprogram/pages/orders/orders')
  const inst = Object.create(cfg)
  inst.data = JSON.parse(JSON.stringify(cfg.data))
  inst.setData = function (patch) { Object.assign(this.data, patch) }
  return inst
}

afterEach(() => { delete global.Page; delete global.getApp; delete global.wx })

const ok = (data, hasMore) => ({ result: { ok: true, data, hasMore } })

describe('请求锁:分页在途时触底不重复发请求', () => {
  test('连续触底 3 次只有 1 个在途请求', async () => {
    const calls = []
    const page = mountOrdersPage(calls)
    page.onLoad({})

    page.loadPage(0)
    await flush()
    expect(calls).toHaveLength(1)

    page.onReachBottom()
    page.onReachBottom()
    page.onReachBottom()
    await flush()
    expect(calls).toHaveLength(1) // 锁生效,没有新请求

    calls[0].d.resolve(ok([{ _id: 'a', publishedAt: new Date() }], true))
    await flush()
    expect(page.data.orders.map(o => o._id)).toEqual(['a'])

    page.onReachBottom() // 解锁后触底才发第二页
    await flush()
    expect(calls).toHaveLength(2)
    expect(calls[1].data.page).toBe(1)
  })
})

describe('代次控制:刷新后晚到的旧分页响应被丢弃', () => {
  test('分页请求未返回时刷新,旧响应最后到达也不能覆盖第一页', async () => {
    const calls = []
    const page = mountOrdersPage(calls)
    page.onLoad({})

    // 第一页加载完成:A、B
    page.loadPage(0)
    await flush()
    calls[0].d.resolve(ok([{ _id: 'A', publishedAt: new Date() }, { _id: 'B', publishedAt: new Date() }], true))
    await flush()

    // 触底翻页(在途)→ 立刻下拉刷新
    page.onReachBottom()
    await flush()
    expect(calls).toHaveLength(2)
    page.reload()
    await flush()
    expect(calls).toHaveLength(3)

    // 刷新先返回:只剩 C(比如 A/B 已被接走)
    calls[2].d.resolve(ok([{ _id: 'C', publishedAt: new Date() }], false))
    await flush()
    expect(page.data.orders.map(o => o._id)).toEqual(['C'])
    expect(page.data.noMore).toBe(true)

    // 旧的第二页姗姗来迟:必须被丢弃,不能把 D 拼进新列表
    calls[1].d.resolve(ok([{ _id: 'D', publishedAt: new Date() }], true))
    await flush()
    expect(page.data.orders.map(o => o._id)).toEqual(['C'])
    expect(page.data.page).toBe(0)
    expect(page.data.noMore).toBe(true)
  })

  test('刷新失败不覆盖已有列表,只标错误态', async () => {
    const calls = []
    const page = mountOrdersPage(calls)
    page.onLoad({})
    page.loadPage(0)
    await flush()
    calls[0].d.resolve(ok([{ _id: 'A', publishedAt: new Date() }], false))
    await flush()

    page.reload()
    await flush()
    calls[1].d.reject(new Error('network down'))
    await flush()
    expect(page.data.orders.map(o => o._id)).toEqual(['A'])
    expect(page.data.loadError).toBe(true)
  })
})

// 后端分页契约(fakeDb 查询语义修复后首次可测):
// 真实 orderBy/skip/limit 生效,断言 userList/pool 的翻页窗口、倒序方向与 hasMore 边界
async function callGetOrders(event, openid, fx) {
  jest.resetModules()
  global.__mockDb = fakeDb(fx)
  global.__mockCtx = { OPENID: openid }
  const { main } = require('../cloudfunctions/getOrders/index')
  const res = await main(event)
  delete global.__mockDb
  delete global.__mockCtx
  return res
}

describe('后端分页:userList 窗口与 hasMore', () => {
  const fx25 = () => ({
    orders: Array.from({ length: 25 }, (_, i) => ({
      _id: 'o' + String(i).padStart(2, '0'),
      userOpenid: 'u1',
      status: 'published',                    // activeOnly 用例按 ACTIVE_STATUSES 过滤
      publishedAt: new Date(Date.UTC(2026, 7, 1) + i * 60000)   // 递增:o00 最旧,o24 最新
    })),
    masters: []
  })

  test('第0页:最新 20 条倒序,hasMore true;第1页:余下 5 条,hasMore false', async () => {
    const p0 = await callGetOrders({ action: 'userList', page: 0 }, 'u1', fx25())
    expect(p0.ok).toBe(true)
    expect(p0.data).toHaveLength(20)
    expect(p0.hasMore).toBe(true)
    expect(p0.data[0]._id).toBe('o24')       // 倒序:最新在前
    expect(p0.data[19]._id).toBe('o05')

    const p1 = await callGetOrders({ action: 'userList', page: 1 }, 'u1', fx25())
    expect(p1.data).toHaveLength(5)
    expect(p1.hasMore).toBe(false)
    expect(p1.data[0]._id).toBe('o04')
    expect(p1.data[4]._id).toBe('o00')
  })

  test('activeOnly 走 limit 3(首页进行中订单条数),hasMore 恒 false', async () => {
    const r = await callGetOrders({ action: 'userList', page: 0, activeOnly: true }, 'u1', fx25())
    expect(r.ok).toBe(true)
    expect(r.data).toHaveLength(3)
    expect(r.data[0]._id).toBe('o24')        // 首页条数内也要最新的
    expect(r.hasMore).toBe(false)
  })
})

describe('后端分页:pool 窗口与 hasMore', () => {
  const master = () => ({
    _id: 'm1', openid: 'master-1', status: 'approved', cityKey: '广州',
    serviceCity: '广州市', categories: ['repair'],
    memberExpireAt: new Date(Date.now() + 24 * 3600 * 1000)
  })
  const fxN = (n) => ({
    masters: [master()],
    orders: Array.from({ length: n }, (_, i) => ({
      _id: 'p' + String(i).padStart(2, '0'),
      status: 'published', cityKey: '广州', userOpenid: 'someone',
      category: 'repair',
      publishedAt: new Date(Date.now() - i * 60000),   // 全部在 48h 内
      expectEnd: new Date(Date.now() + 3600 * 1000)
    }))
  })

  test('22 条在售:第0页 20 条 hasMore true,第1页 2 条 hasMore false,翻页不重不漏', async () => {
    const p0 = await callGetOrders({ action: 'pool', page: 0 }, 'master-1', fxN(22))
    expect(p0.ok).toBe(true)
    expect(p0.data).toHaveLength(20)
    expect(p0.hasMore).toBe(true)
    expect(p0.data[0]._id).toBe('p00')       // publishedAt 倒序:最新发布的在前

    const p1 = await callGetOrders({ action: 'pool', page: 1 }, 'master-1', fxN(22))
    expect(p1.data).toHaveLength(2)
    expect(p1.hasMore).toBe(false)
    expect(new Set([...p0.data, ...p1.data].map(o => o._id)).size).toBe(22)
  })

  test('恰满一页(20 条):hasMore true 是既定契约(前端多翻一页收尾),第1页为空', async () => {
    const p0 = await callGetOrders({ action: 'pool', page: 0 }, 'master-1', fxN(20))
    expect(p0.data).toHaveLength(20)
    expect(p0.hasMore).toBe(true)
    const p1 = await callGetOrders({ action: 'pool', page: 1 }, 'master-1', fxN(20))
    expect(p1.data).toHaveLength(0)
    expect(p1.hasMore).toBe(false)
  })
})
