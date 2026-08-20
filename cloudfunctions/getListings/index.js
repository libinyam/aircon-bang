// 商品读取统一入口(买空调频道):集合不对客户端开放,这里按角色白名单脱敏
// - 市场列表/详情响应都不含卖家电话与 openid;电话仅 contact 动作按次下发+日限频
// - 白名单分四层:LIST(市场列表) / OWNER_LIST(我的列表) / DETAIL_PUBLIC(围观详情) / DETAIL_OWNER(本人详情)
//   removedBy 不在任何一层:卖家只见 removedReason 不见管理员,removedBy 仅 admin.listListings 下发
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const crypto = require('crypto')

const { LISTING_STATUS, LISTING_ENUMS } = require('./biz')
const log = require('./logger')('getListings')

// 分页大小:响应带 hasMore,前端据此判断而不是对比魔法数字
const PAGE_SIZE = 20
// 取号日限频:按调用者每日总量,显著提高批量爬号成本(不是彻底防爬)
const CONTACT_DAILY_LIMIT = 30

function bad(msg) { return { ok: false, msg } }

// 市场列表:逛所需的最小集。不带 desc/listingNo/sellerDisplayName(详情才需要),
// 不带原始 photos(fileID 路径含卖家 openid)——封面经换链后以 cover 单字段下发
const LIST_FIELDS = ['_id', 'condition', 'title', 'brand', 'unitType', 'hp', 'priceYuan', 'usedGrade', 'cityName', 'createdAt']
// 我的列表 = LIST + 状态与原因(卖家管理页要渲染操作按钮和系统下架原因)
const OWNER_LIST_FIELDS = [...LIST_FIELDS, 'status', 'photosRisk', 'offShelfReason', 'removedReason']
// 围观详情 = LIST + 详情正文;sellerVerified/sellerStats 实时派生不落库
const DETAIL_PUBLIC_FIELDS = [...LIST_FIELDS, 'listingNo', 'desc', 'photos', 'usedYears', 'status', 'sellerDisplayName']
// 本人详情 = 围观 + 原因与时间戳
const DETAIL_OWNER_FIELDS = [...DETAIL_PUBLIC_FIELDS, 'photosRisk', 'offShelfReason', 'removedReason', 'updatedAt', 'offShelfAt', 'relistedAt', 'soldAt', 'removedAt']

function pick(listing, fields) {
  const out = {}
  for (const k of fields) {
    if (listing[k] !== undefined) out[k] = listing[k]
  }
  return out
}

// 取号限频的"北京时间日"键:云函数跑在 UTC,直接取日期会让额度每天 08:00 才刷新
function contactDay(nowMs) {
  return new Date(nowMs + 8 * 3600 * 1000).toISOString().slice(0, 10)
}
// 计数文档 _id 用哈希,不把裸 openid 放进 _id;viewerOpenid 字段留在文档内供删号清理
function contactKey(openid, day) {
  return crypto.createHash('sha256').update(`${openid}:${day}`).digest('hex').slice(0, 32)
}

// 列表封面:整页首图一次换链。strict(市场,围观视角)换链失败不回退 fileID
// (上传路径含卖家 openid,与 getOrders 的  同口径);本人列表回退 fileID 仍可显示
async function withCovers(rows, picked, { strict = false } = {}) {
  const firsts = rows.map(r => (r.photos || [])[0]).filter(Boolean)
  const urlMap = {}
  if (firsts.length) {
    try {
      const r = await cloud.getTempFileURL({ fileList: firsts })
      for (const f of r.fileList) {
        if (f.tempFileURL) urlMap[f.fileID] = f.tempFileURL
      }
    } catch (e) { /* 换链失败列表暂无图,不阻断浏览 */ }
  }
  return picked.map((out, i) => {
    const first = (rows[i].photos || [])[0]
    out.cover = first ? (urlMap[first] || (strict ? '' : first)) : ''
    return out
  })
}

// 详情照片 fileID 换临时链接(与 getOrders.withTempPhotoURLs 同口径)
async function withTempPhotoURLs(data, { strict = false } = {}) {
  if (data.photos && data.photos.length) {
    try {
      const r = await cloud.getTempFileURL({ fileList: data.photos })
      data.photos = r.fileList.map(f => f.tempFileURL || (strict ? null : f.fileID)).filter(Boolean)
    } catch (e) {
      if (strict) data.photos = []
    }
  }
  return data
}

// 卖家展示头像实时派生换链(与 sellerVerified 同口径):fileID 路径含卖家 openid,
// 只下临时链接,换链失败回退空串由前端显示文字头像。
// 调用时机放在各返回分支里(详情的早退错误路径不白换链)
async function sellerAvatarUrl(seller) {
  if (!seller || !seller.avatarPhoto) return ''
  try {
    const { fileList } = await cloud.getTempFileURL({ fileList: [seller.avatarPhoto] })
    return (fileList[0] && fileList[0].tempFileURL) || ''
  } catch (e) { return '' }
}

