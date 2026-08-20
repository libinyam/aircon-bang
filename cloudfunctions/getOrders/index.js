// 订单读取统一入口:集合不对客户端开放,这里按角色做权限与字段脱敏
// - 订单池里(抢单前)师傅看不到用户手机号
// - 只有订单双方能看订单详情全貌
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const { STATUS, ACTIVE_STATUSES, normalizeCity } = require('./biz')

// 分页大小:响应带 hasMore,前端据此判断而不是对比魔法数字
const PAGE_SIZE = 20

function bad(msg) { return { ok: false, msg } }

// 抢单前坐标模糊到小数点后两位(约1km),够算距离、不够定位到户
function roundLocation(loc) {
  if (!loc) return loc
  const lng = loc.longitude !== undefined ? loc.longitude : (loc.coordinates && loc.coordinates[0])
  const lat = loc.latitude !== undefined ? loc.latitude : (loc.coordinates && loc.coordinates[1])
  if (lng === undefined || lat === undefined) return loc
  return { type: 'Point', coordinates: [Math.round(lng * 100) / 100, Math.round(lat * 100) / 100] }
}

// 订单池/非本人视角按白名单下发:不在名单里的字段(手机号/称呼/门牌明细/未来新增字段)一律不给
// 新增订单字段默认不可见;确认对围观者无害且需要展示时,才加进 VIEWER_FIELDS
const VIEWER_FIELDS = [
  '_id', 'orderNo', 'category', 'categoryName', 'desc', 'photos',
  'address', 'cityName', 'expectTime', 'expectDate', 'expectSlot', 'expectEnd',
  'status', 'publishedAt', 'reviewed'
]
function sanitize(order) {
  const out = {}
  for (const k of VIEWER_FIELDS) {
    if (order[k] !== undefined) out[k] = order[k]
  }
  if (order.location !== undefined) out.location = roundLocation(order.location)
  return out
}

// 照片 fileID 换成临时链接下发:配合云存储"仅创建者可读写"权限,非上传者也能看图
// strict(围观视角,):换链失败或缺链时不回退原始 fileID——上传路径含用户 openid,
// 不能把持久身份标识发给围观师傅;订单双方保留回退(创建者本人仍可读)
async function withTempPhotoURLs(data, { strict = false } = {}) {
  if (data.photos && data.photos.length) {
    try {
      const r = await cloud.getTempFileURL({ fileList: data.photos })
      data.photos = r.fileList.map(f => f.tempFileURL || (strict ? null : f.fileID)).filter(Boolean)
    } catch (e) {
      if (strict) data.photos = []
      /* 非 strict 换链失败保留 fileID,创建者本人仍可见 */
    }
  }
  return data
}

