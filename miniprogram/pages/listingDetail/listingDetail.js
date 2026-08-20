// 商品详情(买空调频道):轮播 + 参数 + 卖家信任卡;电话按次经 contact 接口获取(限频)
// 合规红线:线下当面交易,平台不代收任何款项
const { callFn } = require('../../utils/util')
const { LISTING_STATUS, conditionName, unitTypeName, hpName, gradeName, yearsName } = require('../../utils/constants')

Page({
  data: {
    id: '',
    listing: null,
    isOwner: false,
    sellerVerified: false,
    sellerStats: null,
    sellerAvatar: '',
    avgStars: '',
    params: [],           // 参数表 [{label, value}]
    isOnSale: false,
    isSold: false,
    loaded: false,
    loadError: false,
    notFoundMsg: '',      // 商品不存在/已删除(分享链接可能指向已删商品)
    acting: false
  },

  onLoad(options) {
    this.setData({ id: options.id || '' })
    this.load()
  },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()) },

  async load() {
    if (!this.data.id) return this.setData({ loaded: true, notFoundMsg: '商品不存在或已删除' })
    try {
      const res = await callFn('getListings', { action: 'detail', listingId: this.data.id })
        .catch(e => {
          // 业务拒绝(已删除/已下架):渲染专用空态而不是 toast 后白屏
          if (e && e.ok === false) return e
          throw e
        })
      if (res.ok === false) {
        return this.setData({ loaded: true, loadError: false, listing: null, notFoundMsg: res.msg || '商品不存在或已删除' })
      }
      const l = res.data
      const params = [
        { label: '成色', value: l.condition === 'new' ? '全新' : (gradeName(l.usedGrade) || '二手') },
        { label: '品牌', value: l.brand },
        { label: '机型', value: unitTypeName(l.unitType) },
        { label: '匹数', value: hpName(l.hp) }
      ]
      if (l.condition === 'used' && l.usedYears) params.push({ label: '使用年限', value: yearsName(l.usedYears) })
      params.push({ label: '所在城市', value: l.cityName || '' })
      const s = res.sellerStats
      this.setData({
        listing: l,
        isOwner: !!res.isOwner,
        sellerVerified: !!res.sellerVerified,
        sellerStats: s,
        sellerAvatar: res.sellerAvatar || '',
        avgStars: s && s.reviewCount ? (s.totalStars / s.reviewCount).toFixed(1) : '',
        avatarText: (l.sellerDisplayName || '师')[0],
        condText: conditionName(l.condition),
        params,
        isOnSale: l.status === LISTING_STATUS.ON_SALE,
        isSold: l.status === LISTING_STATUS.SOLD,
        loaded: true,
        loadError: false,
        notFoundMsg: ''
      })
    } catch (e) {
      this.setData({ loaded: true, loadError: true })
    }
  },

  previewPhoto(e) {
    const src = e.currentTarget.dataset.src
    wx.previewImage({ current: src, urls: this.data.listing.photos || [] })
  },

  // 电话按次获取:服务端复查在售+卖家资格+日限频,失败文案由 callFn 自动 toast
  async contact() {
    if (this.data.acting) return
    this.setData({ acting: true })
    try {
      const res = await callFn('getListings', { action: 'contact', listingId: this.data.id })
      wx.makePhoneCall({ phoneNumber: res.phone })
    } catch (e) { /* 已提示(限频/已下架/资格失效) */ } finally {
      this.setData({ acting: false })
    }
  },

  report() {
    wx.showModal({
      title: '举报商品',
      editable: true,
      placeholderText: '请描述问题(如虚假信息、违规内容)',
      confirmText: '提交举报',
      success: async (r) => {
        if (!r.confirm) return
        try {
          await callFn('complain', { listingId: this.data.id, content: (r.content || '').trim() })
          wx.showToast({ title: '已收到举报,平台会尽快处理', icon: 'none' })
        } catch (e) { /* 已提示 */ }
      }
    })
  },

  goManage() { wx.navigateTo({ url: '/pages/myListings/myListings' }) },
  retryLoad() { this.load() },

  onShareAppMessage() {
    const l = this.data.listing
    return {
      title: l ? `${l.title} ¥${l.priceYuan}` : '师傅直卖空调,当面验货',
      path: `/pages/listingDetail/listingDetail?id=${this.data.id}`,
      imageUrl: l && l.photos && l.photos[0] ? l.photos[0] : ''
    }
  }
})
