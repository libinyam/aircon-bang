// 自定义 tabBar:为了给 tab 配 SVG 图标(原生 tabBar 只认 PNG 文件)
// 各 tab 页面 onShow 里调用 this.getTabBar().setData({ selected: n }) 同步选中态
Component({
  data: {
    selected: 0,
    isApprovedMaster: false,
    list: [
      { pagePath: '/pages/index/index', text: '首页', icon: 'ic-tab-home' },
      { pagePath: '/pages/market/market', text: '买空调', icon: 'ic-tab-shop' },
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
    async syncRole() {
      const g = await getApp().getUser()
      const isApprovedMaster = !!(g.master && g.master.status === 'approved')
      const list = this.data.list.map(item => item.roleEntry
        ? Object.assign({}, item, { text: isApprovedMaster ? '接单大厅' : '师傅入驻' })
        : item)
      this.setData({ isApprovedMaster, list })
    },
    switchTab(e) {
      const { index, path } = e.currentTarget.dataset
      if (index === this.data.selected) return
      if (path === '/pages/pool/pool' && !this.data.isApprovedMaster) {
        wx.navigateTo({ url: '/pages/masterApply/masterApply' })
        return
      }
      wx.switchTab({ url: path })
    }
  }
})
