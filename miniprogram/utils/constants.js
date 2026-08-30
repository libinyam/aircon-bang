// 业务常量:品类与时段的【前端唯一定义处】
// ⚠️ 增删品类/时段:同时改后端母本 cloudfunctions/_shared/biz.js,然后执行 node scripts/sync-shared.js
//    图标:app.wxss 里按 key 命名(.ic-cat-{key} 引用 assets/cat-{key}.png 黏土图),新品类需补一张同名 PNG+一个类
const CATEGORIES = [
  { key: 'repair', name: '空调维修', shortName: '维修', desc: '不制冷/不启动/异响漏水' },
  { key: 'coldRepair', name: '冷库设备维修', shortName: '冷库', desc: '保鲜库/冷冻库不制冷、机组故障' },
  { key: 'chillerRepair', name: '水冷机组维修', shortName: '水冷', desc: '冷水机组/冷却塔/水泵故障' },
  { key: 'clean', name: '空调清洗', shortName: '清洗', desc: '内外机深度清洗消毒' },
  { key: 'fluoride', name: '加氟利昂', shortName: '加氟', desc: '制冷效果差、缺氟补充' },
  { key: 'move', name: '拆装移机', shortName: '移机', desc: '搬家拆机、装机、打孔' }
]

// 期望上门时段(展示文案/截止小时,与 _shared/biz.js 的 SLOTS 保持一致)
const SLOTS = [
  { key: 'morning', label: '上午 (8-12点)', short: '上午', endHour: 12 },
  { key: 'afternoon', label: '下午 (12-18点)', short: '下午', endHour: 18 },
  { key: 'evening', label: '晚上 (18-21点)', short: '晚上', endHour: 21 }
]

// 订单场景与接单费(与 _shared/biz.js 的 SCENES 保持一致):grabFee 单位为分,
// 前端展示用 utils/util.js 的 formatFee 格式化(¥20 / ¥300)
const SCENES = [
  { key: 'home', name: '家用', grabFee: 2000 },
  { key: 'commercial', name: '商用', grabFee: 30000 }
]

// 设备类型(发单页"修什么设备",与 _shared/biz.js 的 EQUIP_TYPES 同源;tip 为前端展示文案)
// scene 由设备类型推导,发单不再单独选家用/商用;商用档设备接单费 ¥300,家用档 ¥20
const EQUIP_TYPES = [
  { key: 'homeAc',      name: '家用空调',     scene: 'home',       tip: '挂机 / 柜机 / 风管机' },
  { key: 'homeCentral', name: '家用中央空调', scene: 'home',       tip: '家用多联机 / 一拖多' },
  { key: 'commAc',      name: '商用空调',     scene: 'commercial', tip: '商铺 / 办公柜挂机' },
  { key: 'commCentral', name: '商用中央空调', scene: 'commercial', tip: '多联机 / 风管系统' },
  { key: 'refrig',      name: '制冷设备',     scene: 'commercial', tip: '冷柜 / 展示柜 / 制冰机' },
  { key: 'coldStore',   name: '冷库机组',     scene: 'commercial', tip: '保鲜库 / 冷冻库' },
  { key: 'waterCool',   name: '水冷设备',     scene: 'commercial', tip: '冷却塔 / 水冷柜机' },
  { key: 'chiller',     name: '水冷机组',     scene: 'commercial', tip: '冷水机组 / 螺杆机' }
]
function equipTypeName(key) {
  const t = EQUIP_TYPES.find(t => t.key === key)
  return t ? t.name : ''
}
function sceneName(key) { return pickName(SCENES, key) }
function grabFee(key) {
  const it = SCENES.find(s => s.key === key)
  return it ? it.grabFee : SCENES[0].grabFee // 老订单无 scene 按家用(与 grabOrder 口径一致)
}

// 订单状态 key 常量
// JS 里判断状态用这里,不要写裸字符串;WXML 里的字面量由 test/statusMachine.test.js 守护
const STATUS = {
  PUBLISHED: 'published',
  ACCEPTED: 'accepted',
  PENDING_CONFIRM: 'pending_confirm',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled'
}

const ORDER_STATUS = {
  published: { label: '待接单', color: '#E0761A' },
  accepted: { label: '师傅已接单', color: '#3D6FD1' },
  pending_confirm: { label: '待确认完成', color: '#7A5AD8' },
  completed: { label: '已完成', color: '#0E9868' },
  cancelled: { label: '已取消', color: '#667180' }
}

const MASTER_STATUS = {
  pending: { label: '审核中', color: '#E0761A' },
  approved: { label: '已通过', color: '#0E9868' },
  rejected: { label: '未通过', color: '#CE3F36' }
}

// 师傅入驻资质材料槽位(前端唯一定义处;key 与后端母本 _shared/biz.js 的 QUAL_TYPE 值集合保持一致)
// 入驻页按槽位收集,applyMaster 落库时写平行的 qualTypes 标注,管理端审核按标签分组展示
const QUAL_TYPES = [
  { key: 'idFront', label: '身份证人像面', required: true },
  { key: 'idBack', label: '身份证国徽面', required: true },
  { key: 'cert', label: '资质证书', required: false },
  { key: 'bizLicense', label: '营业执照', required: false }
]

