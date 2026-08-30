// 品类与时段 —— 云函数侧【母本】,前端对应 miniprogram/utils/constants.js
// ⚠️ 修改后执行 node scripts/sync-shared.js 同步副本;此目录不是云函数,不要上传部署
const CATEGORY_KEYS = ['repair', 'coldRepair', 'chillerRepair', 'clean', 'fluoride', 'move']
const CATEGORY_NAMES = {
  repair: '空调维修', coldRepair: '冷库设备维修', chillerRepair: '水冷机组维修',
  clean: '空调清洗', fluoride: '加氟利昂', move: '拆装移机'
}
// 短名(与前端 constants.js 各品类的 shortName 对应):订阅消息 thing 字段限 20 字,
// 六品类全选短名拼接 17 字仍不超;短名同时用于发单页磁贴,冷库/水冷在"服务类型"语境下即冷库维修/水冷机组维修
const CATEGORY_SHORTS = { repair: '维修', coldRepair: '冷库', chillerRepair: '水冷', clean: '清洗', fluoride: '加氟', move: '移机' }

// 品类多选(发单可同时勾维修+清洗+加氟…):入参归一为数组并去重,兼容老客户端单选的 category 字符串。
// 含任何非法 key 返回 null 由调用方拒绝——不静默丢弃,保持"非法品类直接拒"的闸门语义
function normalizeCategories(input) {
  const arr = Array.isArray(input) ? input : (input ? [input] : [])
  const out = []
  for (const k of arr) {
    if (!CATEGORY_KEYS.includes(k)) return null
    if (!out.includes(k)) out.push(k)
  }
  return out
}

// 订单品类读取侧统一入口:存量单只有单选 category,新单存 categories 数组(首选项仍镜像进 category)
function orderCategories(order) {
  if (!order) return []
  return (order.categories && order.categories.length) ? order.categories : (order.category ? [order.category] : [])
}

// 品类展示名拼接:默认全名落库 categoryName(界面标题用,无字数限制);short=true 用短名
// (订阅消息 thing 限 20 字,四品类全选短名拼接 11 字也不会超)
function categoryText(cats, short) {
  return (cats || []).map(k => (short ? CATEGORY_SHORTS : CATEGORY_NAMES)[k] || k).join('+')
}

// 订单场景(家用/商用)与接单费 —— 唯一费率源,前端镜像 utils/constants.js 的 SCENES
// grabFee 单位为分(避免浮点误差),钱包余额/流水全链路同单位;
// 接单费取代会员制:grabOrder 不再校验 memberExpireAt,改按 scene 扣 grabFee
const SCENE_KEYS = ['home', 'commercial']
const SCENES = {
  home: { name: '家用', grabFee: 2000 },      // ¥20 / 单
  commercial: { name: '商用', grabFee: 30000 } // ¥300 / 单
}

// 设备类型(发单页"修什么设备"):scene 是推导出的家用/商用费档,接单费仍按 scene 扣
// (商用空调/中央空调/冷库/水冷都走商用档)。老客户端只传 scene 不传 equipType,保持兼容;
// 前端镜像:miniprogram/utils/constants.js 的 EQUIP_TYPES(含展示提示文案)
const EQUIP_TYPES = {
  homeAc:      { name: '家用空调',     scene: 'home' },
  homeCentral: { name: '家用中央空调', scene: 'home' },
  commAc:      { name: '商用空调',     scene: 'commercial' },
  commCentral: { name: '商用中央空调', scene: 'commercial' },
  refrig:      { name: '制冷设备',     scene: 'commercial' },
  coldStore:   { name: '冷库机组',     scene: 'commercial' },
  waterCool:   { name: '水冷设备',     scene: 'commercial' },
  chiller:     { name: '水冷机组',     scene: 'commercial' }
}
const EQUIP_TYPE_KEYS = Object.keys(EQUIP_TYPES)

// 期望上门时段(北京时间小时);云函数运行在 UTC,换算用 Date.UTC(h-8)
const SLOTS = {
  morning: { label: '上午 (8-12点)', start: 8, end: 12 },
  afternoon: { label: '下午 (12-18点)', start: 12, end: 18 },
  evening: { label: '晚上 (18-21点)', start: 18, end: 21 }
}

