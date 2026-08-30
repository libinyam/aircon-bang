// 角色同步守护
// 真实故障:师傅通过入驻审核后,底部 tabBar 仍显示「师傅入驻」,点它还被 navigateTo 回
// 入驻申请页(空白表单)。根因是登录结果无限期缓存 + 点击拦截吃同一份旧数据。
// 2026-08 调整:点击不再拦截(旧版在 tabBar 里 await 强刷,login 往返期间点击零反馈,
// 体感"点了没反应"),身份收敛移到 pool.refresh 的后台强刷。本文件钉死新契约:
//   1) tabBar 点任何 tab 都即时切换,零云调用、不 navigateTo
//   2) pool 先用缓存上屏,缓存说不是认证师傅时后台强刷,角色有变才翻转
//   3) 只读缓存有 TTL;已有档案不再看到空白申请表
const path = require('path')

const MP = path.join(__dirname, '..', 'miniprogram')

// 装载小程序模块:桩掉 Component/Page/getApp/wx 后 require,拿到配置对象当实例用
// 必须用 jest.resetModules():jest 有自己的模块注册表,删 require.cache 不生效,
// 第二次 require 会命中缓存而不再调用 Component/Page,拿到的就是 null
function loadDefinition(file, globalName) {
  let captured = null
  global[globalName] = cfg => { captured = cfg }
  jest.resetModules()
  require(file)
  return captured
}

function instantiate(cfg, methodsUnderKey) {
  const inst = {
    data: JSON.parse(JSON.stringify(cfg.data || {})),
    setData(patch) { Object.assign(this.data, patch) }
  }
  Object.assign(inst, methodsUnderKey ? cfg[methodsUnderKey] : cfg)
  inst.data = inst.data || {}
  return inst
}

describe('custom-tab-bar 乐观切换:点任何 tab 都不被云调用阻塞', () => {
  function setup({ approvedCached = false } = {}) {
    const calls = { getUser: [], switchTab: [], navigateTo: [] }
    global.getApp = () => ({
      getUser(force) {
        calls.getUser.push(!!force)
        return Promise.resolve({ master: { status: approvedCached ? 'approved' : 'pending' } })
      }
    })
    global.wx = {
      switchTab: o => calls.switchTab.push(o.url),
      navigateTo: o => calls.navigateTo.push(o.url)
    }
    const cfg = loadDefinition(path.join(MP, 'custom-tab-bar', 'index.js'), 'Component')
    const inst = instantiate(cfg, 'methods')
    inst.data.isApprovedMaster = approvedCached
    return { inst, calls, cfg }
  }

  const tapPool = { currentTarget: { dataset: { index: 3, path: '/pages/pool/pool' } } }
  // 中间凸起发单钮(v4.1):假 tab 项,点击 navigateTo 直达发单页
  const tapPublish = { currentTarget: { dataset: { index: 2, path: '/pages/publish/publish', action: true } } }

  test('中间凸起发单钮:navigateTo 直达发单页,零云调用', async () => {
    const { inst, calls } = setup()
    await inst.switchTab(tapPublish)
    expect(calls.navigateTo).toEqual(['/pages/publish/publish'])
    expect(calls.switchTab).toEqual([])
    expect(calls.getUser).toEqual([])
  })

  test('非认证师傅点接单入口:零云调用即时切换,由 pool 页内收敛角色(不再挡回申请页)', async () => {
    const { inst, calls } = setup({ approvedCached: false })
    await inst.switchTab(tapPool)
    expect(calls.getUser).toEqual([])                       // 点击期不再强刷
    expect(calls.switchTab).toEqual(['/pages/pool/pool'])   // 即时导航
    expect(calls.navigateTo).toEqual([])                    // 不再 navigateTo 到入驻申请页
  })

  test('已是认证师傅点接单入口:同样直切,无额外请求', async () => {
    const { inst, calls } = setup({ approvedCached: true })
    await inst.switchTab(tapPool)
    expect(calls.getUser).toEqual([])
    expect(calls.switchTab).toEqual(['/pages/pool/pool'])
  })

  test('切其他 tab 不触发强刷(否则每次切 tab 都打一次 login)', async () => {
    const { inst, calls } = setup()
    await inst.switchTab({ currentTarget: { dataset: { index: 1, path: '/pages/market/market' } } })
    expect(calls.getUser).toEqual([])
    expect(calls.switchTab).toEqual(['/pages/market/market'])
  })

  test('例行 show() 的同步走缓存,不强制刷新', async () => {
    const { inst, calls } = setup({ approvedCached: true })
    await inst.syncRole()
    expect(calls.getUser).toEqual([false])
    expect(inst.data.list[3].text).toBe('接单大厅')
  })

  test('roleEntry 标记只作用于接单入口,其他 tab 文案不被改写', async () => {
    const { inst } = setup({ approvedCached: true })
    await inst.syncRole()
    expect(inst.data.list.map(i => i.text)).toEqual(['首页', '买空调', '发单', '接单大厅', '我的'])
  })
})

