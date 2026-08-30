// 定时器(每小时):48小时无人接单/期望时段已过自动关闭;完成后72小时用户未确认自动确认
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const { STATUS } = require('./biz')
const deleteFilesStrict = require('./storage')(cloud)
const applyMediaRisk = require('./mediaApply')(cloud)
const log = require('./logger')('cronTimeout')

exports.main = async () => {
  const now = Date.now()
  const result = {
    closed: 0, expectClosed: 0,
    autoConfirmed: 0, autoConfirmHeld: 0, autoConfirmFailed: 0,
    statsCredited: 0, statsFailed: 0, statsFailedIds: [],
    reviewStatsCredited: 0, reviewStatsFailed: 0,
    walletStuckFound: 0, walletRefunded: 0, walletRefundFailed: 0,
    privacyCleaned: 0, privacyCleanFailed: 0, mediaCleanupRetried: 0, mediaApplyRetried: 0,
    uploadLogsResolved: 0, uploadOrphansCleaned: 0, error: ''
  }

  try {
    // 1) 超时未接单 -> 自动关闭
    const expiredPublish = await db.collection('orders').where({
      status: STATUS.PUBLISHED,
      publishedAt: _.lt(new Date(now - 48 * 3600 * 1000))
    }).update({
      data: {
        status: STATUS.CANCELLED,
        cancelBy: 'system',
        cancelReason: '48小时内无师傅接单,已自动关闭,可重新发布',
        cancelledAt: db.serverDate()
      }
    })
    result.closed = expiredPublish.stats.updated

    // 1b) 期望上门时段已过 -> 自动关闭
    //     订单池/抢单查询侧已按 expectEnd 过滤,这类单师傅侧不可见却在用户侧显示"待接单",
    //     不关就要白等到 48h;历史缺 expectEnd 字段的单不会命中,仍由 48h 分支兜底
    const expiredExpect = await db.collection('orders').where({
      status: STATUS.PUBLISHED,
      expectEnd: _.lt(new Date(now))
    }).update({
      data: {
        status: STATUS.CANCELLED,
        cancelBy: 'system',
        cancelReason: '期望上门时段已过,已自动关闭,可重新发布',
        cancelledAt: db.serverDate()
      }
    })
    result.expectClosed = expiredExpect.stats.updated

    // 2) 师傅标记完成后用户超时未确认 -> 自动确认
    //    单单隔离:一单出错只记数,不中断其他订单和后续清理阶段
    //    投诉冻结:有未结投诉的单不自动确认;disputeHold 进翻转的原子条件,
    //    堵住"查完投诉数之后、状态翻转之前"新投诉入场的竞态(complain 先打标记再建投诉)
    //    分页续扫:被投诉冻结等跳过的记录不推进也不落标记,固定 limit 的单页
    //    查询会让他们永久占据页窗,第 101 条起的过期单永远轮不到;按 _id 游标翻页越过
    //    卡住的记录,单轮实际翻转数仍守上限,跳过的记录不占翻转预算
    const MAX_AUTO_CONFIRM = 100
    try {
      let lastId = ''
      for (;;) {
        const staleCond = {
          status: STATUS.PENDING_CONFIRM,
          finishedAt: _.lt(new Date(now - 72 * 3600 * 1000))
        }
        const stale = (await db.collection('orders').where(lastId
          ? _.and([staleCond, { _id: _.gt(lastId) }])
          : staleCond).orderBy('_id', 'asc').limit(100).get()).data
        if (!stale.length) break

        for (const o of stale) {
          if (result.autoConfirmed >= MAX_AUTO_CONFIRM) break
          try {
            const openComplaints = (await db.collection('complaints')
              .where({ orderId: o._id, status: 'open' }).count()).total
            if (openComplaints > 0) { result.autoConfirmHeld++; continue }
            if (o.disputeHold) {
              // 投诉已关闭(或建投诉中途失败)的残留标记:本轮只清标记不翻转,下一轮再确认。
              // 不敢清完就翻——清与翻之间可能有新投诉入场,分轮走让翻转永远面对最新判断
              await db.collection('orders').where({ _id: o._id, disputeHold: true })
                .update({ data: { disputeHold: false } })
              result.autoConfirmHeld++
              continue
            }
            const res = await db.collection('orders').where({
              _id: o._id, status: STATUS.PENDING_CONFIRM, disputeHold: _.neq(true)
            }).update({
              data: { status: STATUS.COMPLETED, autoConfirmed: true, statsCredited: false, confirmedAt: db.serverDate() }
            })
            // 计实际翻转数,不用 stale.length
            if (res.stats.updated > 0) result.autoConfirmed++
          } catch (e) {
            result.autoConfirmFailed++
            log.error('auto confirm failed, continue next order', { orderId: o._id }, e)
          }
        }
        if (result.autoConfirmed >= MAX_AUTO_CONFIRM) break
        if (stale.length < 100) break
        lastId = stale[stale.length - 1]._id
      }
    } catch (e) {
      // 阶段查询失败也不拖垮后面的记账与清理阶段
      result.autoConfirmFailed++
      log.error('auto confirm phase failed', {}, e)
    }

    // 2b) 师傅完成数补账:状态翻转与统计累计解耦——翻转只打 statsCredited:false,
    //     这里统一记账;手动确认与自动确认共用同一把认领锁,去掉 autoConfirmed
    //     过滤后上一轮记账失败的单都会被重新拾起,不再"状态已完成但永久漏计"
    try {
      const uncredited = (await db.collection('orders').where({
        status: STATUS.COMPLETED, statsCredited: false
      }).limit(100).get()).data

      for (const o of uncredited) {
        let claimed = false
        try {
          // 先原子认领再累计:重复执行/并发触发下只有一次认领成功,stats.done 不会重复加
          const claim = await db.collection('orders').where({ _id: o._id, statsCredited: false })
            .update({ data: { statsCredited: true } })
          if (claim.stats.updated === 0) continue
          claimed = true
          if (o.masterOpenid) {
            const upd = await db.collection('masters').where({ openid: o.masterOpenid })
              .update({ data: { 'stats.done': _.inc(1) } })
            // 师傅档案已不存在(注销等):记账落空但不重试,留日志可查
            if (upd.stats.updated === 0) log.warn('stats credit: master not found', { orderId: o._id, masterOpenid: o.masterOpenid })
          }
          result.statsCredited++
        } catch (e) {
          result.statsFailed++
          result.statsFailedIds.push(o._id)
          log.error('stats credit failed, will retry next run', { orderId: o._id, masterOpenid: o.masterOpenid }, e)
          if (claimed) {
            // 认领回滚,下一轮重试;回滚也失败则该单漏计,靠日志与 statsFailedIds 人工对账
            await db.collection('orders').doc(o._id).update({ data: { statsCredited: false } })
              .catch(e2 => log.error('stats credit rollback failed, needs manual reconcile', { orderId: o._id }, e2))
          }
        }
      }
    } catch (e) {
      result.statsFailed++
      log.error('stats credit phase failed', {}, e)
    }

    // 2c) 评价统计补账:评价已落库但统计累计失败(review.statsApplied 仍 false),
    //     认领后按评价存档星级补记;与 submitReview 的即时记账共用同一把认领锁,不会双计。
    //     历史评价缺 statsApplied 字段不命中等值查询,不会被误补
    try {
      const unapplied = (await db.collection('reviews').where({ statsApplied: false }).limit(100).get()).data
      for (const rv of unapplied) {
        let claimed = false
        try {
          const claim = await db.collection('reviews').where({ _id: rv._id, statsApplied: false })
            .update({ data: { statsApplied: true } })
          if (claim.stats.updated === 0) continue
          claimed = true
          const upd = await db.collection('masters').where({ openid: rv.masterOpenid }).update({
            data: { 'stats.reviewCount': _.inc(1), 'stats.totalStars': _.inc(rv.stars) }
          })
          if (upd.stats.updated === 0) log.warn('review stats credit: master not found', { reviewId: rv._id, masterOpenid: rv.masterOpenid })
          result.reviewStatsCredited++
        } catch (e) {
          result.reviewStatsFailed++
          log.error('review stats credit failed, will retry next run', { reviewId: rv._id }, e)
          if (claimed) {
            await db.collection('reviews').doc(rv._id).update({ data: { statsApplied: false } })
              .catch(e2 => log.error('review stats rollback failed, needs manual reconcile', { reviewId: rv._id }, e2))
          }
        }
      }
    } catch (e) {
      result.reviewStatsFailed++
      log.error('review stats credit phase failed', {}, e)
    }

    // 2d) 接单费对账补退:grabOrder"扣款-抢单-退回"三段之间被杀/退款失败,
    //     会留下无对应退款的扣款流水(grab 流水在、refund 流水不在、订单也非本人接成),
    //     或 grabOrder 落的 need_manual 待补流水。两步走:
    //     a. 检测:近 7 天(留 10 分钟避开进行中的抢单)无退款流水的 grab,且订单最终非
    //        本人接成 -> 落 need_manual 退款流水(纯检测,_id 幂等,已存在则跳过)
    //     b. 结算:全部 need_manual 退款流水 need_manual->done 条件认领后加钱,
    //        加钱异常回滚认领下一轮重试(与 2b/2c 同模式,重复执行不会双退)
    try {
      const grabs = (await db.collection('wallet_logs').where(_.and([
        { type: 'grab' },
        { createdAt: _.gt(new Date(now - 7 * 24 * 3600 * 1000)) },
        { createdAt: _.lt(new Date(now - 10 * 60 * 1000)) }
      ])).limit(100).get()).data
      const refunds = grabs.length
        ? (await db.collection('wallet_logs').where({
          _id: _.in(grabs.map(g => `refund:grab:${g.orderId}:${g.openid}`))
        }).limit(100).get()).data
        : []
      const refunded = new Set(refunds.map(r => r._id))
      // 批量取涉及订单:最终接单人 == 扣款人 = 合法扣费,不退
      const orderIds = [...new Set(grabs.map(g => g.orderId))]
      const orders = orderIds.length
        ? (await db.collection('orders').where({ _id: _.in(orderIds) }).limit(100).get()).data
        : []
      const wonBy = Object.fromEntries(orders.map(o => [o._id, o.masterOpenid || '']))
      for (const g of grabs) {
        const refundId = `refund:grab:${g.orderId}:${g.openid}`
        if (refunded.has(refundId) || wonBy[g.orderId] === g.openid) continue
        try {
          await db.collection('wallet_logs').add({
            data: {
              _id: refundId, openid: g.openid, type: 'refund', amount: -g.amount,
              orderId: g.orderId, scene: g.scene, status: 'need_manual', createdAt: db.serverDate()
            }
          })
          result.walletStuckFound++
        } catch (e) { /* 流水已存在:跳过,由下方结算步处理 */ }
      }

      const pendings = (await db.collection('wallet_logs').where({
        type: 'refund', status: 'need_manual'
      }).limit(100).get()).data
      for (const p of pendings) {
        try {
          const claim = await db.collection('wallet_logs').where({ _id: p._id, status: 'need_manual' })
            .update({ data: { status: 'done', refundedAt: db.serverDate() } })
          if (claim.stats.updated === 0) continue
          const credit = await db.collection('wallets').where({ _id: p.openid })
            .update({ data: { balance: _.inc(p.amount), updatedAt: db.serverDate() } })
          if (credit.stats.updated === 0) {
            // 钱包文档不存在(理论上扣过款必有,档案被异常删除?):关闭不重试,留日志人工核对
            log.warn('refund settle: wallet not found', { orderId: p.orderId, openid: p.openid, amount: p.amount })
            continue
          }
          result.walletRefunded++
        } catch (e) {
          result.walletRefundFailed++
          log.error('refund settle failed, will retry next run', { orderId: p.orderId, openid: p.openid }, e)
          await db.collection('wallet_logs').where({ _id: p._id, status: 'done' })
            .update({ data: { status: 'need_manual' } })
            .catch(e2 => log.error('refund settle rollback failed, needs manual reconcile', { orderId: p.orderId }, e2))
        }
      }
    } catch (e) {
      result.walletRefundFailed++
      log.error('wallet reconcile phase failed', {}, e)
    }

    // 3) 隐私生命周期:完结满180天的订单,清除联系方式/称呼/地址/门牌并删除照片
    //    保留期从订单【完结时刻】起算;发布时间必然早于
    //    完结时间,先用带索引的 publishedAt 粗筛,再逐单按终态时间精判
    //    有未处理投诉的订单跳过;privacyCleaned 标记防重,_.neq(true) 同时命中缺字段的历史订单
    //    分页续扫:投诉未结/完结未满期/删除失败的记录都跳过且不推进,固定 limit
    //    的单页查询会让他们永久占据页窗;按 _id 游标翻页,单轮实际清理数仍守上限
    //    单单隔离:count 与标记落库的抖动不能冒泡——异常冒泡会让阶段 4/5 整轮跳过
    const RETENTION_MS = 180 * 24 * 3600 * 1000
    const MAX_PRIVACY_CLEAN = 50
    try {
      let lastId = ''
      for (;;) {
        const stale2Cond = {
          status: _.in([STATUS.COMPLETED, STATUS.CANCELLED]),
          publishedAt: _.lt(new Date(now - RETENTION_MS)),
          privacyCleaned: _.neq(true)
        }
        const stale2 = (await db.collection('orders').where(lastId
          ? _.and([stale2Cond, { _id: _.gt(lastId) }])
          : stale2Cond).orderBy('_id', 'asc').limit(50).get()).data
        if (!stale2.length) break

        for (const o of stale2) {
          if (result.privacyCleaned >= MAX_PRIVACY_CLEAN) break
          // 完结时间:确认(含自动确认)取 confirmedAt,取消取 cancelledAt;历史缺失保守回退发布时间
          const doneAt = new Date(o.confirmedAt || o.cancelledAt || o.publishedAt).getTime()
          if (isNaN(doneAt) || doneAt > now - RETENTION_MS) continue
          try {
            const openComplaints = (await db.collection('complaints')
              .where({ orderId: o._id, status: 'open' }).count()).total
            if (openComplaints > 0) continue
          } catch (e) {
            result.privacyCleanFailed++
            log.error('privacy clean complaint count failed, will retry next run', { orderId: o._id }, e)
            continue
          }
          try {
            // 删除失败不打清理标记,留给下一轮重试,文件线索不丢
            await deleteFilesStrict(o.photos)
          } catch (e) {
            log.error('privacy clean deleteFile failed, will retry next run', { orderId: o._id }, e)
            continue
          }
          try {
            await db.collection('orders').doc(o._id).update({
              data: {
                userPhone: '', userName: '', addressDetail: '', masterPhone: '', photos: [],
                // 终态单长期留存无保留地址的必要,与注销清理同口径
                address: '', location: null,
                privacyCleaned: true, privacyCleanedAt: db.serverDate()
              }
            })
          } catch (e) {
            // 标记落库失败:文件已删、标记未落,下一轮重删("文件不存在"视为成功)后收敛
            result.privacyCleanFailed++
            log.error('privacy clean mark failed, will retry next run', { orderId: o._id }, e)
            continue
          }
          result.privacyCleaned++
        }
        if (result.privacyCleaned >= MAX_PRIVACY_CLEAN) break
        if (stale2.length < 50) break
        lastId = stale2[stale2.length - 1]._id
      }
    } catch (e) {
      // 阶段查询失败也不拖垮后面的媒体补偿与孤儿清理阶段
      result.privacyCleanFailed++
      log.error('privacy clean phase failed', {}, e)
    }

    // 4) 违规图删除失败的补偿重试:mediaCheckCallback 打了 cleanupPending 的记录
    const pendingClean = (await db.collection('media_checks')
      .where({ cleanupPending: true }).limit(20).get()).data
    for (const c of pendingClean) {
      try {
        await deleteFilesStrict([c.fileID])
        await db.collection('media_checks').doc(c._id).update({
          data: { cleanupPending: false, cleanedAt: db.serverDate() }
        })
        result.mediaCleanupRetried++
      } catch (e) {
        log.error('media cleanup retry failed', { checkId: c._id, fileID: c.fileID }, e)
      }
    }
    // 4b) 违规处置补偿(评审):mediaCheckCallback 认领后业务文档更新失败(applyPending)
    //     或认领后崩溃的记录会卡在 processing;超过1小时的按认领时存下的 suggest 重放处置。
    //     目标文档已删除的由 mediaApply 置 superseded 终态,不会永久重放
    const stuckApply = (await db.collection('media_checks').where({
      status: 'processing',
      claimedAt: _.lt(new Date(now - 3600 * 1000))
    }).limit(20).get()).data
    for (const c of stuckApply) {
      try {
        const outcome = await applyMediaRisk(c)
        if (outcome !== 'failed') result.mediaApplyRetried++
      } catch (e) {
        log.error('media apply retry failed', { checkId: c._id }, e)
      }
    }
    // 5) 上传登记清理:registerUpload 登记满24h仍是 pending 的清单,
    //    核对文件是否已被业务记录引用;未引用的即"上传成功但提交未完成"的孤儿,删除。
    //    正常提交的清单也会走到这里被标记 resolved(其文件全部有引用,零删除)。
    //    删除失败不标记,留给下一轮重试
    const staleUploads = (await db.collection('upload_logs').where({
      status: 'pending',
      createdAt: _.lt(new Date(now - 24 * 3600 * 1000))
    }).limit(20).get()).data
    for (const up of staleUploads) {
      try {
        const referenced = new Set()
        if (up.scene === 'order') {
          // 登记发生在建单前几秒,取登记时刻(留1小时时钟余量)之后该用户的订单即可覆盖
          const orders = (await db.collection('orders').where({
            userOpenid: up.openid,
            publishedAt: _.gt(new Date(new Date(up.createdAt).getTime() - 3600 * 1000))
          }).limit(100).get()).data
          for (const o of orders) for (const p of (o.photos || [])) referenced.add(p)
        } else if (up.scene === 'listing') {
          // 商品:同口径按卖家近期上架核销(不加这个分支会掉进资质分支,商品图被当孤儿误删)
          const ls = (await db.collection('listings').where({
            sellerOpenid: up.openid,
            createdAt: _.gt(new Date(new Date(up.createdAt).getTime() - 3600 * 1000))
          }).limit(100).get()).data
          for (const l of ls) for (const p of (l.photos || [])) referenced.add(p)
        } else if (up.scene === 'avatar') {
          // 展示头像:核销 masters.avatarPhoto(不加此分支会掉进资质分支,头像被当孤儿误删)
          const m = (await db.collection('masters').where({ openid: up.openid }).get()).data[0]
          if (m && m.avatarPhoto) referenced.add(m.avatarPhoto)
        } else {
          // 资质:qualPhotos 在用;orphanQualPhotos 已有独立清理线索,不重复处理
          const m = (await db.collection('masters').where({ openid: up.openid }).get()).data[0]
          if (m) for (const p of [...(m.qualPhotos || []), ...(m.orphanQualPhotos || [])]) referenced.add(p)
        }
        const orphans = (up.fileIDs || []).filter(f => !referenced.has(f))
        if (orphans.length) await deleteFilesStrict(orphans)
        await db.collection('upload_logs').doc(up._id).update({
          data: { status: 'resolved', orphanCount: orphans.length, resolvedAt: db.serverDate() }
        })
        result.uploadLogsResolved++
        result.uploadOrphansCleaned += orphans.length
      } catch (e) {
        log.error('upload log cleanup failed, will retry next run', { logId: up._id, openid: up.openid }, e)
      }
    }
  } catch (e) {
    // 记录后继续走写日志,定时器失败不能再静默
    log.error('cronTimeout run failed', {}, e)
    result.error = (e && (e.errMsg || e.message)) || String(e)
  }

  // 运行留痕:管理后台"运营体检"读取最近一条判断定时器是否健康
  try {
    await db.collection('cron_logs').add({
      data: Object.assign({ startedAt: new Date(now), durationMs: Date.now() - now }, result)
    })
  } catch (e) {
    log.error('cron_logs write failed', {}, e)
  }

  return result
}