// 订单状态机 —— 云函数侧唯一状态源;前端同源定义:utils/constants.js 的 STATUS/ORDER_STATUS
// 状态流转必须用条件原子更新 where({_id, status: 前置态}),靠 stats.updated === 0 判败(见 CLAUDE.md)
const STATUS = {
  PUBLISHED: 'published',            // 待接单
  ACCEPTED: 'accepted',              // 师傅已接单
  PENDING_CONFIRM: 'pending_confirm',// 师傅点完成,等用户确认
  COMPLETED: 'completed',            // 已完成
  CANCELLED: 'cancelled'             // 已取消
}
// 进行中的状态(用户"进行中"列表/重复发单校验用)
const ACTIVE_STATUSES = [STATUS.PUBLISHED, STATUS.ACCEPTED, STATUS.PENDING_CONFIRM]
// 合法流转表:新增流转前先改这里,守护测试(test/statusMachine.test.js)会对照
const STATUS_FLOW = {
  [STATUS.PUBLISHED]: [STATUS.ACCEPTED, STATUS.CANCELLED],
  [STATUS.ACCEPTED]: [STATUS.PENDING_CONFIRM, STATUS.CANCELLED],
  [STATUS.PENDING_CONFIRM]: [STATUS.COMPLETED, STATUS.ACCEPTED], // 用户确认 / 驳回退回
  [STATUS.COMPLETED]: [],
  [STATUS.CANCELLED]: []
}

// 入驻资质材料类型(与前端 utils/constants.js 的 QUAL_TYPES 保持一致,test/applyMaster.test.js 有契约断言)
// applyMaster 落库时按此写 qualTypes(与 qualPhotos 平行),管理端审核按类型分组展示
const QUAL_TYPE = {
  ID_FRONT: 'idFront',       // 身份证人像面(必传)
  ID_BACK: 'idBack',         // 身份证国徽面(必传)
  CERT: 'cert',              // 从业资质证书(选填)
  BIZ_LICENSE: 'bizLicense'  // 营业执照(选填)
}

// 城市匹配键:展示名与匹配键分离。定位解析出"青岛市"、师傅手填"青岛",
// 匹配键都归一为"青岛"。订单(cityName)与师傅档案(serviceCity)落库时都另存 cityKey,
// 订单池/详情围观/订阅通知/抢单四条链路统一按 cityKey 匹配;展示仍用原字段。
// 存量数据回填:admin 的 backfillCityKeys action(部署本改造后跑一次)
function normalizeCity(name) {
  return String(name || '').trim().replace(/(市|地区|自治州|盟)$/, '')
}

// ---- 买空调频道(商品上架) ----
// 商品状态机 —— 云函数侧唯一状态源;前端同源:utils/constants.js 的 LISTING_STATUS
// 值刻意避开订单状态字面量(published/completed 等被守护测试禁用)
const LISTING_STATUS = {
  ON_SALE: 'on_sale',       // 在售(发布即上架)
  OFF_SHELF: 'off_shelf',   // 卖家自行下架/系统下架,可重新上架
  SOLD: 'sold',             // 已售出(终态,再卖重新发布)
  REMOVED: 'removed'        // 管理员强制下架(终态,卖家不可自行恢复)
}
const LISTING_STATUS_FLOW = {
  [LISTING_STATUS.ON_SALE]: [LISTING_STATUS.OFF_SHELF, LISTING_STATUS.SOLD, LISTING_STATUS.REMOVED],
  [LISTING_STATUS.OFF_SHELF]: [LISTING_STATUS.ON_SALE, LISTING_STATUS.SOLD, LISTING_STATUS.REMOVED], // 下架后线下卖掉也可标已售
  [LISTING_STATUS.SOLD]: [],
  [LISTING_STATUS.REMOVED]: []
}
// 商品结构化参数枚举(服务端只存 key 做白名单校验;展示文案唯一源在前端 constants.js)
const LISTING_ENUMS = {
  CONDITIONS: ['new', 'used'],                       // 新机 / 二手机
  UNIT_TYPES: ['wall', 'cabinet', 'other'],          // 挂机 / 柜机 / 其他
  HP_KEYS: ['hp1', 'hp15', 'hp2', 'hp3', 'hp5', 'other'],  // 匹数(key 避小数点,便于 WXML 字典取文案)
  USED_GRADES: ['g95', 'g9', 'g8', 'g7less'],        // 95新 / 9成 / 8成 / 7成及以下
  USED_YEARS: ['y1', 'y1_3', 'y3_5', 'y5_10', 'y10plus'] // 使用年限档
}

module.exports = { CATEGORY_KEYS, CATEGORY_NAMES, CATEGORY_SHORTS, normalizeCategories, orderCategories, categoryText, SCENE_KEYS, SCENES, EQUIP_TYPES, EQUIP_TYPE_KEYS, SLOTS, STATUS, ACTIVE_STATUSES, STATUS_FLOW, QUAL_TYPE, normalizeCity, LISTING_STATUS, LISTING_STATUS_FLOW, LISTING_ENUMS }
