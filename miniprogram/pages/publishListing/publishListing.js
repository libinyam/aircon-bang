// 发布空调商品(买空调频道):仅审核通过的师傅可用,onShow 资格闸引导入驻
// 提交幂等:onLoad 生成 requestId,云函数成功但客户端超时重试不会重复上架
const { CONDITIONS, UNIT_TYPES, HP_OPTIONS, USED_GRADES, USED_YEARS, BRAND_SUGGESTS } = require('../../utils/constants')
const { callFn, imageExt } = require('../../utils/util')

Page({
  data: {
    conditions: CONDITIONS,
    unitTypes: UNIT_TYPES,
    hpOptions: HP_OPTIONS,
    usedGrades: USED_GRADES,
    usedYearsList: USED_YEARS,
    brands: BRAND_SUGGESTS,
    photos: [],          // 本地临时路径,提交时统一上传
    form: {
      condition: '', unitType: '', hp: '', usedGrade: '', usedYears: '',
      brand: '', title: '', desc: '', price: ''
    },
    submitting: false
  },

  onLoad() {
    // 发布幂等标识:同一次表单会话固定,服务端以 hash(openid+requestId) 作商品 _id
    this._requestId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
  },

  async onShow() {
    // 资格闸:非审核通过的师傅引导入驻后返回(服务端有同样校验,这里是体验层)
    const g = await getApp().getUser()
    if (g.loginError) return
    const m = g.master
    if (m && m.status === 'approved') return
    const content = !m
      ? '发布空调商品需要先入驻并通过师傅审核,现在去申请入驻?'
 : (m.status === 'pending' ? '你的入驻申请正在审核中,通过后即可发布商品' : '入驻申请未通过,请修改资料重新申请后再发布商品')
    wx.showModal({
      title: '仅认证师傅可发布',
      content,
      confirmText: !m || m.status === 'rejected' ? '去入驻' : '知道了',
      showCancel: !m || m.status === 'rejected',
      success: (r) => {
        if (r.confirm && (!m || m.status === 'rejected')) {
          wx.navigateTo({ url: '/pages/masterApply/masterApply' })
        } else {
          wx.navigateBack()
        }
      }
    })
  },

  // 通用磁贴/chip 选择:data-field + data-key 动态 key
  pickOpt(e) {
    const { field, key } = e.currentTarget.dataset
    this.setData({ [`form.${field}`]: key })
  },
  pickBrand(e) { this.setData({ 'form.brand': e.currentTarget.dataset.b }) },
  onInput(e) { this.setData({ [`form.${e.currentTarget.dataset.field}`]: e.detail.value }) },

  addPhoto() {
    wx.chooseMedia({
      count: 6 - this.data.photos.length,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: res => {
        this.setData({ photos: this.data.photos.concat(res.tempFiles.map(f => f.tempFilePath)) })
      }
    })
  },
  previewPhoto(e) {
    wx.previewImage({ current: e.currentTarget.dataset.src, urls: this.data.photos })
  },
  removePhoto(e) {
    const idx = e.currentTarget.dataset.idx
    const photos = this.data.photos.slice()
    photos.splice(idx, 1)
    this.setData({ photos })
    wx.showToast({ title: '已移除该照片', icon: 'none' })
  },

  async submit() {
    const f = this.data.form
    if (!f.condition) return wx.showToast({ title: '请选择新机或二手机', icon: 'none' })
    if (f.condition === 'used' && !f.usedGrade) return wx.showToast({ title: '请选择成色', icon: 'none' })
    if (f.condition === 'used' && !f.usedYears) return wx.showToast({ title: '请选择使用年限', icon: 'none' })
    if (!f.unitType) return wx.showToast({ title: '请选择机型', icon: 'none' })
    if (!f.hp) return wx.showToast({ title: '请选择匹数', icon: 'none' })
    if (!f.brand.trim()) return wx.showToast({ title: '请填写品牌', icon: 'none' })
    if (f.title.trim().length < 4) return wx.showToast({ title: '标题至少4个字', icon: 'none' })
    if (f.desc.trim().length < 10) return wx.showToast({ title: '请描述商品情况(至少10个字)', icon: 'none' })
    if (!/^\d+$/.test(f.price.trim()) || Number(f.price) < 1 || Number(f.price) > 99999) {
      return wx.showToast({ title: '价格需为 1-99999 的整数(元)', icon: 'none' })
    }
    if (!this.data.photos.length) return wx.showToast({ title: '请至少上传1张商品照片', icon: 'none' })
    // 软提醒:照片少于3张不拦截,但给一次补拍机会(封面质量直接影响联系率)
    if (this.data.photos.length < 3) {
      const go = await new Promise(resolve => {
        wx.showModal({
          title: '照片有点少',
          content: `只传了${this.data.photos.length}张。建议至少3张:正面整机、铭牌/能效标识、细节或瑕疵处,买家更敢联系你。仍要发布吗?`,
          confirmText: '继续发布',
          cancelText: '再拍几张',
          success: r => resolve(r.confirm)
        })
      })
      if (!go) return
    }

    this.setData({ submitting: true })
    try {
      const openid = getApp().globalData.openid
      if (!openid) {
        wx.showToast({ title: '登录异常,请重启小程序', icon: 'none' })
        throw new Error('未登录')
      }
      // 串行上传(路径带 openid 命名空间+随机段,服务端据此校验归属)
      const fileIDs = []
      try {
        for (let i = 0; i < this.data.photos.length; i++) {
          try {
            const up = await wx.cloud.uploadFile({
              cloudPath: `listings/${openid}/${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}.${imageExt(this.data.photos[i])}`,
              filePath: this.data.photos[i]
            })
            fileIDs.push(up.fileID)
          } catch (err) {
            wx.showToast({ title: `第${i + 1}张照片上传失败,请重试`, icon: 'none' })
            throw err
          }
        }
      } finally {
        // 上传登记必须在 finally 里(评审):上传到一半失败的文件也要进孤儿清理;
        // 登记本身尽力而为,失败不阻断发布
        if (fileIDs.length) {
          wx.cloud.callFunction({ name: 'registerUpload', data: { scene: 'listing', fileIDs } }).catch(() => {})
        }
      }

      const res = await callFn('publishListing', {
        requestId: this._requestId,
        condition: f.condition,
        unitType: f.unitType,
        hp: f.hp,
        usedGrade: f.usedGrade,
        usedYears: f.usedYears,
        brand: f.brand.trim(),
        title: f.title.trim(),
        desc: f.desc.trim(),
        priceYuan: Number(f.price),
        photos: fileIDs
      })

      wx.showToast({ title: '发布成功', icon: 'success' })
      setTimeout(() => {
        wx.redirectTo({ url: `/pages/listingDetail/listingDetail?id=${res.listingId}` })
      }, 800)
    } catch (e) {
      // callFn 已弹过错误提示
    } finally {
      this.setData({ submitting: false })
    }
  }
})
