const { formatDate, relTime, distanceKm, callFn, mergeById } = require('../../utils/util')
const { categoryShort, slotShort } = require('../../utils/constants')
const config = require('../../utils/config')

Page({
  data: {
    state: 'loading',      // loading / loginError / guest / pending / rejected / approved
    master: null,
    memberValid: false,
    memberExpireText: '',
    serviceCity: '',
    orders: [],            // 原始数据(按最新排序)
    showOrders: [],        // 应用排序后的展示数据
    catTabs: [],
    activeCat: '',
    sortBy: 'time',        // time=最新优先 / distance=距离优先
    page: 0,
    noMore: false,
    loaded: false,
    loadError: false,
    acting: false,
    showSubscribe: !!config.TPL_NEW_ORDER,
    myLocation: null
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 })
    }
    this.refresh()
  },
  onPullDownRefresh() { this.refresh().finally(() => wx.stopPullDownRefresh()) },
  onReachBottom() {
    // 请求锁:上一页在途时忽略触底
    if (this.data.state === 'approved' && !this.data.noMore && this.data.loaded && !this._loading) {
      this.loadPool(this.data.page + 1)
    }
  },

  async refresh() {
    const g = await getApp().getUser(true)
    // 登录失败不能当游客处理,否则已入驻师傅会被误导重新入驻
    if (g.loginError) return this.setData({ state: 'loginError' })
    const m = g.master
    if (!m) return this.setData({ state: 'guest' })
    if (m.status === 'pending') return this.setData({ state: 'pending', master: m })
    if (m.status === 'rejected') return this.setData({ state: 'rejected', master: m })

    const catTabs = [{ key: '', name: '全部' }].concat(
      (m.categories || []).map(k => ({ key: k, name: categoryShort(k) }))
    )
    this.setData({
      state: 'approved',
      master: m,
      catTabs,
      memberExpireText: m.memberExpireAt ? formatDate(m.memberExpireAt) : ''
    })
    await this.loadPool(0)
  },

  async loadPool(page = 0) {
    // 代次控制:刷新/切品类会作废在途的旧响应,晚到的旧分页不能覆盖新列表
    const gen = this._gen = (this._gen || 0) + 1
    this._loading = true
    if (!this.data.myLocation) {
      try {
        const loc = await wx.getLocation({ type: 'gcj02' })
        this.setData({ myLocation: { latitude: loc.latitude, longitude: loc.longitude } })
      } catch (e) { /* 拒绝定位则不显示距离,距离排序退化为最新排序 */ }
    }

    try {
      const res = await callFn('getOrders', { action: 'pool', page, category: this.data.activeCat })
      if (gen !== this._gen) return
      const my = this.data.myLocation
      const today = formatDate(new Date())
      const tomorrow = formatDate(new Date(Date.now() + 86400000))

      const mapped = res.data.map(o => {
        let distanceNum = 0
        if (my && o.location && o.location.coordinates) {
          const [lng, lat] = o.location.coordinates
          distanceNum = Number(distanceKm(my.latitude, my.longitude, lat, lng).toFixed(1))
        }
        const slotCN = slotShort(o.expectSlot)
        let urgentText = ''
        if (o.expectDate === today) urgentText = `急 · 今天${slotCN}`
        else if (o.expectDate === tomorrow) urgentText = `明天${slotCN}`
        return Object.assign(o, {
          distanceNum,
          near: distanceNum > 0 && distanceNum < 3,
          urgentText,
          pubText: relTime(o.publishedAt) + '发布'
        })
      })

      let orders
      if (page === 0) {
        orders = mapped
      } else {
        orders = mergeById(this.data.orders, mapped)
      }
      this.setData({
        orders,
        page,
        noMore: !res.hasMore,
        memberValid: res.memberValid,
        serviceCity: res.serviceCity,
        loaded: true,
        loadError: false
      })
      this.applySort()
    } catch (e) {
      if (gen === this._gen) this.setData({ loaded: true, loadError: true })
    } finally {
      if (gen === this._gen) this._loading = false
    }
  },

  applySort() {
    const list = this.data.orders.slice()
    if (this.data.sortBy === 'distance') {
      list.sort((a, b) => (a.distanceNum || 9999) - (b.distanceNum || 9999))
    }
    this.setData({ showOrders: list })
  },

  switchCat(e) {
    const key = e.currentTarget.dataset.key
    if (key === this.data.activeCat) return
    this.setData({ activeCat: key, loaded: false, orders: [], showOrders: [] }, () => this.loadPool(0))
  },

  toggleSort() {
    this.setData({ sortBy: this.data.sortBy === 'time' ? 'distance' : 'time' })
    this.applySort()
  },

  retryLoad() { this.loadPool(0) },
  goApply() { wx.navigateTo({ url: '/pages/masterApply/masterApply' }) },
  goDetail(e) { wx.navigateTo({ url: `/pages/orderDetail/orderDetail?id=${e.currentTarget.dataset.id}` }) },
  callService() { wx.makePhoneCall({ phoneNumber: config.SERVICE_PHONE }) },

  onShareAppMessage() {
    return { title: '空调师傅看过来:同城接单平台,不抽单佣金', path: '/pages/pool/pool' }
  },

  subscribeNewOrder() {
    wx.requestSubscribeMessage({
      tmplIds: [config.TPL_NEW_ORDER],
      success: res => {
        if (res[config.TPL_NEW_ORDER] === 'accept') {
          wx.showToast({ title: '已开启,有新单会通知你', icon: 'none' })
        }
      }
    })
  },

  async grab(e) {
    const orderId = e.currentTarget.dataset.id
    this.setData({ acting: true })
    try {
      const res = await callFn('grabOrder', { orderId })
      wx.showModal({
        title: '抢单成功',
        content: `请尽快联系客户${res.userName ? ' ' + res.userName : ''}:${res.userPhone}`,
        confirmText: '拨打电话',
        cancelText: '稍后再打',
        success: r => { if (r.confirm) wx.makePhoneCall({ phoneNumber: res.userPhone }) }
      })
    } catch (e) { /* 已提示(手慢了等) */ } finally {
      this.setData({ acting: false })
      this.loadPool(0)
    }
  }
})