describe('pool.refresh 的角色收敛(强刷职责从 tabBar 移到页内)', () => {
  function deferred() {
    let resolve, reject
    const p = new Promise((res, rej) => { resolve = res; reject = rej })
    return { p, resolve, reject }
  }
  const flush = () => new Promise(r => setImmediate(r))

  function mountPool({ cached, fresh }) {
    jest.resetModules()
    let cfg
    const getUserCalls = []
    global.Page = (c) => { cfg = c }
    global.getApp = () => ({
      getUser(force) {
        getUserCalls.push(!!force)
        return Promise.resolve(force ? fresh : cached)
      }
    })
    const cloudCalls = []
    global.wx = {
      showToast() {},
      showModal() {},
      makePhoneCall() {},
      getStorageSync: () => '',
      setStorageSync() {},
      getLocation: jest.fn(() => { const d = deferred(); locDeferreds.push(d); return d.p }),
      cloud: {
        callFunction({ name, data }) {
          const d = deferred()
          cloudCalls.push({ name, data, d })
          return d.p
        }
      }
    }
    const locDeferreds = []
    const tabBar = { syncRole: jest.fn(), setData() {} }
    require(path.join(MP, 'pages', 'pool', 'pool.js'))
    const inst = Object.create(cfg)
    inst.data = JSON.parse(JSON.stringify(cfg.data))
    inst.setData = function (patch) { Object.assign(this.data, patch) }
    inst.getTabBar = () => tabBar
    return { inst, getUserCalls, cloudCalls, locDeferreds, tabBar }
  }

  const masterDoc = (status) => ({ status, categories: ['repair'] })
  const okPool = (data) => ({ result: { ok: true, data, hasMore: false, walletBalance: 5000, serviceCity: '青岛市' } })

  test('缓存即认证:直接进大厅并行发 masterList+pool,无强刷(不再每次进页都打 login)', async () => {
    const { inst, getUserCalls, cloudCalls } = mountPool({ cached: { master: masterDoc('approved') } })
    inst.refresh()   // 不 await:列表请求在途挂起,这里只断言"发起行为"
    await flush()
    expect(inst.data.state).toBe('approved')
    expect(getUserCalls).toEqual([false])
    // masterList=大厅顶部"我接的单"区块;与订单池并行,谁也不等谁
    expect(cloudCalls.map(c => c.data.action)).toEqual(['masterList', 'pool'])
  })

  test('缓存 pending + 强刷已通过:翻转 approved、发列表、tabBar 文案同步纠正', async () => {
    const { inst, getUserCalls, cloudCalls, tabBar } = mountPool({
      cached: { master: masterDoc('pending') },
      fresh: { master: masterDoc('approved') }
    })
    await inst.refresh()
    expect(getUserCalls).toEqual([false, true])      // 后台强刷恰一次
    expect(inst.data.state).toBe('approved')          // 旧版此时被挡在申请页,现在直接收敛
    expect(cloudCalls.map(c => c.data.action)).toEqual(['masterList', 'pool'])
    expect(tabBar.syncRole).toHaveBeenCalled()
  })

  test('缓存 guest + 强刷仍 guest:停在入驻引导态,零列表请求', async () => {
    const { inst, getUserCalls, cloudCalls } = mountPool({
      cached: { master: null },
      fresh: { master: null }
    })
    await inst.refresh()
    expect(inst.data.state).toBe('guest')
    expect(getUserCalls).toEqual([false, true])
    expect(cloudCalls).toEqual([])
  })

  test('缓存 loginError + 强刷成功且本就是师傅:从错误态翻转 approved(不能卡在错误态)', async () => {
    const { inst } = mountPool({
      cached: { loginError: true, master: masterDoc('approved') },
      fresh: { master: masterDoc('approved') }
    })
    await inst.refresh()
    expect(inst.data.state).toBe('approved')
  })

  test('定位与列表并行:列表不等定位上屏,定位晚到补算距离;拒绝过则本会话不再重试', async () => {
    const { inst, cloudCalls, locDeferreds } = mountPool({ cached: { master: masterDoc('approved') } })
    inst.refresh()   // 不 await:loadPool 挂在列表请求上
    await flush()
    expect(locDeferreds).toHaveLength(1)              // 定位已发起
    expect(cloudCalls).toHaveLength(2)               // masterList+pool 都不等它

    // 列表先回:无定位也能上屏,距离为 0(masterList 在途不挡订单池渲染)
    const poolCall = cloudCalls.find(c => c.data.action === 'pool')
    poolCall.d.resolve(okPool([{ _id: 'a', location: { coordinates: [120.38, 36.07] }, publishedAt: new Date(), expectSlot: 'am', expectDate: '2099-01-01' }]))
    await flush()
    expect(inst.data.orders[0].distanceNum).toBe(0)
    expect(inst.data.state).toBe('approved')

    // 定位后到:距离补算出来
    locDeferreds[0].resolve({ latitude: 36.06, longitude: 120.39 })
    await flush()
    expect(inst.data.myLocation).toBeTruthy()
    expect(inst.data.orders[0].distanceNum).toBeGreaterThan(0)
    expect(inst.data.orders[0].near).toBe(true)

    // 拒绝定位的场景:失败后再次 loadPool 不再发起 getLocation(旧版每次进页重弹)
    const { inst: i2, locDeferreds: ld2 } = mountPool({ cached: { master: masterDoc('approved') } })
    i2.refresh()
    await flush()
    ld2[0].reject(new Error('deny'))
    await flush()
    expect(i2._locDenied).toBe(true)
    i2.loadPool(0)
    await flush()
    expect(ld2).toHaveLength(1)                       // 会话内没有第二次定位
  })
})

