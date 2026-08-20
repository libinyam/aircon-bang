const { CATEGORIES, QUAL_TYPES, qualTypeLabel } = require('../../utils/constants')
const { parseCity, isValidPhone, callFn, imageExt } = require('../../utils/util')
const config = require('../../utils/config')

Page({
  data: {
    categories: CATEGORIES,
    recruitNotice: config.RECRUIT_NOTICE || '',
    // 品类选中态字典:WXML 里用数据路径 catOn[key] 取值——模板表达式不支持调 indexOf 等方法,真机会渲染失败
    catOn: {},
    // 资质材料分槽位收集:身份证两面必传,证书/执照选填(与 applyMaster 的字段一一对应)
    quals: { idFront: '', idBack: '', cert: [], bizLicense: '' },
    form: { realName: '', phone: '', serviceCity: '', categories: [], intro: '', companyName: '' },
    agreed: false,
    submitting: false
  },

  async onLoad() {
    // 被驳回后重新申请:回填旧资料
    const g = await getApp().getUser()
    // 登录失败时旧资料回填不了,提交也会失败,先让用户重试
    if (g.loginError) {
      wx.showModal({
        title: '登录失败',
        content: '网络异常,请重试后再填写入驻资料',
        confirmText: '重试',
        cancelText: '返回',
        success: r => { if (r.confirm) this.onLoad(); else wx.navigateBack() }
      })
      return
    }
    const m = g.master
    if (m && m.status === 'rejected') {
      const catOn = {}
      for (const k of (m.categories || [])) catOn[k] = true
      this.setData({
        catOn,
        form: {
          realName: m.realName, phone: m.phone, serviceCity: m.serviceCity,
          categories: m.categories || [], intro: m.intro || '', companyName: m.companyName || ''
        }
      })
      if (m.rejectReason) {
        wx.showModal({ title: '上次未通过原因', content: m.rejectReason, showCancel: false })
      }
    }
  },

  onInput(e) { this.setData({ [`form.${e.currentTarget.dataset.field}`]: e.detail.value }) },

  toggleCategory(e) {
    const key = e.currentTarget.dataset.key
    const list = this.data.form.categories.slice()
    const i = list.indexOf(key)
    if (i > -1) list.splice(i, 1); else list.push(key)
    // form.categories 是提交用的唯一源,catOn 只服务高亮渲染,两处同步写
    this.setData({ 'form.categories': list, [`catOn.${key}`]: i === -1 })
  },

  autoCity() {
    wx.chooseLocation({
      success: res => {
        const city = parseCity(res.address)
        if (city) this.setData({ 'form.serviceCity': city })
        else wx.showToast({ title: '未识别到城市,请手动填写', icon: 'none' })
      }
    })
  },

  // 单张槽位(身份证两面/营业执照):点选即替换,右上删除按钮移除
  pickSingle(e) {
    const slot = e.currentTarget.dataset.slot
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: res => this.setData({ [`quals.${slot}`]: res.tempFiles[0].tempFilePath }),
      fail: this.onPickFail
    })
  },
  removeSingle(e) { this.setData({ [`quals.${e.currentTarget.dataset.slot}`]: '' }) },

  addCert() {
    wx.chooseMedia({
      count: 3 - this.data.quals.cert.length,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: res => {
        this.setData({ 'quals.cert': this.data.quals.cert.concat(res.tempFiles.map(f => f.tempFilePath)) })
      },
      fail: this.onPickFail
    })
  },

  // chooseMedia 用户主动取消也走 fail(errMsg 含 cancel),不提示;权限被拒等真实失败给出指引
  onPickFail(err) {
    if (/cancel/i.test((err && err.errMsg) || '')) return
    wx.showToast({ title: '无法打开相册/相机,请检查小程序权限设置', icon: 'none' })
  },
  removeCert(e) {
    const list = this.data.quals.cert.slice()
    list.splice(e.currentTarget.dataset.index, 1)
    this.setData({ 'quals.cert': list })
  },

  toggleAgree() { this.setData({ agreed: !this.data.agreed }) },
  viewAgreement() { wx.navigateTo({ url: '/pages/agreement/agreement?type=master' }) },

  async uploadQual(openid, slotLabel, tempPath) {
    try {
      const up = await wx.cloud.uploadFile({
        cloudPath: `quals/${openid}/${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${imageExt(tempPath)}`,
        filePath: tempPath
      })
      return up.fileID
    } catch (err) {
      wx.showToast({ title: `${slotLabel}上传失败,请重试`, icon: 'none' })
      throw err
    }
  },

  async submit() {
    const f = this.data.form
    const q = this.data.quals
    if (!f.realName || f.realName.trim().length < 2) return wx.showToast({ title: '请填写真实姓名', icon: 'none' })
    if (!isValidPhone(f.phone)) return wx.showToast({ title: '请填写正确的手机号', icon: 'none' })
    if (!f.serviceCity.trim()) return wx.showToast({ title: '请填写服务城市', icon: 'none' })
    if (!f.categories.length) return wx.showToast({ title: '请选择服务能力', icon: 'none' })
    // 必填槽位由 QUAL_TYPES 驱动,增删槽位/改必填只动 constants.js
    for (const t of QUAL_TYPES) {
      if (t.required && !q[t.key]) return wx.showToast({ title: `请上传${t.label}`, icon: 'none' })
    }
    if (!this.data.agreed) return wx.showToast({ title: '请先阅读并同意入驻协议', icon: 'none' })

    this.setData({ submitting: true })
    try {
      const openid = getApp().globalData.openid
      if (!openid) {
        wx.showToast({ title: '登录异常,请重启小程序', icon: 'none' })
        throw new Error('未登录')
      }
      // 各槽位上传相互独立,并行执行缩短提交等待;任一失败即中止(uploadQual 内已按槽位 toast)
      // certList/hasLicense 先快照:结果按 uploadTasks 构建顺序对位取值,不受上传期间用户增删影响
      const certList = q.cert.slice()
      const hasLicense = !!q.bizLicense
      // 记录已成功的 fileID:部分失败中止时删掉已传成功的,避免云存储孤儿文件
      const uploaded = []
      const track = p => p.then(fileID => { uploaded.push(fileID); return fileID })
      const uploadTasks = [
        track(this.uploadQual(openid, qualTypeLabel('idFront'), q.idFront)),
        track(this.uploadQual(openid, qualTypeLabel('idBack'), q.idBack)),
        ...certList.map((p, i) => track(this.uploadQual(openid, `第${i + 1}张${qualTypeLabel('cert')}`, p)))
      ]
      if (hasLicense) uploadTasks.push(track(this.uploadQual(openid, qualTypeLabel('bizLicense'), q.bizLicense)))
      let results
      try {
        results = await Promise.all(uploadTasks)
      } catch (err) {
        // 等剩余任务落定后再清理,防止清理时还有槽位正在上传
        await Promise.all(uploadTasks.map(p => p.catch(() => {})))
        if (uploaded.length) {
          // 先登记再删:本地删除静默失败时,cronTimeout 还能按登记清单兜底清理
          wx.cloud.callFunction({ name: 'registerUpload', data: { scene: 'qual', fileIDs: uploaded } }).catch(() => {})
          wx.cloud.deleteFile({ fileList: uploaded }).catch(() => {})
        }
        throw err
      }
      // 上传登记:后续 applyMaster 提交失败/放弃时由 cronTimeout 清理孤儿文件;
      // 登记尽力而为,失败不阻断提交
      wx.cloud.callFunction({ name: 'registerUpload', data: { scene: 'qual', fileIDs: results } }).catch(() => {})
      const idCardFront = results[0]
      const idCardBack = results[1]
      const certPhotos = results.slice(2, 2 + certList.length)
      const bizLicensePhoto = hasLicense ? results[results.length - 1] : ''

      await callFn('applyMaster', {
        realName: f.realName,
        phone: f.phone,
        serviceCity: f.serviceCity,
        categories: f.categories,
        intro: f.intro,
        companyName: f.companyName,
        idCardFront,
        idCardBack,
        certPhotos,
        bizLicensePhoto
      })

      await getApp().getUser(true)
      wx.showToast({ title: '提交成功,等待审核', icon: 'success' })
      setTimeout(() => wx.switchTab({ url: '/pages/pool/pool' }), 900)
    } catch (e) { /* 已提示 */ } finally {
      this.setData({ submitting: false })
    }
  }
})
