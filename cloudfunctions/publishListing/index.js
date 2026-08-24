// 师傅发布空调商品(买空调频道):校验 -> 内容安全 -> 上架
// 交易形态是信息撮合:平台不代收货款,买家经 getListings.contact 按次取号电话联系
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const crypto = require('crypto')

const { LISTING_STATUS, LISTING_ENUMS, normalizeCity } = require('./biz')
const { makeBizNo, nextBizNo } = require('./bizNo')
const textSafe = require('./textSafe')(cloud)
// 联系方式拦截已上提 _shared/textSafe 母本:订单侧 publishOrder 同用一套正则/归一化
const { CONTACT_RE, normalizeContact } = require('./textSafe')
const verifyImages = require('./mediaFile')(cloud)
const log = require('./logger')('publishListing')

function bad(msg) { return { ok: false, msg } }

// 商品编号规则收进 _shared/bizNo:GD+北京时间年月日时分+8位 crypto 随机,
// 落库前查重重试;保留本地包装只为兼容 _internals 单测口径
const makeListingNo = (nowMs, rand) => makeBizNo('GD', nowMs, rand)

// 发布幂等 ID:卖家作用域哈希作文档 _id,云函数成功但客户端超时重试不会重复上架
// (不能拿裸 requestId 当全局 _id:跨用户撞号会让幂等返回冒领他人商品)
function makeListingId(openid, requestId) {
  return crypto.createHash('sha256').update(`${openid}:${requestId}`).digest('hex').slice(0, 32)
}

// 在架上限:只计 on_sale(与 updateListing.onShelf 同口径,防"先囤后架"绕限)
const MAX_ON_SALE = 20

