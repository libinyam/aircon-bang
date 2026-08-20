const { CATEGORIES, SLOTS } = require('../../utils/constants')
const { parseCity, isValidPhone, callFn, formatDate, imageExt } = require('../../utils/util')
const config = require('../../utils/config')

Page({
  data: {
    categories: CATEGORIES,
    symptoms: ['不制冷', '漏水', '异响', '不开机', '遥控失灵'],
    timeSlots: SLOTS.map(s => s.label),
    today: formatDate(new Date()),
    photos: [],          // 本地临时路径,提交时统一上传
    form: {
      category: '', desc: '', address: '', addressDetail: '',
      location: null, cityName: '', date: '', slot: '', slotKey: '',
      phone: '', contactName: ''
    },
    submitting: false
  },

  async onLoad(options) {
    if (options.category) this.setData({ 'form.category': options.category })
    // 老用户回填手机号和称呼
    const g = await getApp().getUser()
    if (g.user) {
      this.setData({
        'form.phone': this.data.form.phone || g.user.phone || '',
        'form.contactName': this.data.form.contactName || g.user.contactName || ''
      })
    }
  },

  pickCategory(e) { this.setData({ 'form.category': e.currentTarget.dataset.key }) },

  // 快捷故障标签:点一下追加进描述
  addSymptom(e) {
    const s = e.currentTarget.dataset.s
    const d = this.data.form.desc
    if (d.includes(s)) return
    this.setData({ 'form.desc': d ? `${d},${s}` : s })
  },
  onInput(e) { this.setData({ [`form.${e.currentTarget.dataset.field}`]: e.detail.value }) },
  pickDate(e) { this.setData({ 'form.date': e.detail.value }) },
  pickSlot(e) {
    const s = SLOTS[Number(e.detail.value)]
    this.setData({ 'form.slot': s.label, 'form.slotKey': s.key })
  },

  addPhoto() {
    wx.chooseMedia({
      count: 6 - this.data.photos.length,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: res => {
        this.setData({ photos: this.data.photos.concat(res.tempFiles.map(f => f.tempFilePath)) })
      },
      // 用户主动取消也走 fail(errMsg 含 cancel),不提示;隐私指引未生效/权限被拒等
      // 真实失败必须有可见反馈,否则表现为"点了没反应"(对齐 masterApply.onPickFail)
      fail: err => {
        if (/cancel/i.test((err && err.errMsg) || '')) return
        wx.showToast({ title: '无法打开相册/相机,请检查小程序权限设置', icon: 'none' })
      }
    })
  },

  previewPhoto(e) {
    wx.previewImage({ current: e.currentTarget.dataset.src, urls: this.data.photos })
  },

  chooseLocation() {
    wx.chooseLocation({
      success: res => {
        const cityName = parseCity(res.address)
        this.setData({
          'form.address': res.name || res.address,
          'form.location': { latitude: res.latitude, longitude: res.longitude },
          'form.cityName': cityName
        })
        if (!cityName) wx.showToast({ title: '未识别到城市,请重选或换个地点', icon: 'none' })
      },
      fail: err => {
        if ((err.errMsg || '').includes('auth')) {
          wx.showModal({
            title: '需要位置权限',
            content: '请在设置中允许使用位置信息,以便选择上门地址',
            confirmText: '去设置',
            success: r => { if (r.confirm) wx.openSetting() }
          })
        }
      }
    })
  },

  async submit() {
    const f = this.data.form
    if (!f.category) return wx.showToast({ title: '请选择服务类型', icon: 'none' })
    if (!f.desc || f.desc.trim().length < 5) return wx.showToast({ title: '请描述故障情况(至少5个字)', icon: 'none' })
    if (!f.location) return wx.showToast({ title: '请选择上门地址', icon: 'none' })
    if (!f.date || !f.slotKey) return wx.showToast({ title: '请选择期望上门时间', icon: 'none' })
    // 选了今天但时段已结束,前端先拦一道(服务端有同样校验)
    const endHour = (SLOTS.find(s => s.key === f.slotKey) || {}).endHour || 24
    const [sy, sm, sd] = f.date.split('-').map(Number)
    if (new Date(sy, sm - 1, sd, endHour).getTime() <= Date.now()) {
      return wx.showToast({ title: '该时段已过,请重新选择', icon: 'none' })
    }
    if (!isValidPhone(f.phone)) return wx.showToast({ title: '请填写正确的手机号', icon: 'none' })

    // 订阅"被接单通知"必须在点击的同步上下文里请求(放到 await 之后真机会静默失败)
    const tmplIds = [config.TPL_ORDER_TAKEN, config.TPL_ORDER_FINISH].filter(Boolean)
    if (tmplIds.length) {
      // 发单后一并请求"接单成功"与"完成待确认"订阅:一次性模板各授权一次收一条
      wx.requestSubscribeMessage({ tmplIds, complete: () => {} })
    }

    this.setData({ submitting: true })
    try {
      // 先传照片到云存储(路径带 openid 命名空间+随机段,服务端据此校验归属且不会撞名)
      const openid = getApp().globalData.openid
      if (!openid) {
        wx.showToast({ title: '登录异常,请重启小程序', icon: 'none' })
        throw new Error('未登录')
      }
      const fileIDs = []
      try {
        for (let i = 0; i < this.data.photos.length; i++) {
          try {
            const up = await wx.cloud.uploadFile({
              cloudPath: `orders/${openid}/${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}.${imageExt(this.data.photos[i])}`,
              filePath: this.data.photos[i]
            })
            fileIDs.push(up.fileID)
          } catch (err) {
            wx.showToast({ title: `第${i + 1}张照片上传失败,请重试`, icon: 'none' })
            throw err
          }
        }
      } finally {
        // 上传登记:已传成功的 fileID 报给服务端,后续提交失败/中途放弃时
        // 由 cronTimeout 清理孤儿文件;登记本身尽力而为,失败不阻断发单
        if (fileIDs.length) {
          wx.cloud.callFunction({ name: 'registerUpload', data: { scene: 'order', fileIDs } }).catch(() => {})
        }
      }

      const res = await callFn('publishOrder', {
        category: f.category,
        desc: f.desc,
        photos: fileIDs,
        location: f.location,
        address: f.address,
        addressDetail: f.addressDetail,
        cityName: f.cityName,
        expectDate: f.date,
        slotKey: f.slotKey,
        phone: f.phone,
        contactName: f.contactName
      })

      wx.showToast({ title: '发布成功', icon: 'success' })
      setTimeout(() => {
        wx.redirectTo({ url: `/pages/orderDetail/orderDetail?id=${res.orderId}` })
      }, 800)
    } catch (e) {
      // callFn 已弹过错误提示
    } finally {
      this.setData({ submitting: false })
    }
  }
})
