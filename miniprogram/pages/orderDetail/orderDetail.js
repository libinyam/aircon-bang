const { ORDER_STATUS, STATUS, sceneName, grabFee } = require('../../utils/constants')
const { formatTime, callFn, formatFee } = require('../../utils/util')
const config = require('../../utils/config')

// showModal 的 editable 输入框无法限长,超长提交会被服务端整段拒绝而弹窗已关、内容全丢;
// 提交前按服务端上限截断保底
const REASON_MAX = 100    // 与 cancelOrder/confirmOrder 服务端上限一致
const COMPLAIN_MAX = 500  // 与 complain 服务端上限一致
function clip(text, max) {
  const t = text || ''
  if (t.length > max) wx.showToast({ title: `内容超长,已按前${max}字提交`, icon: 'none' })
  return t.slice(0, max)
}

// 状态时间轴(v4.1):节点与既有时间戳字段一一对应(published→accepted→pending_confirm→completed),
// 时间戳由各状态流转函数落库,无需后端补字段;取消单走两节点红色终态('stop',避开状态字面量禁令)
const TL_NODES = [
  { status: STATUS.PUBLISHED, label: '已发布', at: 'publishedAt' },
  { status: STATUS.ACCEPTED, label: '已接单', at: 'acceptedAt' },
  { status: STATUS.PENDING_CONFIRM, label: '待确认', at: 'finishedAt' },
  { status: STATUS.COMPLETED, label: '已完成', at: 'confirmedAt' }
]
function buildTimeline(o) {
  if (o.status === STATUS.CANCELLED) {
    return [
      { label: '已发布', time: formatTime(o.publishedAt), state: 'done' },
      { label: '已取消', time: formatTime(o.cancelledAt), state: 'stop' }
    ]
  }
  const cur = TL_NODES.findIndex(n => n.status === o.status)
  if (cur < 0) return []
  return TL_NODES.map((n, i) => ({
    label: n.label,
    time: i <= cur ? formatTime(o[n.at]) : '',
    state: i < cur ? 'done' : (i === cur ? 'current' : 'future')
  }))
}