const actions = {
  // 市场列表:只出在售;condition 合法时叠加新机/二手筛选
  async market({ page = 0, condition = '' }) {
    const where = { status: LISTING_STATUS.ON_SALE }
    if (condition && LISTING_ENUMS.CONDITIONS.includes(condition)) where.condition = condition
    const rows = (await db.collection('listings').where(where)
      .orderBy('createdAt', 'desc').skip(page * PAGE_SIZE).limit(PAGE_SIZE).get()).data
    const data = await withCovers(rows, rows.map(r => pick(r, LIST_FIELDS)), { strict: true })
    return { ok: true, data, hasMore: rows.length === PAGE_SIZE }
  },

  // 我的商品(卖家管理页):全状态
  async mine({ page = 0 }, openid) {
    const rows = (await db.collection('listings').where({ sellerOpenid: openid })
      .orderBy('createdAt', 'desc').skip(page * PAGE_SIZE).limit(PAGE_SIZE).get()).data
    const data = await withCovers(rows, rows.map(r => pick(r, OWNER_LIST_FIELDS)))
    return { ok: true, data, hasMore: rows.length === PAGE_SIZE }
  },

  // 商品详情:本人全程可看;围观者仅在售/已售可看(已售不可再取号)
  async detail({ listingId }, openid) {
    if (!listingId) return bad('参数错误')
    const listing = (await db.collection('listings').doc(listingId).get().catch(() => ({ data: null }))).data
    if (!listing) return bad('商品不存在或已删除')

    const isOwner = listing.sellerOpenid === openid
    // 卖家认证标识实时派生:资格被撤销后,已售商品也不再显示"平台认证师傅"
    const seller = (await db.collection('masters').where({ openid: listing.sellerOpenid }).get()).data[0]
    const sellerVerified = !!(seller && seller.status === 'approved')
    const sellerStats = seller && seller.stats
      ? { done: seller.stats.done, reviewCount: seller.stats.reviewCount, totalStars: seller.stats.totalStars }
      : null

    if (isOwner) {
      const data = await withTempPhotoURLs(pick(listing, DETAIL_OWNER_FIELDS))
      return { ok: true, data, isOwner: true, sellerVerified, sellerStats, sellerAvatar: await sellerAvatarUrl(seller) }
    }
    if (listing.deleting) return bad('商品不存在或已删除')
    if (listing.status !== LISTING_STATUS.ON_SALE && listing.status !== LISTING_STATUS.SOLD) {
      return bad('该商品已下架')
    }
    const data = await withTempPhotoURLs(pick(listing, DETAIL_PUBLIC_FIELDS), { strict: true })
    return { ok: true, data, isOwner: false, sellerVerified, sellerStats, sellerAvatar: await sellerAvatarUrl(seller) }
  },

  // 取号:每次调用无条件复查商品在售 + 卖家资格,再过原子日限频,返回实时电话
  // 响应之外任何地方不得出现号码(结构化日志/错误文案都不带)
  async contact({ listingId }, openid) {
    if (!listingId) return bad('参数错误')
    const listing = (await db.collection('listings').doc(listingId).get().catch(() => ({ data: null }))).data
    if (!listing || listing.deleting) return bad('商品不存在或已删除')
    if (listing.status !== LISTING_STATUS.ON_SALE) return bad('该商品已下架或售出')
    if (listing.sellerOpenid === openid) return bad('这是您自己发布的商品')

    const seller = (await db.collection('masters').where({ openid: listing.sellerOpenid }).get()).data[0]
    if (!seller || seller.status !== 'approved' || !seller.phone) return bad('卖家资格已失效,暂不可联系')

    // 原子日限频:条件自增,不是"先 count 再写"(那有并发窗口)
    const day = contactDay(Date.now())
    const key = contactKey(openid, day)
    const inc = () => db.collection('contact_logs').where({
      _id: key,
      count: _.lt(CONTACT_DAILY_LIMIT)
    }).update({ data: { count: _.inc(1) } })
    let r = await inc()
    if (r.stats.updated === 0) {
      try {
        await db.collection('contact_logs').add({ data: { _id: key, viewerOpenid: openid, day, count: 1 } })
      } catch (e) {
        // _id 冲突:并发首建,重试自增一次;仍失败即今日已达限
        r = await inc()
        if (r.stats.updated === 0) return bad('今日联系次数已达上限,请明天再试')
      }
    }
    log.info('contact revealed', { listingId, viewer: openid })
    return { ok: true, phone: seller.phone }
  }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const fn = actions[event.action]
  if (!fn) return bad('未知操作')
  return fn(event, OPENID)
}

// 仅供离线单测使用(白名单/限频防线测试),云端运行不受影响
exports._internals = { pick, LIST_FIELDS, OWNER_LIST_FIELDS, DETAIL_PUBLIC_FIELDS, DETAIL_OWNER_FIELDS, contactDay, contactKey, CONTACT_DAILY_LIMIT }