exports.main = async (event) => {
  const start = Date.now()
  const { OPENID } = cloud.getWXContext()
  const { requestId, condition, title, desc, brand, unitType, hp, priceYuan, usedGrade, usedYears, photos = [] } = event

  if (typeof requestId !== 'string' || !requestId || requestId.length > 64) return bad('请求标识缺失,请返回重试')
  const listingId = makeListingId(OPENID, requestId)

  // 卖家资格:仅审核通过的师傅(不要求会员在期;将来点数制/条数分级只改这一处)
  const master = (await db.collection('masters').where({ openid: OPENID }).get()).data[0]
  if (!master || master.status !== 'approved') return bad('仅审核通过的师傅可发布商品')

  // 幂等前查:同一表单重复提交(云函数已成功但客户端超时)直接返回原单,
  // 不再走后续校验——否则限频等后置拒绝会把已上架商品的照片当垃圾删掉
  const existed = (await db.collection('listings').doc(listingId).get().catch(() => ({ data: null }))).data
  if (existed) {
    if (existed.sellerOpenid !== OPENID) return bad('请求标识冲突,请返回重试')
    return { ok: true, listingId, listingNo: existed.listingNo, duplicated: true }
  }

  if (!LISTING_ENUMS.CONDITIONS.includes(condition)) return bad('请选择新机或二手机')
  if (!LISTING_ENUMS.UNIT_TYPES.includes(unitType)) return bad('请选择机型')
  if (!LISTING_ENUMS.HP_KEYS.includes(hp)) return bad('请选择匹数')
  const isUsed = condition === 'used'
  if (isUsed) {
    if (!LISTING_ENUMS.USED_GRADES.includes(usedGrade)) return bad('请选择成色')
    if (!LISTING_ENUMS.USED_YEARS.includes(usedYears)) return bad('请选择使用年限')
  }
  if (typeof title !== 'string' || title.trim().length < 4) return bad('标题至少4个字')
  if (title.length > 30) return bad('标题最多30个字')
  if (typeof desc !== 'string' || desc.trim().length < 10) return bad('请描述一下商品情况(至少10个字)')
  if (desc.length > 500) return bad('描述太长了')
  if (typeof brand !== 'string' || !brand.trim()) return bad('请填写品牌')
  if (brand.length > 12) return bad('品牌名太长了')
  // 逐字段归一化匹配:字段先拼接再去空格可能把两个短数字粘成假手机号,分开学
  if ([title, brand, desc].some(t => CONTACT_RE.test(normalizeContact(t)))) {
    return bad('请勿在商品信息中留联系方式,买家会通过平台电话联系您')
  }
  if (!Number.isInteger(priceYuan) || priceYuan < 1 || priceYuan > 99999) return bad('价格需为 1-99999 的整数(元)')

  if (!Array.isArray(photos) || photos.length < 1) return bad('请至少上传1张商品照片')
  if (photos.length > 6) return bad('照片最多6张')
  // 照片归属与类型校验:必须是本人 listings 命名空间下上传的图片文件(与 publishOrder 同口径)
  for (const fid of photos) {
    if (typeof fid !== 'string' || !fid.includes(`/listings/${OPENID}/`) || !/\.(jpg|jpeg|png)$/i.test(fid)) {
      return bad('照片校验失败,请重新上传')
    }
  }

  // 照片归属已验证为本人所有;此后再拒绝就删掉本次上传,避免孤儿文件堆积
  async function badAndClean(msg) {
    await cloud.deleteFile({ fileList: photos }).catch(e => log.error('badAndClean deleteFile failed', { openid: OPENID }, e))
    return bad(msg)
  }

  // 真实类型与大小校验:扩展名可伪造,按文件魔数核验
  const imgErr = await verifyImages(photos)
  if (imgErr) return badAndClean(imgErr)

  if (!(await textSafe(`${title} ${brand} ${desc}`))) {
    return badAndClean('内容含违规信息,请修改后重试')
  }

  // 限频防刷:1小时最多发3件
  const recent = await db.collection('listings').where({
    sellerOpenid: OPENID,
    createdAt: _.gt(new Date(Date.now() - 3600 * 1000))
  }).count()
  if (recent.total >= 3) return badAndClean('发布太频繁,请1小时后再试')

  // 在架上限:防库存刷屏
  const onSale = await db.collection('listings').where({
    sellerOpenid: OPENID,
    status: LISTING_STATUS.ON_SALE
  }).count()
  if (onSale.total >= MAX_ON_SALE) return badAndClean(`在售商品已达上限(${MAX_ON_SALE}件),请先下架或删除部分商品`)

  // 编号落库前查重:撞候选换新,连续撞满明确失败而不是静默重复
  const listingNo = await nextBizNo('GD', async no =>
    (await db.collection('listings').where({ listingNo: no }).count()).total > 0)
  if (!listingNo) return badAndClean('编号生成失败,请重新提交')

  // 不存 realName 全名与 phone 快照:展示用派生的"张师傅",电话经 contact 接口实时取
  // (减 PII、免电话变更同步、减删号清理负担)
  const listing = {
    _id: listingId,
    listingNo,
    sellerOpenid: OPENID,
    sellerDisplayName: String(master.realName || '').slice(0, 1) + '师傅',
    cityName: master.serviceCity || '',
    cityKey: master.cityKey || normalizeCity(master.serviceCity),
    condition,
    title: title.trim(),
    desc: desc.trim(),
    brand: brand.trim(),
    unitType,
    hp,
    priceYuan,
    photos,
    photosRisk: false,
    deleting: false,
    status: LISTING_STATUS.ON_SALE,
    createdAt: db.serverDate()
  }
  // 二手专属结构化参数;新机不写入这两个字段
  if (isUsed) {
    listing.usedGrade = usedGrade
    listing.usedYears = usedYears
  }

  try {
    await db.collection('listings').add({ data: listing })
  } catch (e) {
    // _id 冲突 = 幂等前查之后的并发窗口里同请求已落库:核对归属后按成功返回,照片正被该商品引用,不删
    const dup = (await db.collection('listings').doc(listingId).get().catch(() => ({ data: null }))).data
    if (dup && dup.sellerOpenid === OPENID) return { ok: true, listingId, listingNo: dup.listingNo, duplicated: true }
    log.error('listing add failed', { listingId, openid: OPENID }, e)
    return bad('发布失败,请重试')
  }
  log.info('listing published', { listingId, listingNo, openid: OPENID, photoCount: photos.length, ms: Date.now() - start })

  // 图片异步送检:结果回调到 mediaCheckCallback(违规摘图;摘光则自动下架)
  // 送检失败不阻断发布(fail-open,与文本检测策略一致)
  try {
    const { fileList } = await cloud.getTempFileURL({ fileList: photos })
    for (const f of fileList) {
      if (!f.tempFileURL) continue
      const check = await cloud.openapi.security.mediaCheckAsync({
        mediaUrl: f.tempFileURL,
        mediaType: 2,        // 2=图片
        version: 2,
        scene: 3,            // 3=论坛(用户发布的公开内容)
        openid: OPENID
      })
      const traceId = check.traceId || check.trace_id
      if (traceId) {
        await db.collection('media_checks').add({
          data: { traceId, type: 'listing', targetId: listingId, fileID: f.fileID, status: 'pending', createdAt: db.serverDate() }
        })
      }
    }
  } catch (e) { log.error('mediaCheckAsync submit failed', { listingId }, e) }

  return { ok: true, listingId, listingNo }
}

// 仅供离线单测使用,云端运行不受影响
exports._internals = { makeListingNo, makeListingId, CONTACT_RE, normalizeContact, MAX_ON_SALE }
