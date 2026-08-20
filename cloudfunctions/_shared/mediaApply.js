// 违规媒体处置 —— 【母本】,mediaCheckCallback(实时回调)与 cronTimeout(补偿重放)共用
// 修改后执行 node scripts/sync-shared.js 同步副本
//
// 处置时序是安全关键(评审重构,替代"先落终态再摘图"的旧缺陷):
//   业务文档摘图/打标成功 -> 才删除云文件 -> 最后落终态
//   文档更新失败打 applyPending 留在 processing,由 cronTimeout 按记录里存的 suggest 重放;
//   目标文档已不存在(商品/订单已删除)则置 superseded 终态,不得永久挂起
// 调用前提:记录已被认领为 processing 且带 suggest 字段
module.exports = (cloud) => {
  const db = cloud.database()
  const _ = db.command
  const deleteFilesStrict = require('./storage')(cloud)
  const { LISTING_STATUS } = require('./biz')

  async function markSuperseded(check) {
    await db.collection('media_checks').doc(check._id).update({
      data: { status: 'superseded', applyPending: false, checkedAt: db.serverDate() }
    })
  }

  async function finalize(check, extra) {
    await db.collection('media_checks').doc(check._id).update({
      data: Object.assign(
        { status: check.suggest || 'risky', applyPending: false, checkedAt: db.serverDate() },
        extra || {}
      )
    })
  }

  // 处置一条已认领(processing)的违规检测记录,返回 'applied' | 'superseded' | 'failed'
  return async function applyMediaRisk(check) {
    try {
      if (check.type === 'order') {
        const r = await db.collection('orders').where({ _id: check.targetId })
          .update({ data: { photos: _.pull(check.fileID), photosRisk: true } })
        if (r.stats.updated === 0) { await markSuperseded(check); return 'superseded' }
      } else if (check.type === 'listing') {
        const r = await db.collection('listings').where({ _id: check.targetId })
          .update({ data: { photos: _.pull(check.fileID), photosRisk: true } })
        if (r.stats.updated === 0) { await markSuperseded(check); return 'superseded' }
        // 摘图后重读:照片被摘光的在售商品自动下架(条件原子,只动 on_sale;重放时天然幂等)
        const left = (await db.collection('listings').doc(check.targetId).get().catch(() => ({ data: null }))).data
        if (left && !(left.photos || []).length) {
          await db.collection('listings').where({
            _id: check.targetId, status: LISTING_STATUS.ON_SALE
          }).update({
            data: { status: LISTING_STATUS.OFF_SHELF, offShelfAt: db.serverDate(), offShelfReason: '照片违规已移除,请删除该商品后重新发布' }
          })
        }
      } else if (check.type === 'master') {
        // 资质照片仅管理员可见:只打标留给人工审核判断,不摘图不删文件
        const r = await db.collection('masters').where({ _id: check.targetId })
          .update({ data: { qualRisk: true } })
        if (r.stats.updated === 0) { await markSuperseded(check); return 'superseded' }
        await finalize(check)
        return 'applied'
      } else if (check.type === 'masterAvatar') {
        // 展示头像对买家公开:与订单/商品照片同口径摘除+删文件。
        // 条件原子带 avatarPhoto=fileID:师傅已换新头像时,旧检测不得误清新图(重放天然幂等)
        const r = await db.collection('masters').where({ _id: check.targetId, avatarPhoto: check.fileID })
          .update({ data: { avatarPhoto: '' } })
        if (r.stats.updated === 0) { await markSuperseded(check); return 'superseded' }
      } else {
        // 未知类型:终态化防止永久重放,留 lastError 供排查
        await finalize(check, { lastError: 'unknown check.type: ' + check.type })
        return 'applied'
      }
    } catch (e) {
      // 业务文档没改成,文件绝不能删(否则库里挂着已删 fileID 且无法重试)
      await db.collection('media_checks').doc(check._id).update({
        data: { applyPending: true, lastError: (e && e.message) || String(e) }
      }).catch(() => {})
      return 'failed'
    }

    // 文档已摘图成功:删云文件;删除失败打 cleanupPending,cronTimeout 每小时补偿重试
    try {
      await deleteFilesStrict([check.fileID])
      await finalize(check)
    } catch (e) {
      await finalize(check, { cleanupPending: true, lastError: (e && e.message) || String(e) })
    }
    return 'applied'
  }
}