describe('app.getUser 的登录缓存 TTL', () => {
  function setup() {
    const calls = { login: 0 }
    let failNext = false
    global.wx = {
      cloud: {
        init() {},
        callFunction() {
          calls.login++
          if (failNext) { failNext = false; return Promise.reject(new Error('network')) }
          return Promise.resolve({ result: { user: {}, master: { status: 'pending' }, isAdmin: false, openid: 'o_test' } })
        }
      },
      getWindowInfo: () => ({ statusBarHeight: 44 })
    }
    const app = loadDefinition(path.join(MP, 'app.js'), 'App')
    return { app, calls, failLoginOnce: () => { failNext = true } }
  }

  test('TTL 内复用缓存,超过 TTL 自动重新登录(角色变化最多滞后一分钟)', async () => {
    const { app, calls } = setup()
    const realNow = Date.now
    let t = 1e12
    Date.now = () => t
    try {
      await app.getUser()
      expect(calls.login).toBe(1)          // 首次必然登录
      await app.getUser()
      expect(calls.login).toBe(1)          // 立即再问:走缓存
      t += 59 * 1000
      await app.getUser()
      expect(calls.login).toBe(1)          // 59s:仍在有效期内
      t += 2 * 1000
      await app.getUser()
      expect(calls.login).toBe(2)          // 61s:过期,自动重登
    } finally { Date.now = realNow }
  })

  test('forceRefresh 无视缓存新旧,总是重新登录(抢单/入驻后用)', async () => {
    const { app, calls } = setup()
    await app.getUser()
    expect(calls.login).toBe(1)
    await app.getUser(true)
    expect(calls.login).toBe(2)
  })

  test('上次登录失败时下次调用立即重试,TTL 不得掩盖失败态', async () => {
    const { app, calls, failLoginOnce } = setup()
    failLoginOnce()
    const g = await app.getUser()
    expect(g.loginError).toBe(true)
    expect(calls.login).toBe(1)
    await app.getUser()                    // 不等 TTL 到期就该重试
    expect(calls.login).toBe(2)
    expect(app.globalData.loginError).toBe(false)
  })
})

describe('masterApply 的身份分支', () => {
  function setup(masterStatus) {
    const calls = { switchTab: [], navigateTo: [] }
    global.getApp = () => ({
      globalData: { openid: 'o_test' },
      getUser: () => Promise.resolve({ master: masterStatus ? { status: masterStatus, categories: [], rejectReason: '' } : null })
    })
    global.wx = {
      switchTab: o => calls.switchTab.push(o.url),
      navigateTo: o => calls.navigateTo.push(o.url),
      navigateBack() {}, showModal() {}, showToast() {}, setNavigationBarTitle() {}
    }
    const cfg = loadDefinition(path.join(MP, 'pages', 'masterApply', 'masterApply.js'), 'Page')
    return { inst: instantiate(cfg), calls }
  }

  test('审核通过的师傅进到申请页:转接单大厅,不展示空白表单', async () => {
    const { inst, calls } = setup('approved')
    await inst.onLoad()
    expect(calls.switchTab).toEqual(['/pages/pool/pool'])
  })

  test('审核中的师傅进到申请页:转 pool 的「审核中」态', async () => {
    const { inst, calls } = setup('pending')
    await inst.onLoad()
    expect(calls.switchTab).toEqual(['/pages/pool/pool'])
  })

  test('无档案的新用户:留在申请页正常填表', async () => {
    const { inst, calls } = setup(null)
    await inst.onLoad()
    expect(calls.switchTab).toEqual([])
  })

  test('被驳回的师傅:留在申请页并回填旧资料', async () => {
    const { inst, calls } = setup('rejected')
    await inst.onLoad()
    expect(calls.switchTab).toEqual([])
  })
})
