const { ORDER_STATUS, MASTER_STATUS, LISTING_STATUS, LISTING_STATUS_MAP, categoryName, qualTypeLabel } = require('../../utils/constants')
const { formatTime, callFn, formatFee } = require('../../utils/util')

Page({
  data: {
    tabs: [
      { key: 'pending', label: '待审核' },
      { key: 'masters', label: '师傅' },
      { key: 'orders', label: '订单' },
      { key: 'listings', label: '商品' },
      { key: 'complaints', label: '投诉' },
      { key: 'deletions', label: '删号' }
    ],
    tab: 'pending',
    masters: [],
    orders: [],
    listings: [],
    complaints: [],
    deletions: [],
    orderPage: 0,
    listingPage: 0,
    listingHasMore: false,
    statusMap: ORDER_STATUS,
    masterStatusMap: MASTER_STATUS,
    listingStatusMap: LISTING_STATUS_MAP,
    loaded: false,
    loadError: false,
    acting: false,
    health: null,
    // 钱包调账弹层(接单费制):正数加款(线下收款入账),负数减款(退款/调平)
    wallet: { show: false, id: '', name: '', balanceText: '--', amount: '', note: '', requestId: '' }
  },

  async onShow() {
    const g = await getApp().getUser()
    // 登录失败 ≠ 无权限:给重试,别把管理员误劝退
    if (g.loginError) {
      wx.showModal({
        title: '登录失败',
        content: '网络异常,暂时无法确认管理员身份',
        confirmText: '重试',
        cancelText: '返回',
        success: r => { if (r.confirm) this.onShow(); else wx.navigateBack() }
      })
      return
    }
    if (!g.isAdmin) {
      wx.showToast({ title: '无管理权限', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 900)
      return
    }
    this.load()
    this.loadHealth()
  },

  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()) },
  switchTab(e) { this.setData({ tab: e.currentTarget.dataset.key, loaded: false }, () => this.load()) },

  async load() {
    const tab = this.data.tab
    try {
      if (tab === 'pending' || tab === 'masters') {
        const res = await callFn('admin', { action: tab === 'pending' ? 'pendingMasters' : 'allMasters' })
        const masters = res.data.map(m => Object.assign(m, {
          categoryNames: (m.categories || []).map(categoryName).join(' / '),
          walletBalanceText: formatFee(m.walletBalance || 0),
          // 新申请带 qualTypes 平行标注:审核时能分清人像面/国徽面/证书/执照;老数据回退无标签九宫格
          qualLabeled: (Array.isArray(m.qualTypes) && m.qualTypes.length && Array.isArray(m.qualPhotos) && m.qualTypes.length === m.qualPhotos.length)
            ? m.qualPhotos.map((url, i) => ({ url, label: qualTypeLabel(m.qualTypes[i]) }))
 : null
        }))
        this.setData({ masters, loaded: true })
      } else if (tab === 'orders') {
        const res = await callFn('admin', { action: 'orders', page: 0 })
        this.setData({
          orders: res.data.map(o => Object.assign(o, { publishedAtText: formatTime(o.publishedAt) })),
          orderPage: 0,
          loaded: true
        })
      } else if (tab === 'listings') {
        const res = await callFn('admin', { action: 'listListings', page: 0 })
        this.setData({
          listings: res.data.map(this.mapListing),
          listingPage: 0,
          listingHasMore: !!res.hasMore,
          loaded: true
        })
      } else if (tab === 'deletions') {
        const res = await callFn('admin', { action: 'deletionRequests' })
        const DELETION_STATUS = { open: '待执行', pending_retry: '部分失败待重试', executed: '已执行待关闭', closed: '已完成' }
        this.setData({
          deletions: res.data.map(d => Object.assign(d, {
            createdAtText: formatTime(d.createdAt),
            openidTail: (d.openid || '').slice(-6),
            statusText: DELETION_STATUS[d.status] || d.status,
            lastBlockers: d.lastBlockers || [],
            failedFiles: d.failedFiles || [],
            blockersText: (d.lastBlockers || []).join(';')
          })),
          loaded: true
        })
      } else {
        const res = await callFn('admin', { action: 'complaints' })
        // 投诉与商品举报同集合,按 targetType 分渲染(老记录无 targetType,按订单投诉兜底)
        this.setData({
          complaints: res.data.map(c => Object.assign(c, {
            titleText: c.targetType === 'listing'
              ? '商品举报 · ' + (c.listingNo || '')
 : '单号 ' + (c.orderNo || '') + ' · ' + (c.fromRole === 'user' ? '用户' : '师傅') + '投诉',
            subText: c.targetType === 'listing' ? (c.listingTitle || '') : ''
          })),
          loaded: true
        })
      }
      this.setData({ loadError: false })
    } catch (e) {
      this.setData({ loaded: true, loadError: true })
    }
  },

  // 运营体检:定时器活着没有 + 各类积压,顶部一眼可见
  async loadHealth() {
    try {
      const h = await callFn('admin', { action: 'health' })
      this.setData({ health: h })
    } catch (e) { /* 体检失败不阻塞后台使用,已有 toast */ }
  },

  async moreOrders() {
    try {
      const page = this.data.orderPage + 1
      const res = await callFn('admin', { action: 'orders', page })
      this.setData({
        orders: this.data.orders.concat(res.data.map(o => Object.assign(o, { publishedAtText: formatTime(o.publishedAt) }))),
        orderPage: page
      })
    } catch (e) { /* callFn 已提示,保留已有列表 */ }
  },

  mapListing(l) {
    const st = LISTING_STATUS_MAP[l.status] || { label: l.status, color: '#667180' }
    return Object.assign(l, {
      statusLabel: st.label,
      statusColor: st.color,
      createdAtText: formatTime(l.createdAt),
      canTakedown: l.status === LISTING_STATUS.ON_SALE || l.status === LISTING_STATUS.OFF_SHELF
    })
  },

  async moreListings() {
    try {
      const page = this.data.listingPage + 1
      const res = await callFn('admin', { action: 'listListings', page })
      this.setData({
        listings: this.data.listings.concat(res.data.map(this.mapListing)),
        listingPage: page,
        listingHasMore: !!res.hasMore
      })
    } catch (e) { /* callFn 已提示,保留已有列表 */ }
  },

  // 强制下架违规商品:原因必填,会展示给卖家
  takedownListing(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '强制下架原因',
      editable: true,
      placeholderText: '将展示给卖家,如:涉嫌虚假信息',
      confirmText: '强制下架',
      confirmColor: '#CE3F36',
      success: async r => {
        if (!r.confirm) return
        try {
          await callFn('admin', { action: 'takedownListing', listingId: id, reason: r.content || '' })
          wx.showToast({ title: '已下架', icon: 'none' })
          this.load()
        } catch (e) { /* 已提示 */ }
      }
    })
  },

  // 撤销已通过的师傅资格(与审核驳回是两个动作):撤销后其在售商品自动批量下架
  revokeMaster(e) {
    const { id, name } = e.currentTarget.dataset
    wx.showModal({
      title: `撤销 ${name} 的师傅资格?`,
      editable: true,
      placeholderText: '撤销原因(将展示给师傅)',
      confirmText: '确认撤销',
      confirmColor: '#CE3F36',
      success: async r => {
        if (!r.confirm) return
        try {
          const res = await callFn('admin', { action: 'revokeMaster', masterId: id, reason: r.content || '' })
          if (res.partial) {
            wx.showModal({
              title: '资格已撤销,但商品批量下架失败',
              content: '请在该师傅卡片上点「重试下架商品」完成收尾',
              showCancel: false
            })
          } else {
            wx.showToast({ title: `已撤销,下架商品 ${res.listingsOffShelf || 0} 件`, icon: 'none' })
          }
          this.load()
        } catch (e) { /* 已提示 */ }
      }
    })
  },

  // 资格联动失败的幂等补偿(依据 master 文档上的持久化标志,不靠一次性返回值)
  async retryListingSync(e) {
    const id = e.currentTarget.dataset.id
    try {
      const res = await callFn('admin', { action: 'offShelfSellerListings', masterId: id })
      wx.showToast({ title: `已下架 ${res.listingsOffShelf || 0} 件`, icon: 'none' })
      this.load()
    } catch (e) { /* 已提示 */ }
  },

  previewQual(e) {
    wx.previewImage({ current: e.currentTarget.dataset.src, urls: e.currentTarget.dataset.list })
  },

  audit(e) {
    const { id, pass } = e.currentTarget.dataset
    if (pass) {
      wx.showModal({
        title: '通过入驻申请?',
        content: '通过后师傅给钱包充值即可接单(家用 ¥20/单 · 商用 ¥300/单)',
        success: async r => {
          if (!r.confirm) return
          try {
            await callFn('admin', { action: 'auditMaster', masterId: id, pass: true })
            wx.showToast({ title: '已通过', icon: 'success' })
            this.load()
          } catch (e) { /* 已提示 */ }
        }
      })
    } else {
      wx.showModal({
        title: '驳回原因',
        editable: true,
        placeholderText: '将展示给申请人',
        success: async r => {
          if (!r.confirm) return
          try {
            await callFn('admin', { action: 'auditMaster', masterId: id, pass: false, reason: r.content || '' })
            wx.showToast({ title: '已驳回', icon: 'none' })
            this.load()
          } catch (e) { /* 已提示 */ }
        }
      })
    }
  },

  noop() {},
  openWallet(e) {
    const { id, name } = e.currentTarget.dataset
    // 每次打开弹窗生成新的幂等键;同一弹窗内重复点确认只会成功一次
    const requestId = 'w' + Date.now() + Math.random().toString(36).slice(2, 8)
    this.setData({ wallet: { show: true, id, name, balanceText: '--', amount: '', note: '', requestId } })
    // 实时查余额做底数(列表数据可能已过期)
    callFn('admin', { action: 'walletQuery', openid: id })
      .then(res => this.setData({ 'wallet.balanceText': formatFee(res.balance) }))
      .catch(() => { /* 已提示,保持 -- */ })
  },
  closeWallet() { this.setData({ 'wallet.show': false }) },
  onWalletAmount(e) { this.setData({ 'wallet.amount': e.detail.value }) },
  onWalletNote(e) { this.setData({ 'wallet.note': e.detail.value }) },

  async doAdjust() {
    const w = this.data.wallet
    const amt = Number(w.amount)
    if (!isFinite(amt) || amt === 0) return wx.showToast({ title: '请填写非零金额(正数加款/负数减款)', icon: 'none' })
    this.setData({ acting: true })
    try {
      const res = await callFn('admin', {
        action: 'walletAdjust',
        openid: w.id, amountYuan: w.amount, remark: w.note, requestId: w.requestId
      })
      wx.showToast({ title: '已调账,余额 ¥' + formatFee(res.balance), icon: 'none' })
      this.closeWallet()
      this.load()
    } catch (e) { /* 已提示 */ } finally { this.setData({ acting: false }) }
  },

  async handleComplaint(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '处理记录',
      editable: true,
      placeholderText: '例:已电话协调双方,退还部分费用',
      success: async r => {
        if (!r.confirm) return
        try {
          await callFn('admin', { action: 'handleComplaint', complaintId: id, note: r.content || '' })
          wx.showToast({ title: '已处理', icon: 'success' })
          this.load()
        } catch (e) { /* 已提示 */ }
      }
    })
  },

  // 执行数据删除:真正删除/匿名化,有阻断项或部分失败会如实反馈
  executeDeletion(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '执行数据删除',
      content: '将删除该账号资料与照片,匿名化订单/评价等关联记录,不可恢复。确认执行?',
      success: async r => {
        if (!r.confirm) return
        try {
          const res = await callFn('admin', { action: 'executeDeletion', requestId: id })
          if (res.blocked) {
            wx.showModal({ title: '存在阻断项,暂不能执行', content: res.blockers.join('\n'), showCancel: false })
          } else if (res.partial) {
            wx.showModal({ title: '部分文件删除失败', content: res.failedCount + '个文件删除失败,已标记待重试,可稍后重试执行', showCancel: false })
          } else {
            wx.showToast({ title: '执行完成', icon: 'success' })
          }
          this.load()
          this.loadHealth()
        } catch (err) { /* 已提示 */ }
      }
    })
  },

  // 处理删除申请:处理记录必填,后台留痕可审计;服务端要求先执行成功
  handleDeletion(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '处理记录',
      editable: true,
      placeholderText: '例:已清除手机号/地址/照片,订单骨架留存',
      success: async r => {
        if (!r.confirm) return
        try {
          await callFn('admin', { action: 'handleDeletionRequest', requestId: id, note: r.content || '' })
          wx.showToast({ title: '已处理', icon: 'success' })
          this.load()
        } catch (e) { /* 已提示 */ }
      }
    })
  },

  async initDb() {
    try {
      const res = await callFn('admin', { action: 'initDb' })
      wx.showModal({
        title: '初始化完成',
        content: res.created.length ? '新建集合:' + res.created.join(', ') : '所有集合已存在',
        showCancel: false
      })
    } catch (e) { /* 已提示 */ }
  },

  // 部署自检:跑真实订单池查询,缺索引在这里暴露而不是被师傅先发现
  async smokePool() {
    try {
      const res = await callFn('admin', { action: 'smokePool' })
      wx.showModal({
        title: '订单池自检通过',
        content: `城市:${res.city}\n品类:${res.categories.join('/')}\n第一页 ${res.page1} 条,第二页 ${res.page2} 条,耗时 ${res.elapsedMs}ms` +
          (res.elapsedMs > 2000 ? '\n耗时偏高,请确认已按 README 建立 orders 复合索引' : ''),
        showCancel: false
      })
    } catch (e) { /* callFn 已用 toast 展示失败原因(含缺索引提示) */ }
  }
})
