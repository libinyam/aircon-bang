const { CATEGORIES, ORDER_STATUS } = require('../../utils/constants')
const { callFn } = require('../../utils/util')
const config = require('../../utils/config')

// 按设备本地时段问好(真实时间,无虚构信息)
function greetingText(hour) {
  if (hour < 5) return '夜深了'
  if (hour < 9) return '早上好'
  if (hour < 12) return '上午好'
  if (hour < 14) return '中午好'
  if (hour < 18) return '下午好'
  return '晚上好'
}

Page({
  data: {
    categories: CATEGORIES,
    statusMap: ORDER_STATUS,
    activeOrders: [],      // 我发的进行中订单
    masterOrders: [],      // 我接的进行中订单(认证师傅才有)
    isApprovedMaster: false,
    masterEntryText: '我要接单',
    masterJoinText: '去入驻',
    greeting: '',
    heroImage: '', // 换链成功才有值(https 临时链接),失败/留空走渐变回退版
    statusBarHeight: 44
  },

  onLoad() {
    this.setData({
      statusBarHeight: getApp().globalData.statusBarHeight || 44
    })
    this.resolveHero()
  },

  // hero 实景图:包内本地路径直接用;cloud:// fileID 需先换临时链接(存储"仅创建者可读写"
  // 下终端用户直读会 STORAGE_EXCEED_AUTHORITY)。任何失败都回退渐变版,不留破相 hero
  resolveHero() {
    const img = config.HERO_IMAGE
    if (!img) return
    if (!/^cloud:\/\//.test(img)) {
      this.setData({ heroImage: img })
      return
    }
    wx.cloud.getTempFileURL({ fileList: [img] }).then(r => {
      const f = r.fileList && r.fileList[0]
      if (f && f.status === 0 && f.tempFileURL) {
        this.setData({ heroImage: f.tempFileURL })
      } else {
        // status 非 0 = fileID 不存在或无读权限,errMsg 即真实原因
        console.warn('[hero] 换链失败,回退渐变版:', f && (f.errMsg || ('status ' + f.status)), img)
      }
    }).catch(e => console.warn('[hero] 换链失败,回退渐变版:', e && e.errMsg, img))
  },

  // 临时链接本身加载失败(链接过期/网络):同样回退渐变版,不留破相的半拉子 hero
  onHeroImgError() {
    if (this.data.heroImage) this.setData({ heroImage: '' })
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 0 })
    }
    // 问候语随 onShow 刷新:tab 常驻页挂后台数小时再回来,时段可能已跨过
    this.setData({ greeting: greetingText(new Date().getHours()) })
    this.refreshRole()
    this.loadActiveOrders()
  },

  async refreshRole() {
    const g = await getApp().getUser()
    const isApprovedMaster = !!(g.master && g.master.status === 'approved')
    this.setData({
      isApprovedMaster,
      masterEntryText: isApprovedMaster ? '接单大厅' : '我要接单',
      masterJoinText: isApprovedMaster ? '去接单' : '去入驻'
    })
  },

  async loadActiveOrders() {
    const g = await getApp().getUser()
    // 认证师傅另查"我接的单":首页也一览接的单,不必绕 我的→我的接单。两个列表并行,互不拖累首屏
    const jobs = [
      callFn('getOrders', { action: 'userList', activeOnly: true })
        .catch(e => { console.error('loadActiveOrders failed', e); return null })
    ]
    if (g.master && g.master.status === 'approved') {
      jobs.push(
        callFn('getOrders', { action: 'masterList', activeOnly: true })
          .catch(e => { console.error('loadMasterOrders failed', e); return null })
      )
    }
    const [pub, mine] = await Promise.all(jobs)
    // 静默失败但留日志:首页进行中订单是辅助信息,不打扰用户;
    // mine===undefined 表示本次身份不是师傅(未发起查询),此时清空,防止角色变化后残留旧数据
    this.setData({
      activeOrders: pub ? pub.data : this.data.activeOrders,
      masterOrders: mine === undefined ? [] : (mine ? mine.data : this.data.masterOrders)
    })
  },

  goPublish(e) {
    const category = e.currentTarget.dataset.category || ''
    wx.navigateTo({ url: `/pages/publish/publish?category=${category}` })
  },

  goDetail(e) {
    wx.navigateTo({ url: `/pages/orderDetail/orderDetail?id=${e.currentTarget.dataset.id}` })
  },

  async goMaster() {
    const g = await getApp().getUser()
    if (g.master && g.master.status === 'approved') {
      wx.switchTab({ url: '/pages/pool/pool' })
      return
    }
    wx.navigateTo({ url: '/pages/masterApply/masterApply' })
  },

  goMarket() {
    wx.switchTab({ url: '/pages/market/market' })
  },
  onShareAppMessage() {
    return {
      title: config.SHARE.home.title,
      path: config.SHARE.home.path,
      imageUrl: config.SHARE_COVER
    }
  }
})
