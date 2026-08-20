const config = require('./utils/config')

App({
  globalData: {
    user: null,      // users 集合文档
    master: null,    // masters 集合文档(非师傅为 null)
    isAdmin: false,
    openid: '',
    loginError: false, // 登录云函数失败时为 true,身份页据此展示重试而非"未入驻/非管理员"
    statusBarHeight: 44 // 自定义导航页(首页 hero)占位用,onLaunch 里实测覆盖
  },

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
    return wx.cloud.callFunction({ name: 'login' }).then(res => {
      const { user, master, isAdmin, openid } = res.result
      Object.assign(this.globalData, { user, master, isAdmin, openid, loginError: false })
      return this.globalData
    }).catch(err => {
      console.error('login failed', err)
      this.globalData.loginError = true
      return this.globalData
    })
  },

  // 各页面 onShow 里调用,保证拿到登录态;forceRefresh 用于抢单/入驻后刷新角色
  // 上次登录失败时自动重试,身份页不要把 loginError 状态当成游客
  getUser(forceRefresh) {
    if (forceRefresh || !this.loginReady || this.globalData.loginError) this.loginReady = this.login()
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
