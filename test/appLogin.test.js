// app.js 登录失败/恢复路径:失败不降级为 guest,置 loginError;重试成功恢复角色
describe('app 登录态:失败标记与重试恢复', () => {
  let appInst, callFunctionImpl, loginCalls, errSpy

  function launchApp() {
    jest.resetModules()
    loginCalls = 0
    global.App = (cfg) => { appInst = cfg }
    global.wx = {
      cloud: {
        init: () => {},
        callFunction: (...a) => { loginCalls++; return callFunctionImpl(...a) }
      }
    }
    require('../miniprogram/app')
    appInst.onLaunch()
    return appInst
  }

  const LOGIN_OK = {
    result: { user: { _id: 'u1' }, master: { _id: 'm1', status: 'approved' }, isAdmin: true, openid: 'oX' }
  }

  beforeEach(() => { errSpy = jest.spyOn(console, 'error').mockImplementation(() => {}) })
  afterEach(() => {
    errSpy.mockRestore()
    delete global.App
    delete global.wx
  })

  test('首次登录失败:loginError=true,不产生"游客"业务结论字段', async () => {
    callFunctionImpl = async () => { throw new Error('cloud timeout') }
    const app = launchApp()
    const g = await app.getUser()
    expect(g.loginError).toBe(true)
    // 失败态下 user/master/openid 保持初始空值,页面须按 loginError 分支展示重试,而非"未入驻/非管理员"
    expect(g.user).toBeNull()
    expect(g.openid).toBe('')
  })

  test('失败后重试成功:清除 loginError,恢复角色与 openid', async () => {
    callFunctionImpl = async () => { throw new Error('down') }
    const app = launchApp()
    await app.getUser()

    callFunctionImpl = async () => LOGIN_OK
    const g = await app.getUser() // loginError 态下 getUser 自动重登,无需 forceRefresh
    expect(g.loginError).toBe(false)
    expect(g.openid).toBe('oX')
    expect(g.isAdmin).toBe(true)
    expect(g.master.status).toBe('approved')
  })

  test('连续失败:每次 getUser 都重试,loginError 持续为 true', async () => {
    callFunctionImpl = async () => { throw new Error('still down') }
    const app = launchApp()
    await app.getUser()
    await app.getUser()
    expect(appInst.globalData.loginError).toBe(true)
    // 首次 getUser 复用 onLaunch 在途的登录(彼时 loginError 尚未置位),第二次 getUser 才触发重试
    expect(loginCalls).toBe(2)
  })

  test('登录成功后 getUser 复用缓存,不重复调用云函数', async () => {
    callFunctionImpl = async () => LOGIN_OK
    const app = launchApp()
    await app.getUser()
    await app.getUser()
    expect(loginCalls).toBe(1) // 仅 onLaunch 那次
  })

  test('forceRefresh 强制重登:抢单/入驻后刷新角色', async () => {
    callFunctionImpl = async () => LOGIN_OK
    const app = launchApp()
    await app.getUser()
    callFunctionImpl = async () => ({
      result: { user: { _id: 'u1' }, master: null, isAdmin: false, openid: 'oX' }
    })
    const g = await app.getUser(true)
    expect(loginCalls).toBe(2)
    expect(g.master).toBeNull()
  })
})
