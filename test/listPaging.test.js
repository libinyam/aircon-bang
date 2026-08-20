// orders 列表页请求锁与代次控制:连续触底只发一个请求;乱序旧响应不覆盖新列表
// 页面桩:捕获 Page(config),手工构造实例;callFn 底层的 wx.cloud.callFunction 用可控 deferred
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
