// masterApply 页面与 QUAL_TYPES 槽位契约:
// 页面 quals 结构、WXML 槽位、必填校验全部对齐 constants.QUAL_TYPES,防三处漂移
const fs = require('fs')
const path = require('path')
const { QUAL_TYPES } = require('../miniprogram/utils/constants')

function mountApplyPage(toasts) {
  jest.resetModules()
  let cfg
  global.Page = (c) => { cfg = c }
  global.getApp = () => ({ getUser: async () => ({}), globalData: { openid: 'test-openid' } })
  global.wx = { showToast: (t) => toasts.push(t.title), navigateTo() {}, navigateBack() {} }
  require('../miniprogram/pages/masterApply/masterApply')
  const inst = Object.create(cfg)
  inst.data = JSON.parse(JSON.stringify(cfg.data))
  inst.setData = function (patch) { Object.assign(this.data, patch) }
  return inst
}
afterEach(() => { delete global.Page; delete global.getApp; delete global.wx })

const KEYS = QUAL_TYPES.map(t => t.key).sort()

describe('槽位结构契约', () => {
  test('页面 data.quals 的键集合 == QUAL_TYPES 的 key 集合', () => {
    const page = mountApplyPage([])
    expect(Object.keys(page.data.quals).sort()).toEqual(KEYS)
  })

  test('WXML 里出现的 data-slot 都是合法槽位 key', () => {
    const wxml = fs.readFileSync(
      path.join(__dirname, '..', 'miniprogram', 'pages', 'masterApply', 'masterApply.wxml'), 'utf8')
    const slots = [...wxml.matchAll(/data-slot="(\w+)"/g)].map(m => m[1])
    expect(slots.length).toBeGreaterThan(0)
    for (const s of slots) expect(KEYS).toContain(s)
  })
})

describe('必填校验由 QUAL_TYPES.required 驱动', () => {
  function filledForm(page) {
    page.data.form = {
      realName: '李师傅', phone: '13800138000', serviceCity: '广州市',
      categories: ['repair'], intro: '', companyName: ''
    }
    page.data.agreed = true
  }

  test('必填槽位逐个缺失时,按 QUAL_TYPES 顺序提示对应 label', async () => {
    const required = QUAL_TYPES.filter(t => t.required)
    expect(required.length).toBeGreaterThan(0) // 至少身份证两面

    const toasts = []
    const page = mountApplyPage(toasts)
    filledForm(page)
    for (const t of required) {
      await page.submit()
      expect(toasts[toasts.length - 1]).toBe(`请上传${t.label}`)
      page.data.quals[t.key] = 'wxfile://tmp-' + t.key // 补上当前槽位,下一轮应提示下一个必填项
    }
  })

  test('必填槽位齐了以后,不再因资质材料被拦(走到协议校验之后)', async () => {
    const toasts = []
    const page = mountApplyPage(toasts)
    filledForm(page)
    for (const t of QUAL_TYPES.filter(t => t.required)) page.data.quals[t.key] = 'wxfile://tmp'
    page.data.agreed = false
    await page.submit()
    expect(toasts[toasts.length - 1]).toBe('请先阅读并同意入驻协议')
  })
})
