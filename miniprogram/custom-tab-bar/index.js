// 自定义 tabBar:为了给 tab 配 SVG 图标(原生 tabBar 只认 PNG 文件)
// 各 tab 页面 onShow 里调用 this.getTabBar().setData({ selected: n }) 同步选中态
// 中间位是凸起发单钮(v4.1):action 项不是真 tab 页,点击 navigateTo 进发单页
Component({
  data: {
    selected: 0,
    isApprovedMaster: false,
    list: [
      { pagePath: '/pages/index/index', text: '首页', icon: 'ic-tab-home' },
      { pagePath: '/pages/market/market', text: '买空调', icon: 'ic-tab-shop' },
      { pagePath: '/pages/publish/publish', text: '发单', action: true },
      { pagePath: '/pages/pool/pool', text: '师傅入驻', icon: 'ic-tab-hall', roleEntry: true },
      { pagePath: '/pages/mine/mine', text: '我的', icon: 'ic-tab-user' }
    ]
  },
  lifetimes: {
    attached() { this.syncRole() }
  },
  pageLifetimes: {
    show() { this.syncRole() }
  },
  methods: {
    // show() 的例行同步走缓存,免得每次切 tab 都打一次 login;
    // forceRefresh 参数保留给需要现场强刷的调用方(身份复核已移到 pool 页内,#136 不回退)
    async syncRole(forceRefresh) {
      const g = await getApp().getUser(forceRefresh)
      const isApprovedMaster = !!(g.master && g.master.status === 'approved')
      const list = this.data.list.map(item => item.roleEntry
        ? Object.assign({}, item, { text: isApprovedMaster ? '接单大厅' : '师傅入驻' })
 : item)
      this.setData({ isApprovedMaster, list })
      return isApprovedMaster
    },
    switchTab(e) {
      const { index, path, action } = e.currentTarget.dataset
      if (action) return wx.navigateTo({ url: path })
      if (index === this.data.selected) return
      // 乐观切换:不在点击里 await 云调用——login 往返期间点击无任何反馈,体感"点了没反应"。
      // 旧版在这里现场强刷身份拦截非师傅,该职责移到 pool.refresh 的后台收敛:
      // 非师傅落 pool 的入驻引导态,刚通过审核的师傅由页内强刷翻转到接单大厅
      wx.switchTab({ url: path })
    }
  }
})
