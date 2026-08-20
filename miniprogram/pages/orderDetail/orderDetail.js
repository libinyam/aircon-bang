const { ORDER_STATUS, STATUS } = require('../../utils/constants')
const { formatTime, callFn } = require('../../utils/util')
const config = require('../../utils/config')

// showModal 的 editable 输入框无法限长,超长提交会被服务端整段拒绝而弹窗已关、内容全丢;
// 提交前按服务端上限截断保底(止血版;彻底方案是自定义弹层)
const REASON_MAX = 100    // 与 cancelOrder/confirmOrder 服务端上限一致
const COMPLAIN_MAX = 500  // 与 complain 服务端上限一致
function clip(text, max) {
  const t = text || ''
  if (t.length > max) wx.showToast({ title: `内容超长,已按前${max}字提交`, icon: 'none' })
  return t.slice(0, max)
}

Page({
  data: {
    orderId: '',
    order: null,
    role: '',            // user / master / viewer
    review: null,
    masterStats: null,
    avgStars: '',
    publishedAtText: '',
    reviewStars: 5,
    reviewContent: '',
    statusMap: ORDER_STATUS,
    memberValid: true, // 围观师傅会员状态:过期时禁用抢单;user/master 视角恒 true
    servicePhone: config.SERVICE_PHONE,
    acting: false,
    loadError: false
  },

  onLoad(options) { this.setData({ orderId: options.id }) },
  onShow() { this.load() },

  async load() {
    await getApp().getUser()
    try {
      const res = await callFn('getOrders', { action: 'detail', orderId: this.data.orderId })
      const stats = res.masterStats
      this.setData({
        order: res.data,
        role: res.role,
        review: res.review,
        masterStats: stats,
        avgStars: stats && stats.reviewCount ? (stats.totalStars / stats.reviewCount).toFixed(1) : '',
        publishedAtText: formatTime(res.data.publishedAt),
        memberValid: res.memberValid !== false,   // 仅 viewer 视角下发,其余视角 undefined 视为不受限
        loadError: false
      })
    } catch (e) {
      // 业务拒绝(无权查看/订单不存在)才弹回;网络抖动给错误态和重试,不把用户轰出去
      if (e && e.ok === false) {
        setTimeout(() => wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/index/index' }) }), 1200)
      } else {
        this.setData({ loadError: true })
      }
    }
  },

  retryLoad() { this.setData({ loadError: false }); this.load() },

  previewPhoto(e) {
    wx.previewImage({ current: e.currentTarget.dataset.src, urls: this.data.order.photos })
  },

  callPhone(e) {
    const phone = e.currentTarget.dataset.phone
    if (phone) wx.makePhoneCall({ phoneNumber: phone })
  },

  // 点地址打开地图(师傅上门导航用;location 经云函数序列化为 GeoJSON)
  openMap() {
    const loc = this.data.order && this.data.order.location
    if (!loc || !loc.coordinates) return
    wx.openLocation({
      latitude: loc.coordinates[1],
      longitude: loc.coordinates[0],
      name: this.data.order.address,
      scale: 18
    })
  },

  // 围观师傅抢单
  async grab() {
    if (!this.data.memberValid) return   // 按钮已禁用,兜底防连点窗口;服务端仍会校验
    this.setData({ acting: true })
    try {
      const res = await callFn('grabOrder', { orderId: this.data.orderId })
      await getApp().getUser(true)
      wx.showModal({
        title: '抢单成功 🎉',
        content: `请尽快联系客户${res.userName ? ' ' + res.userName : ''}:${res.userPhone}`,
        confirmText: '拨打电话',
        cancelText: '稍后再打',
        success: r => { if (r.confirm) wx.makePhoneCall({ phoneNumber: res.userPhone }) }
      })
      this.load()
    } catch (e) {
      this.load() // 可能被别人抢了,刷新状态
    } finally {
      this.setData({ acting: false })
    }
  },

  cancel() {
    const needReason = this.data.order.status === STATUS.ACCEPTED
    // 师傅取消会计入记录(cancelOrder 里累计 stats.cancelled),弹窗明示
    const isMasterCancel = needReason && this.data.role === 'master'
    wx.showModal({
      title: isMasterCancel ? '取消将计入接单记录' : (needReason ? '协商取消' : '取消订单'),
      content: needReason ? '' : '确定取消这条维修需求吗?',
      editable: needReason,
      placeholderText: needReason ? '请填写取消原因(双方可见)' : '',
      success: async r => {
        if (!r.confirm) return
        if (needReason && !(r.content || '').trim()) {
          return wx.showToast({ title: '请填写取消原因', icon: 'none' })
        }
        this.setData({ acting: true })
        try {
          await callFn('cancelOrder', { orderId: this.data.orderId, reason: clip(r.content, REASON_MAX) })
          wx.showToast({ title: '已取消', icon: 'success' })
          this.load()
        } catch (e) { this.load() } finally { this.setData({ acting: false }) }
      }
    })
  },

  // 师傅标记完成
  async finish() {
    // 顺带请求订阅"完工被驳回"通知:用户驳回时师傅才能第一时间知道
    if (config.TPL_ORDER_REJECTED) {
      await new Promise(resolve => wx.requestSubscribeMessage({
        tmplIds: [config.TPL_ORDER_REJECTED], complete: resolve
      }))
    }
    this.setData({ acting: true })
    try {
      await callFn('finishOrder', { orderId: this.data.orderId })
      wx.showToast({ title: '已提交,等客户确认', icon: 'success' })
      this.load()
    } catch (e) { this.load() } finally { this.setData({ acting: false }) }
  },

  // 误点"维修已完成"的自救出口:退回已接单,不计驳回
  undoFinish() {
    wx.showModal({
      title: '撤销完成',
      content: '订单将退回"师傅已接单"状态,继续维修后可再次提交完成。',
      confirmText: '撤销',
      success: async r => {
        if (!r.confirm) return
        this.setData({ acting: true })
        try {
          await callFn('finishOrder', { orderId: this.data.orderId, undo: true })
          wx.showToast({ title: '已撤销', icon: 'none' })
          this.load()
        } catch (e) { this.load() } finally { this.setData({ acting: false }) }
      }
    })
  },

  // 用户驳回"待确认":订单退回已接单,记录驳回(防师傅未完工就点完成)
  rejectFinish() {
    wx.showModal({
      title: '驳回确认',
      editable: true,
      placeholderText: '说明未完成的情况(选填,双方可见)',
      confirmText: '驳回',
      success: async r => {
        if (!r.confirm) return
        this.setData({ acting: true })
        try {
          await callFn('confirmOrder', { orderId: this.data.orderId, reject: true, reason: clip(r.content, REASON_MAX) })
          wx.showToast({ title: '已驳回,可联系师傅继续处理', icon: 'none' })
          this.load()
        } catch (e) { this.load() } finally { this.setData({ acting: false }) }
      }
    })
  },

  // 用户确认完成
  async confirm() {
    this.setData({ acting: true })
    try {
      await callFn('confirmOrder', { orderId: this.data.orderId })
      wx.showToast({ title: '已确认,给师傅评个价吧', icon: 'none' })
      this.load()
    } catch (e) { this.load() } finally { this.setData({ acting: false }) }
  },

  setStars(e) { this.setData({ reviewStars: e.currentTarget.dataset.n }) },
  onReviewInput(e) { this.setData({ reviewContent: e.detail.value }) },

  async submitReview() {
    this.setData({ acting: true })
    try {
      await callFn('submitReview', {
        orderId: this.data.orderId,
        stars: this.data.reviewStars,
        content: this.data.reviewContent
      })
      wx.showToast({ title: '感谢评价', icon: 'success' })
      this.load()
    } catch (e) { /* 已提示 */ } finally { this.setData({ acting: false }) }
  },

  complain() {
    wx.showModal({
      title: '投诉 / 反馈',
      editable: true,
      placeholderText: '请描述遇到的问题,平台会尽快处理',
      success: async r => {
        if (!r.confirm) return
        try {
          await callFn('complain', { orderId: this.data.orderId, content: clip(r.content, COMPLAIN_MAX) })
          wx.showToast({ title: '已提交,平台会尽快联系您', icon: 'none' })
        } catch (e) { /* 已提示 */ }
      }
    })
  }
})