const actions = {
  // 我发布的订单(用户视角);activeOnly=true 只取进行中的
  async userList({ activeOnly, page = 0 }, openid) {
    const where = { userOpenid: openid }
    if (activeOnly) where.status = _.in(ACTIVE_STATUSES)
    const data = (await db.collection('orders').where(where)
      .orderBy('publishedAt', 'desc').skip(page * PAGE_SIZE).limit(activeOnly ? 3 : PAGE_SIZE).get()).data
    return { ok: true, data, hasMore: !activeOnly && data.length === PAGE_SIZE }
  },

  // 我接的订单(师傅视角)
  async masterList({ page = 0 }, openid) {
    const data = (await db.collection('orders').where({ masterOpenid: openid })
      .orderBy('acceptedAt', 'desc').skip(page * PAGE_SIZE).limit(PAGE_SIZE).get()).data
    return { ok: true, data, hasMore: data.length === PAGE_SIZE }
  },

  // 同城订单池:仅审核通过的师傅可看;抢单前隐藏用户手机号
  // category 参数:大厅筛选 tab,只允许筛自己能力范围内的品类
  async pool({ page = 0, category = '' }, openid) {
    const master = (await db.collection('masters').where({ openid }).get()).data[0]
    if (!master || master.status !== 'approved') return bad('请先入驻并通过审核')
    const memberValid = master.memberExpireAt && new Date(master.memberExpireAt) > new Date()

    const cats = master.categories || []
    const catFilter = category && cats.includes(category) ? category : _.in(cats)

    const data = (await db.collection('orders').where({
      status: STATUS.PUBLISHED,
      // 城市按归一化匹配键:师傅手填"青岛"能看到定位"青岛市"的单;
      // 老档案没有 cityKey 时现算兜底(cityName 老订单需 admin backfillCityKeys 回填)
      cityKey: master.cityKey || normalizeCity(master.serviceCity),
      userOpenid: _.neq(openid),
      // 只看自己能力范围内的品类
      category: catFilter,
      // 定时器每小时才关一次过期单,查询侧兜底:未超48h 且 期望时段未过
      publishedAt: _.gt(new Date(Date.now() - 48 * 3600 * 1000)),
      expectEnd: _.gt(new Date())
    }).orderBy('publishedAt', 'desc').skip(page * PAGE_SIZE).limit(PAGE_SIZE).get()).data

    // 列表不下发照片:池卡片不展示图,原始 fileID 的路径里却带着发单用户 openid,
    // 既泄露持久标识又白费流量;详情页再按需换临时链接。只给 photoCount 供"有图"角标之类使用
    const listData = data.map(o => {
      const out = sanitize(o)
      out.photoCount = (out.photos || []).length
      delete out.photos
      return out
    })

    return { ok: true, data: listData, hasMore: data.length === PAGE_SIZE, memberValid, serviceCity: master.serviceCity, categories: cats }
  },

  // 订单详情:双方看全貌(含评价);其他有效师傅看脱敏版(用于订单池点进来)
  async detail({ orderId }, openid) {
    if (!orderId) return bad('参数错误')
    const order = (await db.collection('orders').doc(orderId).get().catch(() => ({ data: null }))).data
    if (!order) return bad('订单不存在')

    const isOwner = order.userOpenid === openid
    const isMaster = order.masterOpenid === openid

    // 评价与师傅口碑互不依赖,并行取:详情页冷启动少一次串行往返
    const [reviewRes, masterRes] = await Promise.all([
      order.reviewed ? db.collection('reviews').where({ orderId }).get() : Promise.resolve(null),
      (isOwner || isMaster) && order.masterOpenid
        ? db.collection('masters').where({ openid: order.masterOpenid }).get() : Promise.resolve(null)
    ])
    const review = reviewRes ? (reviewRes.data[0] || null) : null

    if (isOwner || isMaster) {
      // 给用户看师傅的累计口碑
      const m = masterRes && masterRes.data[0]
      const masterStats = m ? { done: m.stats.done, reviewCount: m.stats.reviewCount, totalStars: m.stats.totalStars } : null
      return { ok: true, data: await withTempPhotoURLs(order), role: isOwner ? 'user' : 'master', review, masterStats }
    }

    if (order.status === STATUS.PUBLISHED) {
      const master = (await db.collection('masters').where({ openid }).get()).data[0]
      // 围观视角与订单池同规则:同城 + 品类在能力范围内
      // 城市比较用归一化键,两侧都带"缺 cityKey 现算"的兜底
      if (master && master.status === 'approved' &&
          (order.cityKey || normalizeCity(order.cityName)) === (master.cityKey || normalizeCity(master.serviceCity)) &&
          (master.categories || []).includes(order.category)) {
        // 会员状态随详情下发:过期师傅仍可看单,但前端据此禁用抢单并明示原因,
        // 与订单池的 memberValid 口径一致;服务端 grabOrder 的会员校验仍是最终防线
        const memberValid = !!(master.memberExpireAt && new Date(master.memberExpireAt) > new Date())
        return { ok: true, data: await withTempPhotoURLs(sanitize(order), { strict: true }), role: 'viewer', memberValid, review: null, masterStats: null }
      }
    }
    return bad('无权查看该订单')
  }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const fn = actions[event.action]
  if (!fn) return bad('未知操作')
  return fn(event, OPENID)
}

// 仅供离线单测使用(/#4 隐私防线测试),云端运行不受影响
exports._internals = { sanitize, VIEWER_FIELDS, roundLocation }
