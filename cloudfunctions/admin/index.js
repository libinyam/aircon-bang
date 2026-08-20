// 管理操作(白名单校验):师傅审核/资格撤销、手动开通会员、订单/商品/投诉总览、数据库初始化
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const { STATUS, normalizeCity, LISTING_STATUS } = require('./biz')
// 集合清单唯一源 _shared/collections.js,与 login.ensureCollections 共用
const { AUTO_COLLECTIONS } = require('./collections')
const deleteFilesStrict = require('./storage')(cloud)
const log = require('./logger')('admin')

function bad(msg) { return { ok: false, msg } }

// 资质照片换成临时链接下发:配合云存储"仅创建者可读写",管理员也能看图
async function withQualURLs(masters) {
  for (const m of masters) {
    if (m.qualPhotos && m.qualPhotos.length) {
      try {
        const r = await cloud.getTempFileURL({ fileList: m.qualPhotos })
        m.qualPhotos = r.fileList.map(f => f.tempFileURL || f.fileID)
      } catch (e) { /* 换链失败保留 fileID */ }
    }
  }
  return masters
}

async function requireAdmin(openid) {
  try {
    const cfg = (await db.collection('config').doc('app').get()).data
    return (cfg.adminOpenids || []).includes(openid)
  } catch (e) {
    return false
  }
}

// 资格变更联动(评审):批量下架该卖家在售商品(where on_sale,天然幂等,重试安全)。
// 失败不静默:持久化 listingSyncPending 三字段到师傅档案(masterId 即 openid 即 sellerOpenid),
// 管理端据持久化标志展示警示与"重试下架"按钮——不能只靠一次性返回值,页面一刷新就丢
async function syncMasterListingsOffShelf(masterId) {
  try {
    const r = await db.collection('listings').where({
      sellerOpenid: masterId, status: LISTING_STATUS.ON_SALE
    }).update({
      data: { status: LISTING_STATUS.OFF_SHELF, offShelfAt: db.serverDate(), offShelfReason: '师傅资格变更,已自动下架' }
    })
    await db.collection('masters').doc(masterId).update({
      data: { listingSyncPending: false, listingSyncPendingCount: 0, listingSyncError: '' }
    }).catch(() => { /* 标志清理失败无害:重试按钮再跑一次即清 */ })
    return { synced: true, count: r.stats.updated }
  } catch (e) {
    log.error('listing sync off-shelf failed, flagged for retry', { masterId }, e)
    let count = -1  // -1=待下架数未知(计数也失败)
    try {
      count = (await db.collection('listings').where({
        sellerOpenid: masterId, status: LISTING_STATUS.ON_SALE
      }).count()).total
    } catch (e2) { /* 保留 -1 */ }
    await db.collection('masters').doc(masterId).update({
      data: { listingSyncPending: true, listingSyncPendingCount: count, listingSyncError: (e && e.message) || String(e) }
    }).catch(e2 => log.error('listing sync flag persist failed, 需人工处理', { masterId }, e2))
    return { synced: false, count }
  }
}

