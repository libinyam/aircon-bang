// 我的上架(卖家管理页):改价/下架/重新上架/标已售/删除,全部走 updateListing 条件原子更新
// 打开体验:进「我的」tab 已后台预取(utils/listingsCache),onLoad 新鲜缓存先整页上屏
// 再静默刷新收敛——首屏不等 getListings 往返(冷启动+换链约 1s)
const { callFn, mergeById } = require('../../utils/util')
const listingsCache = require('../../utils/listingsCache')

Page({
  data: {
    listings: [],
    page: 0,
    noMore: false,
    loaded: false,
    loadError: false,
    acting: false
  },

  onLoad() {
    // 缓存先上屏:loaded 置 true 跳过 spinner,随后的静默刷新覆盖为最新
    const cached = listingsCache.peekMine()
    if (cached) {
      this.setData({ listings: cached.rows, page: 0, noMore: cached.noMore, loaded: true, loadError: false })
    }
    this.loadPage(0, { silent: !!cached })
  },
  onPullDownRefresh() { this.loadPage(0).finally(() => wx.stopPullDownRefresh()) },
  onReachBottom() {
    if (!this.data.noMore && this.data.loaded && !this._loading) {
      this.loadPage(this.data.page + 1)
    }
  },

  // silent:屏上已有内容时的后台刷新——失败不弹 toast 不进错误态,保留现状
  async loadPage(page = 0, { silent = false } = {}) {
    const gen = this._gen = (this._gen || 0) + 1
    this._loading = true
    try {
      const res = await callFn('getListings', { action: 'mine', page }, { silent })
      if (gen !== this._gen) return
      const mapped = listingsCache.mapRows(res.data)
      this.setData({
        listings: page === 0 ? mapped : mergeById(this.data.listings, mapped),
        page,
        noMore: !res.hasMore,
        loaded: true,
        loadError: false
      })
      if (page === 0) listingsCache.putMine(mapped, !res.hasMore)
    } catch (e) {
      if (gen === this._gen && !(silent && this.data.listings.length)) {
        this.setData({ loaded: true, loadError: true })
      }
      // 第 0 页刷新失败:缓存无法确认还能收敛,直接弃掉——下次进入走全量 loading,
      // 不整屏渲染可能已不成立的旧状态
      if (page === 0) listingsCache.dropMine()
    } finally {
      if (gen === this._gen) this._loading = false
    }
  },

  retryLoad() { this.loadPage(0) },
  goDetail(e) { wx.navigateTo({ url: `/pages/listingDetail/listingDetail?id=${e.currentTarget.dataset.id}` }) },
  goPublish() { wx.navigateTo({ url: '/pages/publishListing/publishListing' }) },

  async doAction(action, listingId, extra) {
    if (this.data.acting) return
    this.setData({ acting: true })
    try {
      await callFn('updateListing', Object.assign({ action, listingId }, extra))
      wx.showToast({ title: '操作成功', icon: 'none' })
    } catch (e) { /* 已提示 */ } finally {
      this.setData({ acting: false })
      // 操作本身已 toast 结果,后续列表刷新静默:失败保留旧列表,下次下拉再收敛
      this.loadPage(0, { silent: true })
    }
  },

  offShelf(e) { this.doAction('offShelf', e.currentTarget.dataset.id) },
  onShelf(e) { this.doAction('onShelf', e.currentTarget.dataset.id) },

  markSold(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '确认已售出?',
      content: '标记后商品不再展示,且不可恢复(再卖需重新发布)',
      success: r => { if (r.confirm) this.doAction('markSold', id) }
    })
  },

  editPrice(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '修改价格(元)',
      editable: true,
      placeholderText: '输入 1-99999 的整数',
      success: r => {
        if (!r.confirm) return
        const v = (r.content || '').trim()
        if (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > 99999) {
          return wx.showToast({ title: '价格需为 1-99999 的整数', icon: 'none' })
        }
        this.doAction('editPrice', id, { priceYuan: Number(v) })
      }
    })
  },

  del(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '删除商品?',
      content: '删除后需重新发布,已转发的分享链接将失效',
      confirmText: '删除',
      confirmColor: '#CE3F36',
      success: r => { if (r.confirm) this.doAction('deleteListing', id) }
    })
  }
})
