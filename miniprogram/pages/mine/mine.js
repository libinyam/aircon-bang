const { callFn, imageExt, formatFee } = require('../../utils/util')
const { categoryShort } = require('../../utils/constants')
const listingsCache = require('../../utils/listingsCache')
const config = require('../../utils/config')

Page({
  data: {
    user: {},
    master: null,
    isAdmin: false,
    loginError: false,
      avatarUrl: '',
      balanceText: '--',   // 钱包余额(拉不到显示 --,不影响其他信息)
      avgStars: '',
      isApprovedMaster: false,
      roleTitle: '服务用户',
      roleDescription: '发布需求,让师傅上门服务',
      roleAction: '申请师傅入驻'
  },

  async onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      // 中间位给了凸起发单钮(v4.1),我的顺移到 4
      this.getTabBar().setData({ selected: 4 })
    }
    const g = await getApp().getUser(true)
    // 登录失败:显示重试,不展示"微信用户/非师傅/无管理入口"等错误结论
    if (g.loginError) return this.setData({ loginError: true })
    const m = g.master
    this.setData({
      loginError: false,
      user: g.user || {},
      master: m,
      isAdmin: g.isAdmin,
      // 入驻填的名字审核通过才作为展示名:审核前它只是未经核验的自称
      avatarText: (m && m.status === 'approved') ? (m.realName || '师')[0] : ((g.user && g.user.contactName) || '客')[0],
      catText: m ? (m.categories || []).map(categoryShort).join(' / ') : '',
      avgStars: m && m.stats && m.stats.reviewCount
        ? (m.stats.totalStars / m.stats.reviewCount).toFixed(1) : '',
      isApprovedMaster: !!(m && m.status === 'approved'),
      roleTitle: m && m.status === 'approved' ? '认证维修师傅' : '服务用户',
      roleDescription: m && m.status === 'approved' ? '已认证,可以接单、看今日安排' : '发布需求,让师傅上门服务',
      roleAction: m && m.status === 'approved' ? '进入接单大厅' : '申请师傅入驻'
    })
    this.refreshAvatar(m)
    this.loadBalance(m)
    // 有师傅档案才有「我的上架」入口:顺手后台预取列表(静默失败),
    // 等用户点进去时缓存首屏已就绪,不用等 getListings 往返
    if (m) listingsCache.prefetchMine()
  },

  // 师傅钱包余额(接单费从钱包扣):拉不到只显示 --,不打扰其他信息
  async loadBalance(m) {
    if (!(m && m.status === 'approved')) return
    try {
      const res = await callFn('wallet', { action: 'get', page: 0 })
      this.setData({ balanceText: formatFee(res.balance) })
    } catch (e) { /* 已提示,余额保持 -- */ }
  },

  goWallet() { wx.navigateTo({ url: '/pages/wallet/wallet' }) },

  retryLogin() { this.onShow() },
  nav(e) { wx.navigateTo({ url: e.currentTarget.dataset.url }) },

  // 展示头像换链:本人是自己文件的创建者,"仅创建者可读写"下可直接读;
  // 不经云函数换链也不泄露给他人(fileID 只在本人登录态里)
  async refreshAvatar(m) {
    if (!(m && m.status === 'approved' && m.avatarPhoto)) {
      if (this.data.avatarUrl) this.setData({ avatarUrl: '' })
      return
    }
    try {
      const r = await wx.cloud.getTempFileURL({ fileList: [m.avatarPhoto] })
      const url = r.fileList && r.fileList[0] && r.fileList[0].tempFileURL
      this.setData({ avatarUrl: url || '' })
    } catch (e) { /* 换链失败保持文字头像 */ }
  },

  // 展示头像(选填):认证师傅点头像补传/更换,公开展示在商品卖家卡;
  // 流程与 publishListing 同口径:上传带 openid 命名空间 → 孤儿登记 → 云函数写档
  async changeAvatar() {
    if (!this.data.isApprovedMaster || this._avatarUploading) return
    const sel = await wx.chooseMedia({ count: 1, mediaType: ['image'], sizeType: ['compressed'] })
      .catch(err => {
        // 与 masterApply onPickFail 同约定:用户主动取消不提示,权限被拒给指引
        if (!/cancel/i.test((err && err.errMsg) || '')) {
          wx.showToast({ title: '无法打开相册/相机,请检查小程序权限设置', icon: 'none' })
        }
        return null
      })
    if (!sel || !sel.tempFiles || !sel.tempFiles.length) return
    this._avatarUploading = true
    wx.showLoading({ title: '上传中…', mask: true })
    try {
      const openid = getApp().globalData.openid
      if (!openid) throw new Error('未登录')
      const file = sel.tempFiles[0].tempFilePath
      // uploadFile 不经 callFn 不自动弹错:失败必须补提示,否则 loading 消失后用户以为没反应
      let up
      try {
        up = await wx.cloud.uploadFile({
          cloudPath: `avatars/${openid}/${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${imageExt(file)}`,
          filePath: file
        })
      } catch (e) {
        wx.showToast({ title: '头像上传失败,请检查网络后重试', icon: 'none' })
        throw e
      }
      // 上传登记尽力而为,失败不阻断
      wx.cloud.callFunction({ name: 'registerUpload', data: { scene: 'avatar', fileIDs: [up.fileID] } }).catch(() => {})
      const res = await callFn('applyMaster', { action: 'updateAvatar', avatarPhoto: up.fileID })
      wx.showToast({ title: '头像已更新', icon: 'success' })
      const g = await getApp().getUser(true)
      this.setData({ master: g.master, avatarUrl: res.avatarUrl || '' })
    } catch (e) { /* callFn 已弹错误提示 */ } finally {
      wx.hideLoading()
      this._avatarUploading = false
    }
  },
  switchToPool() { this.goRoleWorkspace() },
  goRoleWorkspace() {
    if (getApp().isApprovedMaster()) {
      wx.switchTab({ url: '/pages/pool/pool' })
      return
    }
    wx.navigateTo({ url: '/pages/masterApply/masterApply' })
  },
  callService() { wx.makePhoneCall({ phoneNumber: config.SERVICE_PHONE }) },
  // 封面必须显式给:留空则截当前页面,而本页顶部是头像+真名+评分+接单数
  onShareAppMessage() {
    return {
      title: config.SHARE.home.title,
      path: config.SHARE.home.path,
      imageUrl: config.SHARE_COVER
    }
  },

  copyOpenid() {
    const openid = getApp().globalData.openid
    if (!openid) return
    wx.setClipboardData({ data: openid, success: () => wx.showToast({ title: '已复制', icon: 'none' }) })
  }
})
