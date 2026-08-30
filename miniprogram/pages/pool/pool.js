const { formatDate, relTime, distanceKm, callFn, mergeById, formatFee } = require('../../utils/util')
const { CATEGORIES, categoryShort, slotShort, sceneName, grabFee, ORDER_STATUS } = require('../../utils/constants')
const config = require('../../utils/config')

Page({
  data: {
    state: 'loading',      // loading / loginError / guest / pending / rejected / approved
    master: null,
    balance: 0,            // 钱包余额(分),接单费从这里扣
    balanceText: '0',
    lowBalance: true,      // 不够接一单家用(¥20)时头部条转警示态
    serviceCity: '',
    orders: [],            // 原始数据(按最新排序)
    showOrders: [],        // 应用排序后的展示数据
    catTabs: [],
    activeCat: '',
    catGapText: '',      // 缺品类提醒文案,空串不显示
    sortBy: 'time',        // time=最新优先 / distance=距离优先
    page: 0,
    noMore: false,
    loaded: false,
    loadError: false,
    acting: false,
    showSubscribe: !!config.TPL_NEW_ORDER,
    myLocation: null,
    statusMap: ORDER_STATUS,  // "我接的单"细条的状态点/文案
    myActive: []              // 我接的进行中订单(最多3条),接完单在大厅第一眼就能找回
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      // 中间位给了凸起发单钮(v4.1),接单大厅顺移到 3
      this.getTabBar().setData({ selected: 3 })
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
    // 先用缓存身份立即上屏,进页零等待:点击 tab 时不再被 login 云调用阻塞(旧版在
    // tabBar 里 await 强刷,点接单大厅先"死"几百毫秒)。角色真实性由两层兜底:
    // 服务端 getOrders.pool 复检 approved;客户端缓存未过 TTL 前角色偏差最多 60s
    const applyState = (g) => {
      if (g.loginError) { this.setData({ state: 'loginError' }); return false }
      const m = g.master
      if (!m) { this.setData({ state: 'guest' }); return false }
      if (m.status === 'pending') { this.setData({ state: 'pending', master: m }); return false }
      if (m.status === 'rejected') { this.setData({ state: 'rejected', master: m }); return false }
      const catTabs = [{ key: '', name: '全部' }].concat(
        (m.categories || []).map(k => ({ key: k, name: categoryShort(k) }))
      )
      // 缺品类提醒:档案没勾全的品类,大厅匹配不到对应单(冷库/水冷扩容后存量师傅全中)。
      // 缺口集合作为缓存键:师傅关闭提醒后,只有出现新缺口(下次扩品类)才再提示
      const missing = CATEGORIES.map(c => c.key).filter(k => !(m.categories || []).includes(k))
      let catGapText = ''
      if (missing.length && wx.getStorageSync('catGapDismissed') !== missing.join(',')) {
        catGapText = `平台已支持${missing.map(categoryShort).join('、')},你的档案未勾选,这类单不会出现在大厅`
      }
      this.setData({ state: 'approved', master: m, catTabs, catGapText })
      return true
    }
    const g = await getApp().getUser()
    if (applyState(g)) { this.loadMyActive(); return this.loadPool(0) }

    // 缓存说不是认证师傅:后台强刷一次收敛角色。
    // 结果有变才重渲染;纯游客/被驳回也照此多一次调用,与旧版 tabBar 拦截的成本一致。
    // loginError 单独作一种"角色":强刷成功后即使角色字面未变(如本就是 approved)也要重渲染,
    // 否则会卡在错误态
    const roleOf = (x) => (!x.master ? 'guest' : x.master.status)
    const before = g.loginError ? 'loginError' : roleOf(g)
    const fresh = await getApp().getUser(true)
    if (!fresh.loginError && roleOf(fresh) !== before && applyState(fresh)) {
      if (typeof this.getTabBar === 'function' && this.getTabBar() && this.getTabBar().syncRole) {
        this.getTabBar().syncRole()   // tab 文案从「师傅入驻」纠正为「接单大厅」
      }
      this.loadMyActive()
      this.loadPool(0)
    }
  },

  // 我接的进行中订单:大厅置顶细条。辅助信息,静默失败留日志即可(与首页 loadActiveOrders 同口径)。
  // silent 要真接上 callFn:静默刷新不该因网络抖动在大厅平白弹"网络异常";
  // 独立代次(_activeGen):快速切 tab 造成并发时,晚到的旧快照不能覆盖新快照
  async loadMyActive() {
    const gen = this._activeGen = (this._activeGen || 0) + 1
    const res = await callFn('getOrders', { action: 'masterList', activeOnly: true }, { silent: true })
      .catch(e => { console.error('loadMyActive failed', e); return null })
    if (res && gen === this._activeGen) this.setData({ myActive: res.data })
  },

  async loadPool(page = 0) {
    // 代次控制:刷新/切品类会作废在途的旧响应,晚到的旧分页不能覆盖新列表
    const gen = this._gen = (this._gen || 0) + 1
    this._loading = true
    // 定位与列表并行:定位权限弹窗/拒授不再串行拖住列表首屏;距离晚到后 recalcDistances 补算。
    // 拒绝过定位的会话内不再重试(myLocation 恒空曾导致每次进页都重新发起定位)
    if (!this.data.myLocation && !this._locDenied) {
      wx.getLocation({ type: 'gcj02' })
        .then(loc => {
          this.setData({ myLocation: { latitude: loc.latitude, longitude: loc.longitude } })
          this.recalcDistances()
        })
        .catch(() => { this._locDenied = true })
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
          sceneLabel: o.equipTypeName || sceneName(o.scene) || '家用', // 设备类型优先,老单回退家用/商用(费档与 grabOrder 口径一致)
          feeText: formatFee(grabFee(o.scene)),
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
        balance: res.walletBalance,
        balanceText: formatFee(res.walletBalance),
        lowBalance: res.walletBalance < 2000,
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

  // 定位晚到:补算当前列表的距离/近单标记,按现有排序键重排(与 loadPool 的映射同口径)
  recalcDistances() {
    if (this.data.state !== 'approved' || !this.data.orders.length) return
    const my = this.data.myLocation
    if (!my) return
    const orders = this.data.orders.map(o => {
      let distanceNum = 0
      if (o.location && o.location.coordinates) {
        const [lng, lat] = o.location.coordinates
        distanceNum = Number(distanceKm(my.latitude, my.longitude, lat, lng).toFixed(1))
      }
      return Object.assign(o, { distanceNum, near: distanceNum > 0 && distanceNum < 3 })
    })
    this.setData({ orders })
    this.applySort()
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
  goCategories() { wx.navigateTo({ url: '/pages/masterCategories/masterCategories' }) },
  dismissCatGap() {
    const missing = CATEGORIES.map(c => c.key).filter(k => !(this.data.master.categories || []).includes(k))
    wx.setStorageSync('catGapDismissed', missing.join(','))
    this.setData({ catGapText: '' })
  },
  goWallet() { wx.navigateTo({ url: '/pages/wallet/wallet' }) },
  goDetail(e) { wx.navigateTo({ url: `/pages/orderDetail/orderDetail?id=${e.currentTarget.dataset.id}` }) },
  callService() { wx.makePhoneCall({ phoneNumber: config.SERVICE_PHONE }) },
  // 封面必须显式给:留空则截当前页面,而订单池条目带他人地址与描述
  onShareAppMessage() {
    return {
      title: config.SHARE.recruit.title,
      path: config.SHARE.recruit.path,
      imageUrl: config.SHARE_COVER
    }
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
    const order = this.data.orders.find(o => o._id === orderId) || {}
    const sceneText = order.equipTypeName || sceneName(order.scene) || '家用'
    const feeText = formatFee(grabFee(order.scene))
    // 扣费动作先确认再下单:商用单 ¥300 不是小数,误触代价高
    const confirmed = await new Promise(resolve => {
      wx.showModal({
        title: `确认接${sceneText}单`,
        content: `接单将从钱包扣除服务费 ¥${feeText}(当前余额 ¥${this.data.balanceText}),抢不到自动退回。`,
        confirmText: '确认接单',
        cancelText: '再想想',
        success: r => resolve(!!r.confirm),
        fail: () => resolve(false)
      })
    })
    if (!confirmed) return

    this.setData({ acting: true })
    try {
      const res = await callFn('grabOrder', { orderId })
      wx.showModal({
        title: '抢单成功',
        content: `已扣接单费 ¥${formatFee(res.feeCharged)}。请尽快联系客户${res.userName ? ' ' + res.userName : ''}:${res.userPhone}`,
        confirmText: '拨打电话',
        cancelText: '查看订单',
        success: r => {
          if (r.confirm) {
            wx.makePhoneCall({ phoneNumber: res.userPhone })
          } else {
            // 接走的单会立刻从大厅消失,这里给直达详情的出口,不必绕 我的→我的接单
            wx.navigateTo({ url: `/pages/orderDetail/orderDetail?id=${orderId}` })
          }
        }
      })
    } catch (err) {
      // callFn 已 toast;余额不足再补一步引导去充值
      if (err && err.msg && err.msg.includes('余额不足')) {
        wx.showModal({
          title: '余额不足',
          content: `接${sceneText}单需 ¥${feeText},当前余额 ¥${this.data.balanceText},充值后再来接单。`,
          confirmText: '去充值',
          cancelText: '取消',
          success: r => { if (r.confirm) wx.navigateTo({ url: '/pages/wallet/wallet' }) }
        })
      }
    } finally {
      this.setData({ acting: false })
      this.loadMyActive()  // 新接的单要出现在"我接的单"里
      this.loadPool(0)     // 刷新列表同时带回最新余额
    }
  }
})
