const config = require('./utils/config')

// 只读 getUser 的登录缓存有效期:角色变化最多滞后这么久自动收敛
const USER_CACHE_MS = 60 * 1000

App({
  globalData: {
    user: null,      // users 集合文档
    master: null,    // masters 集合文档(非师傅为 null)
    isAdmin: false,
    openid: '',
    loginError: false, // 登录云函数失败时为 true,身份页据此展示重试而非"未入驻/非管理员"
    statusBarHeight: 44 // 自定义导航页(首页 hero)占位用,onLaunch 里实测覆盖
  },

  loginAt: 0,        // 上次登录成功时刻,配合 USER_CACHE_MS 判过期

  onLaunch() {
    if (!wx.cloud) {
      console.error('基础库过低,请升级微信开发者工具')
      return
    }
    try {
      const win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
      if (win.statusBarHeight) this.globalData.statusBarHeight = win.statusBarHeight
    } catch (e) { /* 保留默认 44 */ }
    wx.cloud.init({ env: config.CLOUD_ENV, traceUser: true })
    this.loginReady = this.login()
  },

  // 静默登录:云函数拿 openid,upsert 用户;返回 Promise 供页面等待
  login() {
    // 发起即记时:在途的登录不能被 TTL 判过期,否则 onLaunch 那次还没回来就被重复发起
    // (冷启动会多打一次 login,test/appLogin.test.js 会拦)
    this.loginAt = Date.now()
    return wx.cloud.callFunction({ name: 'login' }).then(res => {
      const { user, master, isAdmin, openid } = res.result
      Object.assign(this.globalData, { user, master, isAdmin, openid, loginError: false })
      this.loginAt = Date.now()   // 成功时刻作为 TTL 起点
      return this.globalData
    }).catch(err => {
      console.error('login failed', err)
      this.globalData.loginError = true
      return this.globalData
    })
  },

  // 各页面 onShow 里调用,保证拿到登录态;forceRefresh 用于抢单/入驻后刷新角色
  // 上次登录失败时自动重试,身份页不要把 loginError 状态当成游客
  // 只读调用带 TTL:入驻审核通过/会员开通/资格撤销都是服务端侧变化,
  // 缓存永不过期会让角色永久停在启动时的快照(曾表现为"审核通过了 tab 还是师傅入驻")。
  // 60s 是权衡:比"每次 show 都强刷"省调用,比"永不刷新"能自动收敛
  getUser(forceRefresh) {
    const expired = !this.loginAt || (Date.now() - this.loginAt) > USER_CACHE_MS
    if (forceRefresh || !this.loginReady || this.globalData.loginError || expired) {
      this.loginReady = this.login()
    }
    return this.loginReady
  },

  // 角色统一从云函数返回的师傅档案判断。前端只消费认证结果，不自行授予师傅权限。
  isApprovedMaster() {
    return !!(this.globalData.master && this.globalData.master.status === 'approved')
  },

  getRole() {
    if (this.isApprovedMaster()) return 'master'
    return this.globalData.user ? 'user' : 'guest'
  }
})
