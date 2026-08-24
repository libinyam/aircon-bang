// 「我的上架」预取缓存:进「我的」tab 后台拉 mine 列表,管理页 onLoad
// 先渲染缓存再静默刷新——缓存新鲜期、静默失败、mine 页挂钩三件事在这里守护
const FLUSH = () => new Promise(r => setImmediate(r))

const okMine = (rows, hasMore) => ({
  result: { ok: true, data: rows, hasMore }
})
const ROW = {
  _id: 'l1', status: 'on_sale', condition: 'used', usedGrade: 'g9',
  unitType: 'wall', hp: 'hp1', priceYuan: 500
}

function stubWx(impl, toasts) {
  global.wx = {
    showToast: (o) => toasts.push(o.title),
    cloud: { callFunction: impl }
  }
}

function freshCache() {
  jest.resetModules()
  return require('../miniprogram/utils/listingsCache')
}

afterEach(() => {
  delete global.wx
  jest.restoreAllMocks()
})

describe('prefetchMine:拉取并缓存映射行', () => {
  test('成功后 peekMine 返回渲染视图模型 + noMore', async () => {
    const toasts = []
    stubWx(() => Promise.resolve(okMine([ROW], false)), toasts)
    const cache = freshCache()

    await expect(cache.prefetchMine()).resolves.toBe(true)
    const c = cache.peekMine()
    expect(c.noMore).toBe(true)
    expect(c.rows[0].statusLabel).toBe('在售')
    expect(c.rows[0].condText).toBe('9成新')
    expect(c.rows[0].specText).toBe('挂机 · 1匹')
    expect(c.rows[0].canOffShelf).toBe(true)
    expect(c.rows[0].canDelete).toBe(false)
  })

  test('新鲜期内重复预取直接跳过,不重复打云函数', async () => {
    const calls = []
    stubWx(({ name, data }) => {
      calls.push({ name, data })
      return Promise.resolve(okMine([ROW], false))
    }, [])
    const cache = freshCache()

    await cache.prefetchMine()
    await cache.prefetchMine()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ name: 'getListings', data: { action: 'mine', page: 0 } })
  })

  test('网络失败静默:不弹 toast,peekMine 仍为 null', async () => {
    const toasts = []
    stubWx(() => Promise.reject(new Error('timeout')), toasts)
    const cache = freshCache()

    await expect(cache.prefetchMine()).resolves.toBe(false)
    expect(toasts).toEqual([])
    expect(cache.peekMine()).toBeNull()
  })

  test('缓存过期后 peekMine 返回 null,回到正常 loading 流程', async () => {
    stubWx(() => Promise.resolve(okMine([ROW], false)), [])
    const cache = freshCache()
    await cache.prefetchMine()
    expect(cache.peekMine()).not.toBeNull()

    const now = Date.now()
    jest.spyOn(Date, 'now').mockReturnValue(now + 6 * 60 * 1000) // 越过 5 分钟新鲜期
    expect(cache.peekMine()).toBeNull()
  })
})

describe('mine 页挂钩:有师傅档案才预取', () => {
  function mountMine(master, calls) {
    jest.resetModules()
    let cfg
    global.Page = (c) => { cfg = c }
    global.getApp = () => ({
      getUser: async () => ({ user: { contactName: '张三' }, master, isAdmin: false })
    })
    stubWx(({ name, data }) => {
      calls.push({ name, data })
      return Promise.resolve(okMine([ROW], false))
    }, [])
    require('../miniprogram/pages/mine/mine')
    const inst = Object.create(cfg)
    inst.data = JSON.parse(JSON.stringify(cfg.data))
    inst.setData = function (patch) { Object.assign(this.data, patch) }
    return inst
  }

  afterEach(() => { delete global.Page; delete global.getApp })

  test('有师傅档案(哪怕 pending):onShow 触发一次 getListings mine', async () => {
    const calls = []
    const page = mountMine({ status: 'pending' }, calls)
    await page.onShow()
    await FLUSH()
    expect(calls.some(c => c.name === 'getListings' && c.data.action === 'mine')).toBe(true)
  })

  test('普通用户(无师傅档案)不预取:没有 getListings 调用', async () => {
    const calls = []
    const page = mountMine(null, calls)
    await page.onShow()
    await FLUSH()
    expect(calls).toEqual([])
  })
})
