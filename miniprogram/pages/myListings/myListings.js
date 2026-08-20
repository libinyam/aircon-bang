// 我的上架(卖家管理页):改价/下架/重新上架/标已售/删除,全部走 updateListing 条件原子更新
const { callFn, mergeById } = require('../../utils/util')
const { LISTING_STATUS, LISTING_STATUS_MAP, unitTypeName, hpName, gradeName } = require('../../utils/constants')

Page({
  data: {
    listings: [],
    page: 0,
    noMore: false,
    loaded: false,
    loadError: false,
    acting: false
  },

  onLoad() { this.loadPage(0) },
  onPullDownRefresh() { this.loadPage(0).finally(() => wx.stopPullDownRefresh()) },
  onReachBottom() {
    if (!this.data.noMore && this.data.loaded && !this._loading) {
      this.loadPage(this.data.page + 1)
    }
  },

  async loadPage(page = 0) {
    const gen = this._gen = (this._gen || 0) + 1
    this._loading = true
    try {
      const res = await callFn('getListings', { action: 'mine', page })
      if (gen !== this._gen) return
      const mapped = res.data.map(l => {
        const st = LISTING_STATUS_MAP[l.status] || { label: l.status, color: '#667180' }
        return Object.assign(l, {
          statusLabel: st.label,
          statusColor: st.color,
          condText: l.condition === 'new' ? '新机' : (gradeName(l.usedGrade) || '二手机'),
          specText: [unitTypeName(l.unitType), hpName(l.hp)].filter(Boolean).join(' · '),
          // 操作按钮可用性预计算(WXML 不写裸状态字面量)
          canOffShelf: l.status === LISTING_STATUS.ON_SALE,
          canOnShelf: l.status === LISTING_STATUS.OFF_SHELF,
          canSold: l.status === LISTING_STATUS.ON_SALE || l.status === LISTING_STATUS.OFF_SHELF,
          canEdit: l.status === LISTING_STATUS.ON_SALE || l.status === LISTING_STATUS.OFF_SHELF,
          canDelete: l.status === LISTING_STATUS.OFF_SHELF,
          reasonText: l.removedReason || l.offShelfReason || ''
        })
      })
      this.setData({
        listings: page === 0 ? mapped : mergeById(this.data.listings, mapped),
        page,
        noMore: !res.hasMore,
        loaded: true,
        loadError: false
      })
    } catch (e) {
      if (gen === this._gen) this.setData({ loaded: true, loadError: true })
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
      this.loadPage(0)
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
