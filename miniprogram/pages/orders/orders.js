const { ORDER_STATUS } = require('../../utils/constants')
const { formatTime, callFn, mergeById } = require('../../utils/util')

Page({
  data: {
    mode: 'user',        // user=我发布的 / master=我接的
    orders: [],
    statusMap: ORDER_STATUS,
    page: 0,
    noMore: false,
    loaded: false,
    loadError: false
  },

  onLoad(options) {
    const mode = options.mode === 'master' ? 'master' : 'user'
    this.setData({ mode })
    wx.setNavigationBarTitle({ title: mode === 'master' ? '我的接单' : '我的订单' })
  },

  onShow() { this.reload() },
  onPullDownRefresh() { this.reload().finally(() => wx.stopPullDownRefresh()) },
  // 请求锁:上一页在途时忽略触底,连续触底只发一次请求
  onReachBottom() {
    if (!this.data.noMore && !this._loading) this.loadPage(this.data.page + 1)
  },

  reload() { return this.loadPage(0) },

  async loadPage(page) {
    // 代次控制:刷新会作废在途的旧分页响应,晚到的旧数据不能覆盖新状态
    const gen = this._gen = (this._gen || 0) + 1
    this._loading = true
    await getApp().getUser()
    const action = this.data.mode === 'master' ? 'masterList' : 'userList'
    try {
      const res = await callFn('getOrders', { action, page })
      if (gen !== this._gen) return
      const list = res.data.map(o => Object.assign(o, { publishedAtText: formatTime(o.publishedAt) }))
      this.setData({
        orders: page === 0 ? list : mergeById(this.data.orders, list),
        page,
        noMore: !res.hasMore,
        loaded: true,
        loadError: false
      })
    } catch (e) {
      // 失败保留已有列表,只标记错误态
      if (gen === this._gen) this.setData({ loaded: true, loadError: true })
    } finally {
      if (gen === this._gen) this._loading = false
    }
  },

  retryLoad() { this.reload() },

  goDetail(e) {
    wx.navigateTo({ url: `/pages/orderDetail/orderDetail?id=${e.currentTarget.dataset.id}` })
  }
})