Page({
  data: {
    orderId: '',
    order: null,
    role: '',            // user / master / viewer
    review: null,
    masterStats: null,
    avgStars: '',
    masterInitial: '',    // 信任卡无头像时的姓氏首字兜底
    userInitial: '',      // 师傅视角客户卡同构
    timeline: [],         // 状态时间轴(v4.1),围观视角不渲染
    markers: [],          // 内嵌地图定位点(接单后,师傅/用户视角)
    publishedAtText: '',
    reviewStars: 5,
    reviewContent: '',
    statusMap: ORDER_STATUS,
    walletBalance: null,   // 围观师傅钱包余额(分),仅 viewer 视角下发;其余视角 null
    balanceText: '',
    balanceShortage: false,// 余额不够本单接单费:按钮转"去充值"(服务端 grabOrder 仍是防线)
    sceneLabel: '家用',
    feeText: '20',
    acting: false,
    loadError: false,
    moreOpen: false,     // 吸底面板"更多"次操作展开态(v4.1)
    moreItems: []        // 次操作项(按角色+状态适配,v4.1)
  },

  onLoad(options) { this.setData({ orderId: options.id }) },
  onShow() { this.load() },

  toggleMore() { this.setData({ moreOpen: !this.data.moreOpen }) },

  // 更多面板的次操作分发
  onMoreAction(e) {
    this.setData({ moreOpen: false })
    const fn = e.currentTarget.dataset.fn
    if (typeof this[fn] === 'function') this[fn]()
  },

  async load() {
    await getApp().getUser()
    try {
      const res = await callFn('getOrders', { action: 'detail', orderId: this.data.orderId })
      const stats = res.masterStats
      const o = res.data
      const fee = grabFee(o.scene)
      this.setData({
        order: o,
        role: res.role,
        review: res.review,
        masterStats: stats,
        avgStars: stats && stats.reviewCount ? (stats.totalStars / stats.reviewCount).toFixed(1) : '',
        masterInitial: (o.masterName || '师').slice(0, 1),
        userInitial: (o.userName || '客').slice(0, 1),
        timeline: buildTimeline(o),
        markers: this.buildMarkers(o, res.role),
        moreItems: this.buildMoreItems(o, res.role),
        moreOpen: false,
        publishedAtText: formatTime(o.publishedAt),
        sceneLabel: o.equipTypeName || sceneName(o.scene) || '家用', // 新单显示设备类型(如商用中央空调),老单回退家用/商用
        feeText: formatFee(fee),
        walletBalance: res.walletBalance !== undefined ? res.walletBalance : null,
        balanceText: res.walletBalance !== undefined ? formatFee(res.walletBalance) : '',
        balanceShortage: res.walletBalance !== undefined && res.walletBalance < fee,
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

  // 吸底面板"更多"次操作(v4.1):按角色+状态给出有效项,避免无效操作露出
  buildMoreItems(o, role) {
    if (role !== 'user' && role !== 'master') return []
    const items = []
    if (o.status === STATUS.PENDING_CONFIRM && role === 'user') {
      items.push({ fn: 'rejectFinish', label: '未完成,驳回' })
    }
    if (o.status === STATUS.PENDING_CONFIRM && role === 'master') {
      items.push({ fn: 'undoFinish', label: '撤销完成' })
    }
    if (o.status === STATUS.ACCEPTED || o.status === STATUS.PENDING_CONFIRM) {
      items.push({ fn: 'cancel', label: '协商取消' })
    }
    items.push({ fn: 'complain', label: '投诉 / 反馈' })
    return items
  },

  // 内嵌地图(v4.1):接单后订单定位点;published 单不下发精确坐标,不嵌图
  buildMarkers(o, role) {
    const loc = o.location && o.location.coordinates
    if (!loc || o.status === STATUS.PUBLISHED || role === 'viewer') return []
    return [{
      id: 1,
      latitude: loc[1],
      longitude: loc[0],
      width: 27, height: 36,
      iconPath: '/miniprogram/assets/pin-brand.png'
    }]
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

  // 围观师傅抢单(按单扣费:先确认金额,余额不足引导充值)
  async grab() {
    if (this.data.balanceShortage) return this.goWallet()
    const confirmed = await new Promise(resolve => {
      wx.showModal({
        title: `确认接${this.data.sceneLabel}单`,
        content: `接单将从钱包扣除服务费 ¥${this.data.feeText}${this.data.balanceText ? '(当前余额 ¥' + this.data.balanceText + ')' : ''},抢不到自动退回。`,
        confirmText: '确认接单',
        cancelText: '再想想',
        success: r => resolve(!!r.confirm),
        fail: () => resolve(false)
      })
    })
    if (!confirmed) return

    this.setData({ acting: true })
    try {
      const res = await callFn('grabOrder', { orderId: this.data.orderId })
      await getApp().getUser(true)
      wx.showModal({
        title: '抢单成功 🎉',
        content: `已扣接单费 ¥${formatFee(res.feeCharged)}。请尽快联系客户${res.userName ? ' ' + res.userName : ''}:${res.userPhone}`,
        confirmText: '拨打电话',
        cancelText: '稍后再打',
        success: r => { if (r.confirm) wx.makePhoneCall({ phoneNumber: res.userPhone }) }
      })
      this.load()
    } catch (e) {
      if (e && e.msg && e.msg.includes('余额不足')) {
        wx.showModal({
          title: '余额不足',
          content: `接${this.data.sceneLabel}单需 ¥${this.data.feeText},充值后再来接单。`,
          confirmText: '去充值',
          success: r => { if (r.confirm) this.goWallet() }
        })
      }
      this.load() // 可能被别人抢了,刷新状态
    } finally {
      this.setData({ acting: false })
    }
  },

  goWallet() { wx.navigateTo({ url: '/pages/wallet/wallet' }) },

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