const actions = {
  // 首次部署用:自动创建其余集合(config 集合需手动创建,见 README)
  async initDb() {
    const created = []
    for (const n of AUTO_COLLECTIONS) {
      try { await db.createCollection(n); created.push(n) } catch (e) { /* 已存在 */ }
    }
    return { ok: true, created }
  },

  // 部署自检:跑一遍与 getOrders.pool 完全相同形状的订单池查询(含第二页),
  // 索引缺失/查询组合不被支持时,由管理员在部署阶段发现,而不是真实师傅先撞上。
  // 查询条件若与 getOrders 的 pool 不一致,自检就失去意义——改那边记得同步这里
  async smokePool({ cityName = '', category = '' }) {
    const m = (await db.collection('masters').where({ status: 'approved' }).limit(1).get()).data[0]
    const city = cityName || (m && m.serviceCity) || '广州市'
    const cats = category ? [category] : ((m && m.categories && m.categories.length) ? m.categories : ['repair'])
    const where = {
      status: STATUS.PUBLISHED,
      cityKey: (m && m.cityKey) || normalizeCity(city),
      userOpenid: _.neq('__smoke__'),
      category: _.in(cats),
      publishedAt: _.gt(new Date(Date.now() - 48 * 3600 * 1000)),
      expectEnd: _.gt(new Date())
    }
    const t0 = Date.now()
    try {
      const q = () => db.collection('orders').where(where).orderBy('publishedAt', 'desc')
      const page1 = (await q().limit(20).get()).data
      const page2 = (await q().skip(20).limit(20).get()).data
      return { ok: true, city, categories: cats, page1: page1.length, page2: page2.length, elapsedMs: Date.now() - t0 }
    } catch (e) {
      return bad('订单池查询失败(大概率缺索引,见 README 索引清单): ' + (e.errMsg || e.message || e))
    }
  },

  // 城市匹配键回填:部署 cityKey 改造后跑一次,存量师傅/订单按现行归一化规则补键。
  // 幂等:键已一致的跳过;归一化规则将来若调整,重跑即可全量对齐
  async backfillCityKeys() {
    const result = { masters: 0, orders: 0 }
    const ms = (await db.collection('masters').limit(1000).get()).data
    for (const m of ms) {
      const key = normalizeCity(m.serviceCity)
      if (m.cityKey === key) continue
      await db.collection('masters').doc(m._id).update({ data: { cityKey: key } })
      result.masters++
    }
    const os = (await db.collection('orders').limit(1000).get()).data
    for (const o of os) {
      const key = normalizeCity(o.cityName)
      if (o.cityKey === key) continue
      await db.collection('orders').doc(o._id).update({ data: { cityKey: key } })
      result.orders++
    }
    log.info('cityKey backfill done', result)
    return Object.assign({ ok: true }, result)
  },

  // 运营体检:定时器是否活着 + 各类待办积压,管理后台顶部展示
  async health() {
    const lastCron = (await db.collection('cron_logs')
      .orderBy('startedAt', 'desc').limit(1).get().catch(() => ({ data: [] }))).data[0] || null
    const cronAgeHours = lastCron
      ? Math.round((Date.now() - new Date(lastCron.startedAt).getTime()) / 3600000 * 10) / 10
      : null

    // 图片送检超过2小时仍 pending:回调没配置或回调失败的信号
    const mediaStuck = (await db.collection('media_checks').where({
      status: 'pending',
      createdAt: _.lt(new Date(Date.now() - 2 * 3600 * 1000))
    }).count().catch(() => ({ total: 0 }))).total

    // 违规图删除失败待补偿的数量:cronTimeout 每小时重试,长期>0 需人工看存储权限
    const mediaCleanupFailed = (await db.collection('media_checks').where({
      cleanupPending: true
    }).count().catch(() => ({ total: 0 }))).total

    const openComplaints = (await db.collection('complaints').where({ status: 'open' }).count()
      .catch(() => ({ total: 0 }))).total
    // 删除申请:open/pending_retry 都算待办;10天未执行完预警(隐私文案承诺15个工作日,)
    const openDel = (await db.collection('deletion_requests')
      .where({ status: _.in(['open', 'pending_retry']) }).limit(1000).get()
      .catch(() => ({ data: [] }))).data
    const openDeletions = openDel.length
    const deletionsOverdue = openDel.filter(d =>
      new Date(d.reopenedAt || d.createdAt) < new Date(Date.now() - 10 * 24 * 3600 * 1000)).length
    const pendingMasters = (await db.collection('masters').where({ status: 'pending' }).count()
      .catch(() => ({ total: 0 }))).total

    return {
      ok: true,
      cron: lastCron ? {
        ageHours: cronAgeHours,
        // 定时器每小时应跑一次,超过2.5小时没记录=触发器没配或函数挂了
        stale: cronAgeHours === null || cronAgeHours > 2.5,
        error: lastCron.error || '',
        closed: lastCron.closed, autoConfirmed: lastCron.autoConfirmed, privacyCleaned: lastCron.privacyCleaned
      } : { ageHours: null, stale: true, error: '', closed: 0, autoConfirmed: 0, privacyCleaned: 0 },
      mediaStuck, mediaCleanupFailed, openComplaints, openDeletions, deletionsOverdue, pendingMasters
    }
  },

  async pendingMasters() {
    const data = (await db.collection('masters').where({ status: 'pending' })
      .orderBy('appliedAt', 'asc').limit(50).get()).data
    return { ok: true, data: await withQualURLs(data) }
  },

  async allMasters() {
    const data = (await db.collection('masters').orderBy('appliedAt', 'desc').limit(100).get()).data
    return { ok: true, data: await withQualURLs(data) }
  },

  async auditMaster({ masterId, pass, reason = '' }, openid) {
    if (!masterId) return bad('参数错误')
    // 前置态条件更新:只有 pending 可被审,防两管理员同时操作互相覆盖
    // operator/auditedAt 审计留痕:资质审核涉及敏感个人信息处理决定,须可追溯
    const res = await db.collection('masters').where({ _id: masterId, status: 'pending' }).update({
      data: Object.assign(
        pass
          ? { status: 'approved', rejectReason: '' }
          : { status: 'rejected', rejectReason: reason || '资料不符合要求' },
        { operator: openid, auditedAt: db.serverDate() }
      )
    })
    if (res.stats.updated === 0) return bad('该申请已被处理或状态已变化,请刷新')
    // 驳回联动:重新提交被驳回的师傅可能还挂着在售商品(approved 期间发布的),批量下架
    if (!pass) {
      const sync = await syncMasterListingsOffShelf(masterId)
      if (!sync.synced) return { ok: true, partial: true, listingSyncPendingCount: sync.count }
      return { ok: true, listingsOffShelf: sync.count }
    }
    return { ok: true }
  },

  // 运营撤销已通过的师傅资格(评审):与"审核驳回"是两个动作,auditMaster 只处理 pending。
  // 撤销后其在售商品批量下架;contact 接口每次复查 approved 是读时第二道闸
  async revokeMaster({ masterId, reason = '' }, openid) {
    if (!masterId) return bad('参数错误')
    if (!reason.trim()) return bad('请填写撤销原因(会展示给师傅)')
    const res = await db.collection('masters').where({ _id: masterId, status: 'approved' }).update({
      data: { status: 'rejected', rejectReason: reason, operator: openid, auditedAt: db.serverDate() }
    })
    if (res.stats.updated === 0) return bad('该师傅不是已通过状态,请刷新')
    log.info('master revoked', { masterId, operator: openid })
    const sync = await syncMasterListingsOffShelf(masterId)
    if (!sync.synced) return { ok: true, partial: true, listingSyncPendingCount: sync.count }
    return { ok: true, listingsOffShelf: sync.count }
  },

  // 商品批量下架补偿(评审):auditMaster/revokeMaster 联动失败后,管理端"重试下架"按钮调这里;
  // 幂等,成功即清除师傅档案上的 listingSyncPending 标志
  async offShelfSellerListings({ masterId }) {
    if (!masterId) return bad('参数错误')
    const sync = await syncMasterListingsOffShelf(masterId)
    if (!sync.synced) return bad('批量下架仍失败,请稍后重试')
    return { ok: true, listingsOffShelf: sync.count }
  },

  // 线下收款后手动开通会员:在现有到期时间(未到期)或今天的基础上顺延 months 个月
  // 幂等设计:requestId 作 member_logs 文档ID,重复提交在写日志时失败;
  // 顺延失败则回滚日志,保证"到期日没变就没有日志"
  async grantMember({ masterId, months, amount = 0, note = '', requestId }, openid) {
    const m = parseInt(months, 10)
    if (!masterId || !(m >= 1 && m <= 36)) return bad('月数需在1-36之间')
    if (!requestId || typeof requestId !== 'string' || requestId.length > 64) return bad('缺少请求标识,请关闭弹窗重试')
    // 空串会被 Number 转成 0,先拦掉:账务日志里"没填"和"免费开通0元"必须可区分
    if (amount === '' || amount === null || amount === undefined) return bad('请填写实收金额(免费开通请填0)')
    const amt = Number(amount)
    if (!isFinite(amt) || amt < 0) return bad('金额不合法')

    const master = (await db.collection('masters').doc(masterId).get().catch(() => ({ data: null }))).data
    if (!master) return bad('师傅不存在')
    if (master.status !== 'approved') return bad('请先通过该师傅的入驻审核')

    const base = master.memberExpireAt && new Date(master.memberExpireAt) > new Date()
      ? new Date(master.memberExpireAt) : new Date()
    const expire = new Date(base.getTime() + m * 30 * 24 * 3600 * 1000)

    try {
      await db.collection('member_logs').add({
        data: {
          _id: requestId,
          masterId,
          masterName: master.realName,
          months: m,
          amount: amt,
          note,
          operator: openid,
          oldExpireAt: master.memberExpireAt || null,
          newExpireAt: expire,
          createdAt: db.serverDate()
        }
      })
    } catch (e) {
      return bad('该笔开通已处理过,请勿重复提交')
    }

    try {
      // 条件原子顺延:以读取时的到期日为前置条件,两管理员并发开通时
      // 后一笔命中 0 行报冲突,不会静默丢掉一笔顺延
      const res = await db.collection('masters').where({
        _id: masterId,
        memberExpireAt: master.memberExpireAt || null
      }).update({ data: { memberExpireAt: expire } })
      if (res.stats.updated === 0) throw new Error('memberExpireAt changed concurrently')
    } catch (e) {
      await db.collection('member_logs').doc(requestId).remove()
        .catch(err => log.error('member_logs rollback failed, 需人工核对', { requestId }, err))
      return bad('开通冲突或失败,请刷新后重试')
    }
    return { ok: true, memberExpireAt: expire }
  },

  async orders({ page = 0 }) {
    const data = (await db.collection('orders').orderBy('publishedAt', 'desc')
      .skip(page * 20).limit(20).get()).data
    return { ok: true, data }
  },

  async complaints() {
    const data = (await db.collection('complaints').orderBy('createdAt', 'desc').limit(50).get()).data
    return { ok: true, data }
  },

  // 商品总览(买空调频道):管理端视角含 removedBy;首图换临时链接供审阅
  async listListings({ page = 0, status = '' }) {
    let q = db.collection('listings')
    if (status && Object.values(LISTING_STATUS).includes(status)) q = q.where({ status })
    const data = (await q.orderBy('createdAt', 'desc').skip(page * 20).limit(20).get()).data
    const firsts = data.map(l => (l.photos || [])[0]).filter(Boolean)
    if (firsts.length) {
      try {
        const r = await cloud.getTempFileURL({ fileList: firsts })
        const urlMap = {}
        for (const f of r.fileList) if (f.tempFileURL) urlMap[f.fileID] = f.tempFileURL
        for (const l of data) {
          const first = (l.photos || [])[0]
          l.cover = first ? (urlMap[first] || '') : ''
        }
      } catch (e) { /* 换链失败无图,不阻断列表 */ }
    }
    return { ok: true, data, hasMore: data.length === 20 }
  },

  // 强制下架(违规商品):removed 为终态,卖家不可自行恢复;原因必填会展示给卖家
  // 不删照片:单图违规已由 mediaCheck 摘除兜底,整体下架后内容对外已不可见
  async takedownListing({ listingId, reason = '' }, openid) {
    if (!listingId) return bad('参数错误')
    if (!reason.trim()) return bad('请填写下架原因(会展示给卖家)')
    const res = await db.collection('listings').where({
      _id: listingId, status: _.in([LISTING_STATUS.ON_SALE, LISTING_STATUS.OFF_SHELF])
    }).update({
      data: { status: LISTING_STATUS.REMOVED, removedReason: reason, removedBy: openid, removedAt: db.serverDate() }
    })
    if (res.stats.updated === 0) return bad('该商品状态已变化,请刷新')
    log.info('listing taken down', { listingId, operator: openid })
    return { ok: true }
  },

  async handleComplaint({ complaintId, note = '' }, openid) {
    if (!complaintId) return bad('参数错误')
    if (!note.trim()) return bad('请填写处理记录(用户可能据此追溯)')
    // 前置态条件更新 + operator 留痕:并发关同一投诉时后写者报冲突,
    // 不再互相覆盖 handleNote;投诉可能涉及费用纠纷,处理人须可追溯
    const res = await db.collection('complaints').where({ _id: complaintId, status: 'open' }).update({
      data: { status: 'closed', handleNote: note, handledAt: db.serverDate(), operator: openid }
    })
    if (res.stats.updated === 0) return bad('该投诉已被处理,请刷新')
    // 投诉闭环推进:该单已无其他未结投诉时解除自动确认冻结,
    // 订单回到正常轨道——用户可手动确认,已超 72h 的由下一轮 cron 恢复自动确认。
    // 这里清失败也不阻断关单,cron 的残留标记自愈兜底
    const c = (await db.collection('complaints').doc(complaintId).get().catch(() => ({ data: null }))).data
    if (c && c.orderId) {
      const stillOpen = (await db.collection('complaints')
        .where({ orderId: c.orderId, status: 'open' }).count()).total
      if (stillOpen === 0) {
        await db.collection('orders').where({ _id: c.orderId, disputeHold: true })
          .update({ data: { disputeHold: false } })
          .catch(e => log.error('dispute hold clear failed, cron will self-heal', { orderId: c.orderId }, e))
      }
    }
    return { ok: true }
  },

  // 账号数据删除申请:列表 + 处理留痕(处理人/时间/结果可审计)
  async deletionRequests() {
    const data = (await db.collection('deletion_requests').orderBy('createdAt', 'desc').limit(50).get()).data
    return { ok: true, data }
  },

  async handleDeletionRequest({ requestId, note = '' }, openid) {
    if (!requestId) return bad('参数错误')
    if (!note.trim()) return bad('请填写处理记录(删的什么/留了什么及原因)')
    // 关单前置条件收紧:必须先 executeDeletion 执行成功(executed),
    // 不能仅凭备注直接关闭——"已处理"必须与可验证的数据处理结果绑定
    const res = await db.collection('deletion_requests').where({ _id: requestId, status: 'executed' }).update({
      data: { status: 'closed', handleNote: note, handledAt: db.serverDate(), operator: openid }
    })
    if (res.stats.updated === 0) return bad('请先执行数据删除,执行成功后才能关闭')
    return { ok: true }
  },

  // 账号删除执行:真正删除/匿名化数据,结果落盘后工单才可关闭
  // 各集合处理策略(须与隐私说明页口径一致):
  //   users             删除文档(重新进入小程序会重建空档案)
  //   masters           删资质照片文件后删除文档;pending 送检记录作废
  //   orders            终态单匿名化:联系方式/称呼/门牌/照片清除,openid 改 'deleted' 解除关联
  //                     (防止同 openid 重新登录后旧订单复联);进行中订单是阻断项
  //   listings          删照片后删除文档(纯营销内容无对手方凭证价值);其检测记录一并删除
  //                     (media_checks 的 fileID 路径含 openid,对商品类不能按"技术元数据"保留)
  //   contact_logs      删除本人(作为买家)的取号计数文档
  //   reviews           星级/内容保留(已聚合进师傅评分,发布时经内容安全),openid 解除关联
  //   complaints        已关闭的保留内容作纠纷处理凭证,fromOpenid 解除关联;未结投诉是阻断项
  //   member_logs       保留(账务凭证:金额/月数/时间/操作人),仅清 masterName
  //   media_checks      保留(仅 traceId 技术元数据;fileID 路径含 openid 已置空,文件本体已删除)
  //   upload_logs       删文档(pending 的先删登记文件)
  //   deletion_requests 本工单即处理凭证,保留
  async executeDeletion({ requestId }, openid) {
    if (!requestId) return bad('参数错误')
    const req = (await db.collection('deletion_requests').doc(requestId).get()
      .catch(() => ({ data: null }))).data
    if (!req) return bad('申请不存在')
    if (req.status !== 'open' && req.status !== 'pending_retry') return bad('该申请已执行完成或已关闭')
    const target = req.openid

    // 1) 阻断项:进行中订单与未结投诉先处理完,服务与纠纷凭证不能先销毁
    const ACTIVE = [STATUS.PUBLISHED, STATUS.ACCEPTED, STATUS.PENDING_CONFIRM]
    const userOrders = (await db.collection('orders').where({ userOpenid: target }).limit(1000).get()).data
    const masterOrders = (await db.collection('orders').where({ masterOpenid: target }).limit(1000).get()).data
    const blockers = []
    const activeU = userOrders.filter(o => ACTIVE.includes(o.status)).length
    const activeM = masterOrders.filter(o => ACTIVE.includes(o.status)).length
    if (activeU) blockers.push(`进行中订单(作为用户)${activeU}单`)
    if (activeM) blockers.push(`进行中订单(作为师傅)${activeM}单`)
    const orderIds = userOrders.concat(masterOrders).map(o => o._id)
    if (orderIds.length) {
      const cnt = (await db.collection('complaints')
        .where({ orderId: _.in(orderIds), status: 'open' }).count()).total
      if (cnt) blockers.push(`涉及其订单的未结投诉${cnt}条`)
    }
    const ownComplaints = (await db.collection('complaints')
      .where({ fromOpenid: target, status: 'open' }).count()).total
    if (ownComplaints) blockers.push(`本人发起的未结投诉${ownComplaints}条`)
    if (blockers.length) {
      await db.collection('deletion_requests').doc(requestId).update({
        data: { lastBlockers: blockers, lastBlockedAt: db.serverDate() }
      })
      return { ok: true, blocked: true, blockers }
    }

    // 2) 执行:文件删除逐批留痕,失败不阻断其他步骤,最后统一决定 executed / pending_retry
    const failedFiles = []
    const summary = {
      ordersAnonymized: 0, masterOrdersAnonymized: 0, reviewsUnlinked: 0,
      complaintsUnlinked: 0, uploadLogsRemoved: 0, filesDeleted: 0,
      listingsRemoved: 0, contactLogsRemoved: 0, mediaChecksUnlinked: 0,
      userRemoved: false, masterRemoved: false
    }
    const tryDelete = async (files, tag) => {
      const list = (files || []).filter(Boolean)
      if (!list.length) return true
      try {
        await deleteFilesStrict(list)
        summary.filesDeleted += list.length
        return true
      } catch (e) {
        failedFiles.push(...list)
        log.error('deletion file delete failed, will retry', { requestId, tag }, e)
        return false
      }
    }

    // 上传登记:pending 的先删文件,文档一律移除
    const uploadLogs = (await db.collection('upload_logs').where({ openid: target }).limit(1000).get()).data
    for (const l of uploadLogs) {
      if (l.status === 'pending' && !(await tryDelete(l.fileIDs, 'upload_logs'))) continue
      await db.collection('upload_logs').doc(l._id).remove()
      summary.uploadLogsRemoved++
    }

    // 商品(买空调频道):照片删净才删文档,失败保留 fileID 线索待重试;
    // 该商品的检测记录一并删除——fileID 路径含 openid,对商品类不能按"技术元数据"保留(评审)
    const listings = (await db.collection('listings').where({ sellerOpenid: target }).limit(1000).get()).data
    for (const l of listings) {
      if (!(await tryDelete(l.photos, 'listing photos'))) continue
      await db.collection('listings').doc(l._id).remove()
      await db.collection('media_checks').where({ targetId: l._id }).remove()
      summary.listingsRemoved++
    }
    // 取号计数(作为买家):按文档内 viewerOpenid 清理(_id 是哈希,不含裸 openid)
    const cl = await db.collection('contact_logs').where({ viewerOpenid: target }).remove()
    summary.contactLogsRemoved = (cl.stats && cl.stats.removed) || 0

    // 作为用户的订单:照片删除成功才匿名化,失败保留 fileID 线索待重试(与 同策略)
    const anonymizedOrderIds = []
    for (const o of userOrders) {
      if (!(await tryDelete(o.photos, 'order photos'))) continue
      await db.collection('orders').doc(o._id).update({
        data: {
          userOpenid: 'deleted', userPhone: '', userName: '', addressDetail: '',
          masterPhone: '', photos: [], privacyCleaned: true, deletionCleanedAt: db.serverDate()
        }
      })
      anonymizedOrderIds.push(o._id)
      summary.ordersAnonymized++
    }

    // 作为师傅的订单:清师傅侧字段并解除关联(用户侧数据不动,那是对方的服务记录)
    for (const o of masterOrders) {
      await db.collection('orders').doc(o._id).update({
        data: { masterOpenid: 'deleted', masterName: '', masterPhone: '' }
      })
      summary.masterOrdersAnonymized++
    }

    // 评价/已关闭投诉:解除主体关联
    const r1 = await db.collection('reviews').where({ userOpenid: target }).update({ data: { userOpenid: 'deleted' } })
    const r2 = await db.collection('reviews').where({ masterOpenid: target }).update({ data: { masterOpenid: 'deleted' } })
    summary.reviewsUnlinked = r1.stats.updated + r2.stats.updated
    const r3 = await db.collection('complaints').where({ fromOpenid: target, status: 'closed' })
      .update({ data: { fromOpenid: 'deleted' } })
    summary.complaintsUnlinked = r3.stats.updated

    // 师傅档案:作废未完成送检,资质照片(含历史孤儿)与展示头像删净才删档案;
    // 头像同属师傅个人照片(真人照),漏删会在注销后继续泄露
    const master = (await db.collection('masters').where({ openid: target }).get()).data[0]
    if (master) {
      await db.collection('media_checks').where({ targetId: master._id, status: 'pending' })
        .update({ data: { status: 'superseded' } })
      const masterFiles = [...(master.qualPhotos || []), ...(master.orphanQualPhotos || []),
        ...(master.avatarPhoto ? [master.avatarPhoto] : [])]
      if (await tryDelete(masterFiles, 'masterPhotos')) {
        await db.collection('masters').doc(master._id).remove()
        summary.masterRemoved = true
      }
      await db.collection('member_logs').where({ masterId: master._id }).update({ data: { masterName: '' } })
    }

    // 存量检测记录脱敏:订单/资质的 media_checks 保留 traceId 技术元数据,
    // 但 fileID 路径含被删账号 openid(orders/{openid}/、quals/{openid}/),非匿名数据,一并置空。
    // 只处理已成功匿名化/已删档的目标——照片删除失败的目标仍留 fileID 供清理重试(cron 按它删文件)
    const scrubTargets = anonymizedOrderIds.concat(summary.masterRemoved && master ? [master._id] : [])
    if (scrubTargets.length) {
      const rmc = await db.collection('media_checks').where({ targetId: _.in(scrubTargets) })
        .update({ data: { fileID: '' } })
      summary.mediaChecksUnlinked = rmc.stats.updated
    }

    // 用户档案删除:真实异常不能吞——只删失败也必须让工单进 pending_retry,
    // 否则后台显示已完成但档案还在。幂等由"落盘前核验文档不可读取"保证:文档本来
    // 就不存在(重跑)与删除成功同样通过核验,userRemoved 只在核验通过后才置 true
    const failedOps = []
    try {
      await db.collection('users').doc(target).remove()
    } catch (e) {
      log.error('deletion users.remove failed, will retry', { requestId, target }, e)
    }
    const userLeft = (await db.collection('users').where({ _id: target }).count()).total
    if (userLeft === 0) summary.userRemoved = true
    else failedOps.push('users.remove:' + target)

    // 3) 结果落盘:有失败保持 pending_retry(工单不会显示已完成),全部成功才 executed
    if (failedFiles.length || failedOps.length) {
      await db.collection('deletion_requests').doc(requestId).update({
        data: { status: 'pending_retry', failedFiles, failedOps, lastRunAt: db.serverDate(), lastRunBy: openid }
      })
      return { ok: true, partial: true, failedCount: failedFiles.length + failedOps.length, summary }
    }
    const retained = [
      'member_logs:账务凭证保留,已清姓名',
      'reviews/已关闭complaints:内容保留作服务与纠纷凭证,主体标识已解除关联',
      'media_checks:仅 traceId 技术元数据保留,fileID 路径含 openid 已置空,文件本体已删除'
    ]
    await db.collection('deletion_requests').doc(requestId).update({
      data: {
        status: 'executed', failedFiles: [], failedOps: [], lastBlockers: [],
        execution: Object.assign({ operator: openid, executedAt: new Date(), retained }, summary)
      }
    })
    log.info('deletion executed', { requestId, filesDeleted: summary.filesDeleted, ordersAnonymized: summary.ordersAnonymized })
    return { ok: true, summary }
  }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  if (!(await requireAdmin(OPENID))) return bad('无管理权限')

  const fn = actions[event.action]
  if (!fn) return bad('未知操作')
  return fn(event, OPENID)
}