function categoryName(key) {
  const c = CATEGORIES.find(c => c.key === key)
  return c ? c.name : key
}

function categoryShort(key) {
  const c = CATEGORIES.find(c => c.key === key)
  return c ? c.shortName : key
}

function slotShort(key) {
  const s = SLOTS.find(s => s.key === key)
  return s ? s.short : ''
}

function qualTypeLabel(key) {
  const t = QUAL_TYPES.find(t => t.key === key)
  return t ? t.label : '其他材料'
}

// ---- 买空调频道(商品上架) ----
// 商品状态 key 常量(与云函数母本 _shared/biz.js 的 LISTING_STATUS 同源)
// JS 里判断状态用这里,不要写裸字符串;WXML 字面量由 test/statusMachine.test.js 守护
const LISTING_STATUS = {
  ON_SALE: 'on_sale',
  OFF_SHELF: 'off_shelf',
  SOLD: 'sold',
  REMOVED: 'removed'
}

const LISTING_STATUS_MAP = {
  on_sale: { label: '在售', color: '#0E9868' },
  off_shelf: { label: '已下架', color: '#667180' },
  sold: { label: '已售出', color: '#3D6FD1' },
  removed: { label: '违规下架', color: '#CE3F36' }
}

// 商品结构化参数(key 与母本 _shared/biz.js 的 LISTING_ENUMS 同源;展示文案只在这里)
const CONDITIONS = [
  { key: 'new', name: '新机' },
  { key: 'used', name: '二手机' }
]
const UNIT_TYPES = [
  { key: 'wall', name: '挂机' },
  { key: 'cabinet', name: '柜机' },
  { key: 'other', name: '其他' }
]
const HP_OPTIONS = [
  { key: 'hp1', name: '1匹' },
  { key: 'hp15', name: '1.5匹' },
  { key: 'hp2', name: '2匹' },
  { key: 'hp3', name: '3匹' },
  { key: 'hp5', name: '5匹及以上' },
  { key: 'other', name: '其他' }
]
const USED_GRADES = [
  { key: 'g95', name: '95新' },
  { key: 'g9', name: '9成新' },
  { key: 'g8', name: '8成新' },
  { key: 'g7less', name: '7成及以下' }
]
const USED_YEARS = [
  { key: 'y1', name: '1年内' },
  { key: 'y1_3', name: '1-3年' },
  { key: 'y3_5', name: '3-5年' },
  { key: 'y5_10', name: '5-10年' },
  { key: 'y10plus', name: '10年以上' }
]
// 品牌建议 chips(纯前端 UI 素材,后端按自由文本处理,不进 biz.js)
const BRAND_SUGGESTS = ['格力', '美的', '海尔', '奥克斯', 'TCL', '海信', '小米']

// 首页"常见服务"参考价卡(纯前端 UI 素材,不进 biz.js):价格是展示用的本地行情参考,
// 不是平台报价——下单仍走"师傅上门当面谈价",模块脚注已写明"以上门报价为准"。
// price 单位元,展示成"¥120起";icon 取 CATEGORIES 的 key(复用 .ic-cat-{key} 图标)
// ⚠️ 参考价请按本地实际行情修改;category 必须是 CATEGORIES 已有的 key
const POPULAR_SERVICES = [
  { key: 'cleanWall', name: '挂机深度清洗', category: 'clean', icon: 'clean', price: 120, desc: '内外机·高温消毒' },
  { key: 'repairCheck', name: '空调故障维修', category: 'repair', icon: 'repair', price: 60, desc: '不制冷/不启动' },
  { key: 'fluorideTop', name: '环保加氟', category: 'fluoride', icon: 'fluoride', price: 150, desc: '压力当面测' },
  { key: 'moveAc', name: '拆装移机', category: 'move', icon: 'move', price: 180, desc: '拆机装机·打孔' }
]

function pickName(list, key) {
  const it = list.find(it => it.key === key)
  return it ? it.name : ''
}
function conditionName(key) { return pickName(CONDITIONS, key) }
function unitTypeName(key) { return pickName(UNIT_TYPES, key) }
function hpName(key) { return pickName(HP_OPTIONS, key) }
function gradeName(key) { return pickName(USED_GRADES, key) }
function yearsName(key) { return pickName(USED_YEARS, key) }

module.exports = {
  CATEGORIES, SLOTS, STATUS, ORDER_STATUS, MASTER_STATUS, QUAL_TYPES,
  categoryName, categoryShort, slotShort, qualTypeLabel,
  SCENES, sceneName, grabFee,
  EQUIP_TYPES, equipTypeName,
  LISTING_STATUS, LISTING_STATUS_MAP, CONDITIONS, UNIT_TYPES, HP_OPTIONS,
  USED_GRADES, USED_YEARS, BRAND_SUGGESTS, POPULAR_SERVICES,
  conditionName, unitTypeName, hpName, gradeName, yearsName
}
