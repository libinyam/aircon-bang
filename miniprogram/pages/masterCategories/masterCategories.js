const { CATEGORIES } = require('../../utils/constants')
const { callFn } = require('../../utils/util')

// 服务能力自助调整:approved 师傅补充/收缩品类,落库即生效。
// 与入驻申请分开——masterApply 只管实名资质审核,品类是师傅自声明,不走重审
Page({
  data: {
    categories: CATEGORIES,
    catOn: {},
    selected: [],
    originKey: '',     // 进入时的已选集合,没变就不调云函数
    loading: true,
    saving: false
  },

  async onLoad() {
    const g = await getApp().getUser()
    if (g.loginError) {
      wx.showModal({
        title: '登录失败',
        content: '网络异常,请重试',
        confirmText: '重试',
        cancelText: '返回',
        success: r => { if (r.confirm) this.onLoad(); else wx.navigateBack() }
      })
      return
    }
    const m = g.master
    if (!m || m.status !== 'approved') {
      wx.showToast({ title: '仅认证师傅可调整', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 800)
      return
    }
    const selected = (m.categories || []).slice()
    const catOn = {}
    for (const k of selected) catOn[k] = true
    this.setData({ catOn, selected, originKey: selected.slice().sort().join(','), loading: false })
  },

  toggleCategory(e) {
    const key = e.currentTarget.dataset.key
    const list = this.data.selected.slice()
    const i = list.indexOf(key)
    if (i > -1) list.splice(i, 1); else list.push(key)
    this.setData({ selected: list, [`catOn.${key}`]: i === -1 })
  },

  async save() {
    const cats = this.data.selected
    if (!cats.length) return wx.showToast({ title: '至少保留一项服务能力', icon: 'none' })
    if (cats.slice().sort().join(',') === this.data.originKey) return wx.navigateBack()
    this.setData({ saving: true })
    try {
      await callFn('applyMaster', { action: 'updateCategories', categories: cats })
      // 强刷身份缓存:大厅 tab/匹配立刻按新品类生效
      await getApp().getUser(true)
      wx.showToast({ title: '已更新', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 800)
    } catch (e) { /* callFn 已提示 */ } finally {
      this.setData({ saving: false })
    }
  }
})
