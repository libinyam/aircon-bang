// 静默刷新收尾:pool loadMyActive / index loadActiveOrders 的
// silent 接线(辅助信息失败不弹 toast)与代次保护(并发旧快照不覆盖新快照)
// myListings 的 silent 接线与缓存失效在 listingsCache.test.js(与缓存故事同处)
const FLUSH = () => new Promise(r => setImmediate(r))

function mountPage(relPath, wxStub, getAppImpl) {
  jest.resetModules()
  let cfg
  global.Page = (c) => { cfg = c }
  if (getAppImpl) global.getApp = getAppImpl
  global.wx = wxStub
  require(relPath)
  const inst = Object.create(cfg)
  inst.data = JSON.parse(JSON.stringify(cfg.data))
  inst.setData = function (patch) { Object.assign(this.data, patch) }
  return inst
}

afterEach(() => {
  delete global.Page
  delete global.getApp
  delete global.wx
  jest.restoreAllMocks()
})

describe('pool.loadMyActive:silent 接线+代次保护', () => {
  const ok = (data) => ({ result: { ok: true, data } })

  test('网络失败:静默——不弹 toast、不 setData(修复前进大厅平白弹"网络异常")', async () => {
    const toasts = []
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const page = mountPage('../miniprogram/pages/pool/pool', {
      showToast: (o) => toasts.push(o.title),
      cloud: { callFunction: () => Promise.reject(new Error('timeout')) }
    })
    await page.loadMyActive()
    errSpy.mockRestore()
    expect(toasts).toEqual([])
    expect(page.data.myActive).toEqual([])
  })

  test('成功:myActive 更新;并发时晚到的旧快照被代次拦下', async () => {
    const toasts = []
    const deferred = []
    const page = mountPage('../miniprogram/pages/pool/pool', {
      showToast: (o) => toasts.push(o.title),
      cloud: { callFunction: () => new Promise(r => deferred.push(r)) }
    })
    const p1 = page.loadMyActive()
    const p2 = page.loadMyActive()
    deferred[1](ok([{ _id: 'new' }]))
    await p2
    expect(page.data.myActive).toEqual([{ _id: 'new' }])
    deferred[0](ok([{ _id: 'old' }]))           // 快速切 tab 时乱序晚到的旧快照
    await p1
    expect(page.data.myActive).toEqual([{ _id: 'new' }])
    expect(toasts).toEqual([])
  })
})

describe('index.loadActiveOrders:silent 接线+代次保护', () => {
  const ok = (data) => ({ result: { ok: true, data } })

  function mountIndex(cloudImpl, master, toasts) {
    return mountPage('../miniprogram/pages/index/index', {
      showToast: (o) => toasts.push(o.title),
      cloud: { callFunction: cloudImpl }
    }, () => ({ getUser: async () => ({ master }) }))
  }

  test('认证师傅网络失败:两个列表都静默——不弹 toast,屏上数据保留', async () => {
    const toasts = []
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const page = mountIndex(() => Promise.reject(new Error('timeout')), { status: 'approved' }, toasts)
    page.data.activeOrders = [{ _id: 'keep' }]
    await page.loadActiveOrders()
    errSpy.mockRestore()
    expect(toasts).toEqual([])
    expect(page.data.activeOrders).toEqual([{ _id: 'keep' }])
  })

  test('非师傅:只拉用户列表,masterOrders 清空防角色残留', async () => {
    const toasts = []
    const calls = []
    const page = mountIndex(({ data }) => {
      calls.push(data.action)
      return Promise.resolve(ok([]))
    }, null, toasts)
    await page.loadActiveOrders()
    expect(calls).toEqual(['userList'])
    expect(page.data.masterOrders).toEqual([])
  })

  test('成功:两个列表更新;并发时晚到的旧快照被代次拦下', async () => {
    const toasts = []
    const deferred = []
    const page = mountIndex(() => new Promise(r => deferred.push(r)), { status: 'approved' }, toasts)
    const p1 = page.loadActiveOrders()
    const p2 = page.loadActiveOrders()
    await FLUSH()                                // getUser 微任务结算,两次进页共四个云调用已发出
    deferred[2](ok([{ _id: 'pub-new' }]))       // 第二次进页的响应先到
    deferred[3](ok([{ _id: 'mine-new' }]))
    await p2
    expect(page.data.activeOrders).toEqual([{ _id: 'pub-new' }])
    expect(page.data.masterOrders).toEqual([{ _id: 'mine-new' }])
    deferred[0](ok([{ _id: 'pub-old' }]))       // 第一次的旧快照晚到
    deferred[1](ok([{ _id: 'mine-old' }]))
    await p1
    expect(page.data.activeOrders).toEqual([{ _id: 'pub-new' }])
    expect(page.data.masterOrders).toEqual([{ _id: 'mine-new' }])
    expect(toasts).toEqual([])
  })
})
