// getOrders sanitize 隐私回归:订单池/围观视角不泄露隐私的唯一防线
// 核心机制:订单可能携带的每一个字段都必须被显式分类为"可见"或"隐藏"——
// publishOrder 新增写入字段、或流转新增字段而没在这里表态,测试直接失败,强迫显式决策
const fs = require('fs')
const path = require('path')
const { sanitize, VIEWER_FIELDS, roundLocation } = require('../cloudfunctions/getOrders/index')._internals

// ---- 已知字段全集 ----
// 1) 发单时写入的字段:直接从 publishOrder 源码的 order 对象里解析,保证样本不脱离现实
function publishOrderFields() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'cloudfunctions', 'publishOrder', 'index.js'), 'utf8')
  const m = src.match(/const order = \{([\s\S]*?)\n {2}\}/)
  if (!m) throw new Error('publishOrder 里找不到 const order = {...},解析器需要更新')
  const keys = []
  for (const line of m[1].split('\n')) {
    const km = line.match(/^\s{4}(\w+)[,:]/)
    if (km) keys.push(km[1])
  }
  if (keys.length < 10) throw new Error('order 字段解析异常:' + keys.join(','))
  return keys
}
// 2) 后续流转追加的字段(grabOrder/finishOrder/confirmOrder/cancelOrder/cronTimeout)
const POST_PUBLISH_FIELDS = [
  'masterName', 'masterPhone', 'acceptedAt',                       // grabOrder
  'finishedAt', 'undoneAt',                                        // finishOrder(undo 撤销完成)
  'confirmedAt', 'rejectCount', 'lastRejectReason', 'lastRejectedAt', // confirmOrder
  'cancelBy', 'cancelReason', 'cancelledAt',                       // cancelOrder / cronTimeout
  'autoConfirmed',                                                 // cronTimeout
  'photosRisk',                                                    // mediaCheckCallback 违规摘图标记
  'privacyCleaned', 'privacyCleanedAt'                             // cronTimeout 隐私脱敏标记
]

// ---- 隐私决策清单:围观者(订单池/viewer)绝不可见的字段 ----
// 新字段默认进这里;确认无害且需要展示,才移入 getOrders 的 VIEWER_FIELDS
const HIDDEN_FROM_VIEWER = [
  'userOpenid', 'userPhone', 'userName',            // 用户身份与联系方式
  'masterOpenid', 'masterName', 'masterPhone',      // 师傅身份与联系方式
  'addressDetail',                                  // 门牌明细,仅订单双方可见
  'acceptedAt', 'finishedAt', 'undoneAt', 'confirmedAt', 'autoConfirmed',
  'cancelBy', 'cancelReason', 'cancelledAt',
  'rejectCount', 'lastRejectReason', 'lastRejectedAt',
  'photosRisk',                                         // 违规标记,围观者无需感知
  'privacyCleaned', 'privacyCleanedAt',                 // 内部标记,围观者无需感知
  'cityKey'                                             // 城市匹配键,内部匹配用,展示走 cityName
]

const ALL_FIELDS = [...new Set([...publishOrderFields(), ...POST_PUBLISH_FIELDS])]

// 全字段样本:location 用真实坐标验证模糊,其余字段给可识别的哨兵值
const FULL_ORDER = {}
for (const k of ALL_FIELDS) FULL_ORDER[k] = 'SENTINEL_' + k
FULL_ORDER._id = 'o1'
FULL_ORDER.location = { type: 'Point', coordinates: [113.264385, 23.129112] }
FULL_ORDER.photos = ['cloud://x/orders/u1/a.jpg']

describe('字段分类完备性(验收核心:新增字段必须显式表态)', () => {
  test('每个已知字段都被分类:VIEWER_FIELDS ∪ location ∪ HIDDEN_FROM_VIEWER', () => {
    const classified = new Set([...VIEWER_FIELDS, 'location', ...HIDDEN_FROM_VIEWER])
    const unclassified = ALL_FIELDS.filter(k => !classified.has(k))
    // 失败即:有人给订单加了新字段但没决定它对围观者是否可见 → 去 HIDDEN 或 VIEWER_FIELDS 表态
    expect(unclassified).toEqual([])
  })
  test('可见与隐藏两个清单无交集', () => {
    for (const k of HIDDEN_FROM_VIEWER) expect(VIEWER_FIELDS).not.toContain(k)
  })
  test('_id 不会被误列入隐藏清单', () => {
    expect(HIDDEN_FROM_VIEWER).not.toContain('_id')
  })
})

describe('sanitize 白名单行为', () => {
  const out = sanitize(FULL_ORDER)

  test('隐藏清单中的字段一个都不下发', () => {
    for (const k of HIDDEN_FROM_VIEWER) expect(out).not.toHaveProperty(k)
  })
  test('哨兵值不出现在序列化结果里(防对象嵌套夹带)', () => {
    const json = JSON.stringify(out)
    for (const k of HIDDEN_FROM_VIEWER) expect(json).not.toContain('SENTINEL_' + k)
  })
  test('白名单字段正常下发', () => {
    for (const k of ['orderNo', 'category', 'desc', 'address', 'cityName', 'status']) {
      expect(out[k]).toBe('SENTINEL_' + k)
    }
    expect(out._id).toBe('o1')
  })
  test('产出字段 ⊆ 白名单 + location', () => {
    const allowed = new Set([...VIEWER_FIELDS, 'location'])
    for (const k of Object.keys(out)) expect(allowed.has(k)).toBe(true)
  })
  test('缺失字段不产出 undefined 键', () => {
    const sparse = sanitize({ _id: 'o2', status: 'published' })
    expect(Object.keys(sparse).sort()).toEqual(['_id', 'status'])
  })
})

describe('roundLocation 坐标模糊', () => {
  test('坐标只保留2位小数(约1km,不够定位到户)', () => {
    expect(sanitize(FULL_ORDER).location.coordinates).toEqual([113.26, 23.13])
  })
  test('兼容 latitude/longitude 对象格式', () => {
    expect(roundLocation({ longitude: 113.264385, latitude: 23.129112 }).coordinates).toEqual([113.26, 23.13])
  })
  test('无坐标时原样返回不抛错', () => {
    expect(roundLocation(null)).toBeNull()
    expect(roundLocation({ foo: 1 })).toEqual({ foo: 1 })
  })
})
