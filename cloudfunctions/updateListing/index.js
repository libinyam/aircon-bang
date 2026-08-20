// 卖家管理自己的商品(买空调频道):下架/重新上架/标已售/改价/删除
// 全部条件原子更新 where({_id, sellerOpenid, status: 前置态}),stats.updated === 0 判败,绝不先查后改
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const { LISTING_STATUS } = require('./biz')
const deleteFilesStrict = require('./storage')(cloud)
const log = require('./logger')('updateListing')

function bad(msg) { return { ok: false, msg } }

// 在架上限:与 publishListing 同口径(发布与重新上架两处都查,防"先囤后架"绕限)
const MAX_ON_SALE = 20

const actions = {
  async offShelf({ listingId }, openid) {
    const r = await db.collection('listings').where({
      _id: listingId, sellerOpenid: openid, status: LISTING_STATUS.ON_SALE
    }).update({ data: { status: LISTING_STATUS.OFF_SHELF, offShelfAt: db.serverDate(), updatedAt: db.serverDate() } })
    if (r.stats.updated === 0) return bad('状态已变化,请刷新后重试')
    log.info('listing off shelf', { listingId, openid })
    return { ok: true }
  },

  // 重新上架:复核资格/照片/在架数,deleting 中的商品不能复活(防与删除竞态成破图商品)
  async onShelf({ listingId }, openid) {
    const master = (await db.collection('masters').where({ openid }).get()).data[0]
    if (!master || master.status !== 'approved') return bad('师傅资格已失效,暂不可重新上架')
    const onSale = await db.collection('listings').where({
      sellerOpenid: openid, status: LISTING_STATUS.ON_SALE
    }).count()
    if (onSale.total >= MAX_ON_SALE) return bad(`在售商品已达上限(${MAX_ON_SALE}件)`)
    const listing = (await db.collection('listings').doc(listingId).get().catch(() => ({ data: null }))).data
    if (!listing || listing.sellerOpenid !== openid) return bad('商品不存在')
    if (!(listing.photos || []).length) return bad('商品照片已被移除,请删除该商品后重新发布')
    const r = await db.collection('listings').where({
      _id: listingId, sellerOpenid: openid, status: LISTING_STATUS.OFF_SHELF, deleting: _.neq(true)
    }).update({
      data: { status: LISTING_STATUS.ON_SALE, relistedAt: db.serverDate(), updatedAt: db.serverDate(), offShelfReason: '' }
    })
    if (r.stats.updated === 0) return bad('状态已变化,请刷新后重试')
    log.info('listing relisted', { listingId, openid })
    return { ok: true }
  },

  // 标已售:在售/已下架都可(下架后线下卖掉了也要能标,防状态机锁死)
  async markSold({ listingId }, openid) {
    const r = await db.collection('listings').where({
      _id: listingId, sellerOpenid: openid,
      status: _.in([LISTING_STATUS.ON_SALE, LISTING_STATUS.OFF_SHELF]),
      deleting: _.neq(true)
    }).update({ data: { status: LISTING_STATUS.SOLD, soldAt: db.serverDate(), updatedAt: db.serverDate() } })
    if (r.stats.updated === 0) return bad('状态已变化,请刷新后重试')
    log.info('listing sold', { listingId, openid })
    return { ok: true }
  },

  async editPrice({ listingId, priceYuan }, openid) {
    if (!Number.isInteger(priceYuan) || priceYuan < 1 || priceYuan > 99999) return bad('价格需为 1-99999 的整数(元)')
    const r = await db.collection('listings').where({
      _id: listingId, sellerOpenid: openid,
      status: _.in([LISTING_STATUS.ON_SALE, LISTING_STATUS.OFF_SHELF]),
      deleting: _.neq(true)
    }).update({ data: { priceYuan, updatedAt: db.serverDate() } })
    if (r.stats.updated === 0) return bad('状态已变化,请刷新后重试')
    log.info('listing price edited', { listingId, openid, priceYuan })
    return { ok: true }
  },

  // 删除(仅已下架;sold 是交易记录、removed 保留违规原因,都不可删)
  // 固定顺序:① 置 deleting ② 作废未决审核 ③ 删文件 ④ 删文档
  // ③④任一失败保留现场(文档带 deleting 标记)返回可重试错误;重按删除幂等续跑(已删文件视为成功)
  async deleteListing({ listingId }, openid) {
    const claim = await db.collection('listings').where({
      _id: listingId, sellerOpenid: openid, status: LISTING_STATUS.OFF_SHELF
    }).update({ data: { deleting: true, updatedAt: db.serverDate() } })
    const listing = (await db.collection('listings').doc(listingId).get().catch(() => ({ data: null }))).data
    if (!listing || listing.sellerOpenid !== openid) return bad('商品不存在')
    if (listing.status !== LISTING_STATUS.OFF_SHELF) return bad('仅已下架的商品可删除')
    if (claim.stats.updated === 0 && !listing.deleting) return bad('状态已变化,请刷新后重试')

    // 迟到的图片审核回调不再对将删商品动作(照抄 applyMaster 重提交的 superseded 模式)
    await db.collection('media_checks').where({
      targetId: listingId, status: _.in(['pending', 'processing'])
    }).update({ data: { status: 'superseded' } })

    try {
      await deleteFilesStrict(listing.photos || [])
    } catch (e) {
      log.error('deleteListing files failed, listing kept for retry', { listingId, openid }, e)
      return bad('照片清理失败,请稍后重试删除')
    }
    const rm = await db.collection('listings').where({
      _id: listingId, sellerOpenid: openid, status: LISTING_STATUS.OFF_SHELF
    }).remove()
    if (!rm.stats || !rm.stats.removed) {
      // 并发下已被移除视为成功;文档还在(如管理员刚强制下架)则如实报冲突
      const left = (await db.collection('listings').doc(listingId).get().catch(() => ({ data: null }))).data
      if (left) return bad('状态已变化,请刷新后重试')
    }
    log.info('listing deleted', { listingId, openid })
    return { ok: true }
  }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const fn = actions[event.action]
  if (!fn) return bad('未知操作')
  return fn(event, OPENID)
}

// 仅供离线单测使用,云端运行不受影响
exports._internals = { MAX_ON_SALE }
