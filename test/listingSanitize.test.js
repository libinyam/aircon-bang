// getListings 白名单隐私回归(买空调频道,机制照抄 sanitize.test.js):
// 商品可能携带的每一个字段都必须被显式分类进四层白名单或 HIDDEN——
// publishListing 新增写入字段、流转新增字段而没在这里表态,测试直接失败,强迫显式决策
const fs = require('fs')
const path = require('path')
const { pick, LIST_FIELDS, OWNER_LIST_FIELDS, DETAIL_PUBLIC_FIELDS, DETAIL_OWNER_FIELDS } =
  require('../cloudfunctions/getListings/index')._internals

// ---- 已知字段全集 ----
// 1) 发布时写入的字段:从 publishListing 源码的 listing 对象字面量 + listing.xxx = 补写解析
function publishListingFields() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'cloudfunctions', 'publishListing', 'index.js'), 'utf8')
  const m = src.match(/const listing = \{([\s\S]*?)\n {2}\}/)
  if (!m) throw new Error('publishListing 里找不到 const listing = {...},解析器需要更新')
  const keys = []
  for (const line of m[1].split('\n')) {
    const km = line.match(/^\s{4}(\w+)[,:]/)
    if (km) keys.push(km[1])
  }
  let am
  const assignRe = /listing\.(\w+) = /g
  while ((am = assignRe.exec(src))) keys.push(am[1])
  if (keys.length < 10) throw new Error('listing 字段解析异常:' + keys.join(','))
  return keys
}
// 2) 后续流转追加的字段(updateListing/admin/mediaApply)
const POST_PUBLISH_FIELDS = [
  'updatedAt',
  'offShelfAt', 'offShelfReason',            // offShelf / 系统下架(摘图清零、资格变更)
  'relistedAt',                              // onShelf
  'soldAt',                                  // markSold
  'removedAt', 'removedReason', 'removedBy'  // admin.takedownListing
]

// ---- 隐私决策清单:任何 getListings 响应都不可见的字段 ----
// 新字段默认进这里;确认无害且需要展示,才移入对应白名单表态
const HIDDEN_FROM_CLIENT = [
  'sellerOpenid',   // 卖家身份标识,isOwner 由服务端判定后下发布尔
  'cityKey',        // 城市匹配键,内部用,展示走 cityName
  'deleting',       // 删除瞬态标记,内部竞态防线
  'removedBy'       // 管理员 openid,仅 admin.listListings 可见,卖家只看 removedReason
]

const ALL_FIELDS = [...new Set([...publishListingFields(), ...POST_PUBLISH_FIELDS])]

const FULL_LISTING = {}
for (const k of ALL_FIELDS) FULL_LISTING[k] = 'SENTINEL_' + k
FULL_LISTING._id = 'l1'
FULL_LISTING.photos = ['cloud://x/listings/m1/a.jpg']

describe('字段分类完备性(新增商品字段必须显式表态)', () => {
  const WHITELISTED = new Set([...LIST_FIELDS, ...OWNER_LIST_FIELDS, ...DETAIL_PUBLIC_FIELDS, ...DETAIL_OWNER_FIELDS])

  test('每个已知字段都被分类:四层白名单 ∪ HIDDEN_FROM_CLIENT', () => {
    const classified = new Set([...WHITELISTED, ...HIDDEN_FROM_CLIENT])
    const unclassified = ALL_FIELDS.filter(k => !classified.has(k))
    expect(unclassified).toEqual([])
  })

  test('HIDDEN 字段不出现在任何一层白名单', () => {
    for (const k of HIDDEN_FROM_CLIENT) expect(WHITELISTED.has(k)).toBe(false)
  })

  test('电话与姓名快照根本不该落库(评审:phone 走 contact 实时取)', () => {
    const published = publishListingFields()
    expect(published).not.toContain('sellerPhone')
    expect(published).not.toContain('sellerName')
    for (const list of [LIST_FIELDS, OWNER_LIST_FIELDS, DETAIL_PUBLIC_FIELDS, DETAIL_OWNER_FIELDS]) {
      expect(list).not.toContain('sellerPhone')
      expect(list).not.toContain('sellerName')
    }
  })

  // avatarPhoto 是 masters 档案字段不是商品字段;详情页的卖家头像与 sellerVerified 同口径,
  // 由 getListings.detail 实时派生+换链成 sellerAvatar 顶层字段下发,不进商品白名单
  test('师傅展示头像不落商品文档,不进任何一层商品白名单', () => {
    const published = publishListingFields()
    expect(published).not.toContain('avatarPhoto')
    for (const list of [LIST_FIELDS, OWNER_LIST_FIELDS, DETAIL_PUBLIC_FIELDS, DETAIL_OWNER_FIELDS]) {
      expect(list).not.toContain('avatarPhoto')
    }
  })

  test('白名单层级关系:LIST ⊆ OWNER_LIST 与 DETAIL_PUBLIC ⊆ DETAIL_OWNER', () => {
    for (const k of LIST_FIELDS) {
      expect(OWNER_LIST_FIELDS).toContain(k)
      expect(DETAIL_PUBLIC_FIELDS).toContain(k)
    }
    for (const k of DETAIL_PUBLIC_FIELDS) expect(DETAIL_OWNER_FIELDS).toContain(k)
  })

  test('市场列表不含详情正文与原始照片数组(cover 单字段另行下发)', () => {
    for (const k of ['desc', 'photos', 'listingNo', 'sellerDisplayName', 'status']) {
      expect(LIST_FIELDS).not.toContain(k)
    }
  })
})

describe('pick 白名单行为(哨兵防夹带)', () => {
  test('HIDDEN 字段在四层输出里一个都不出现', () => {
    for (const fields of [LIST_FIELDS, OWNER_LIST_FIELDS, DETAIL_PUBLIC_FIELDS, DETAIL_OWNER_FIELDS]) {
      const json = JSON.stringify(pick(FULL_LISTING, fields))
      for (const k of HIDDEN_FROM_CLIENT) expect(json).not.toContain('SENTINEL_' + k)
    }
  })

  test('产出字段 ⊆ 对应白名单;缺失字段不产出 undefined 键', () => {
    const out = pick(FULL_LISTING, DETAIL_OWNER_FIELDS)
    for (const k of Object.keys(out)) expect(DETAIL_OWNER_FIELDS).toContain(k)
    const sparse = pick({ _id: 'l2', title: 't' }, LIST_FIELDS)
    expect(Object.keys(sparse).sort()).toEqual(['_id', 'title'])
  })

  test('卖家在 OWNER 层能看到系统下架/违规原因', () => {
    const out = pick(FULL_LISTING, DETAIL_OWNER_FIELDS)
    expect(out.offShelfReason).toBe('SENTINEL_offShelfReason')
    expect(out.removedReason).toBe('SENTINEL_removedReason')
    expect(out).not.toHaveProperty('removedBy')
  })
})
