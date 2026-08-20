// 买空调 · 市场列表(tab 页):师傅直卖新机/二手机,信息展示 + 电话联系 + 线下当面交易
const { relTime, callFn, mergeById } = require('../../utils/util')
const { conditionName, unitTypeName, hpName, gradeName } = require('../../utils/constants')

Page({
  data: {
    condition: '',        // ''=全部 / new / used
    listings: [],
    page: 0,
    noMore: false,
    loaded: false,
    loadError: false
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 1 })
    }
    // 首次进入才自动加载:从详情返回保留浏览位置,刷新交给下拉
    if (!this.data.loaded && !this._loading) this.loadMarket(0)
  },
  onPullDownRefresh() { this.loadMarket(0).finally(() => wx.stopPullDownRefresh()) },
  onReachBottom() {
    // 请求锁:上一页在途时忽略触底(与 pool 同范式,)
    if (!this.data.noMore && this.data.loaded && !this._loading) {
      this.loadMarket(this.data.page + 1)
    }
  },

  async loadMarket(page = 0) {
    // 代次控制:切筛选/下拉会作废在途旧响应,晚到的旧分页不能覆盖新列表
    const gen = this._gen = (this._gen || 0) + 1
    this._loading = true
    try {
      const res = await callFn('getListings', { action: 'market', page, condition: this.data.condition })
      if (gen !== this._gen) return
      const mapped = res.data.map(l => Object.assign(l, {
        // 展示文案预计算:WXML 插值不能调函数(守护测试 wxmlExpr)
        condClass: l.condition === 'new' ? 'cond-new' : 'cond-used',
        condText: l.condition === 'new' ? conditionName(l.condition) : (gradeName(l.usedGrade) || conditionName(l.condition)),
        specText: [unitTypeName(l.unitType), hpName(l.hp)].filter(Boolean).join(' · '),
        metaText: `${l.cityName || ''} · ${relTime(l.createdAt)}`
      }))
      this.setData({
        listings: page === 0 ? mapped : mergeById(this.data.listings, mapped),
        page,
        noMore: !res.hasMore,
        loaded: true,
        loadError: false
      })
    } catch (e) {
      // 失败保留已有列表,只标记错误态( 同约定)
      if (gen === this._gen) this.setData({ loaded: true, loadError: true })
    } finally {
      if (gen === this._gen) this._loading = false
    }
  },

  switchCond(e) {
    const key = e.currentTarget.dataset.key
    if (key === this.data.condition) return
    this.setData({ condition: key, loaded: false, listings: [] }, () => this.loadMarket(0))
  },

  retryLoad() { this.loadMarket(0) },
  goDetail(e) { wx.navigateTo({ url: `/pages/listingDetail/listingDetail?id=${e.currentTarget.dataset.id}` }) },

  onShareAppMessage() {
    return { title: '师傅直卖空调,新机二手都有,当面验货', path: '/pages/market/market' }
  }
})
