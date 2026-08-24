const { callFn, formatTime, formatFee } = require('../../utils/util')
const config = require('../../utils/config')

// 流水类型 -> 展示文案(recharge 有 status 附注)
const LOG_TYPES = {
  grab: '接单扣费',
  refund: '抢单退回',
  recharge: '充值',
  admin_adjust: '平台调账'
}

Page({
  data: {
    balance: 0,
    balanceText: '0',
    rechargeOptions: [{ fee: 5000, text: '50' }, { fee: 10000, text: '100' }, { fee: 20000, text: '200' }, { fee: 50000, text: '500' }],
    pickedFee: 0,
    logs: [],
    page: 0,
    hasMore: false,
    loaded: false,
    acting: false,
    servicePhone: config.SERVICE_PHONE
  },

  onLoad() { this.load(true) },
  onPullDownRefresh() { this.load(true).finally(() => wx.stopPullDownRefresh()) },

  // fresh=true 重置分页从头拉
  async load(fresh) {
    const page = fresh ? 0 : this.data.page + 1
    try {
      const res = await callFn('wallet', { action: 'get', page })
      const prev = fresh ? [] : this.data.logs
      const seen = new Set(prev.map(l => l._id))
      const logs = prev.concat(res.logs.filter(l => !seen.has(l._id)).map(l => ({
        _id: l._id,
        typeText: LOG_TYPES[l.type] || '账务变动',
        // need_manual:线上退款失败落库的待补流水,cronTimeout 每小时自动补退
        statusText: l.status === 'pending' ? ' · 充值中' : (l.status === 'failed' ? ' · 未完成' : (l.status === 'need_manual' ? ' · 退款处理中' : '')),
        amount: l.amount,
        amountText: (l.amount >= 0 ? '+' : '') + formatFee(l.amount),
        remark: l.remark || '',
        timeText: formatTime(l.createdAt)
      })))
      this.setData({
        balance: res.balance,
        balanceText: formatFee(res.balance),
        logs,
        page,
        hasMore: !!res.hasMore,
        loaded: true
      })
    } catch (e) { /* 已提示;保留旧数据 */ }
  },

  loadMore() { this.load(false) },

  pickAmount(e) { this.setData({ pickedFee: Number(e.currentTarget.dataset.fee) }) },

  async recharge() {
    if (!this.data.pickedFee || this.data.acting) return
    this.setData({ acting: true })
    try {
      const res = await callFn('wallet', { action: 'recharge', amount: this.data.pickedFee })
      await new Promise((resolve, reject) => {
        wx.requestPayment({
          ...res.payment,
          success: resolve,
          fail: reject
        })
      })
      wx.showToast({ title: '支付成功', icon: 'success' })
      // 到账走 payCallback 异步回调:延迟轮询几次把余额拉平(用户也可下拉刷新)
      setTimeout(() => this.pollBalance(3), 1500)
    } catch (e) {
      // 主动取消不算错误;其他失败 callFn 已提示或 requestPayment errMsg 给明确文案
      if (e && /cancel/i.test(e.errMsg || '')) {
        wx.showToast({ title: '已取消支付,未扣款', icon: 'none' })
      } else if (!(e && e.ok === false)) {
        wx.showToast({ title: '支付未完成,可稍后在明细里核对', icon: 'none' })
      }
    } finally {
      this.setData({ acting: false })
    }
  },

  // 支付回调有延迟:短轮询几次,到账即刷新(没到账不硬等,明细里能看到"充值中")
  async pollBalance(times) {
    for (let i = 0; i < times; i++) {
      await new Promise(resolve => setTimeout(resolve, 2000))
      try {
        const res = await callFn('wallet', { action: 'get', page: 0 })
        if (res.balance !== this.data.balance) return this.load(true)
      } catch (e) { return }
    }
    this.load(true) // 最后仍刷新一次:至少把"充值中"流水显示出来
  },

  callService() { wx.makePhoneCall({ phoneNumber: config.SERVICE_PHONE }) }
})
