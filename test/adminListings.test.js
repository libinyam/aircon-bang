// admin 商品管理:强制下架留痕、资格撤销联动与持久化补偿、删号清理商品(买空调频道)
const { fakeDb } = require('./stubs/fakeDb')
const { LISTING_STATUS } = require('../cloudfunctions/_shared/biz')

const fid = (o, n) => `cloud://env.x/listings/${o}/${n}.jpg`

async function callAdmin(fx, event, openid = 'admin-1') {
  jest.resetModules()
  global.__mockDb = fakeDb(fx)
  global.__mockCtx = { OPENID: openid }
  global.__deletedFiles = []
  const { main } = require('../cloudfunctions/admin/index')
  const res = await main(event)
  const deleted = global.__deletedFiles
  delete global.__mockDb
  delete global.__mockCtx
  delete global.__deletedFiles
  delete global.__failUpdate
  return { res, deleted }
}

const BASE = () => ({
  config: [{ _id: 'app', adminOpenids: ['admin-1'] }],
  masters: [],
  listings: [],
  media_checks: [],
  contact_logs: []
})

const mkListing = (over = {}) => Object.assign({
  _id: 'l1', sellerOpenid: 'm1', status: LISTING_STATUS.ON_SALE,
  photos: [fid('m1', 'a')], createdAt: new Date()
}, over)

describe('takedownListing 强制下架', () => {
  test('原因必填;下架写 removedBy/removedReason/removedAt 留痕', async () => {
    const fx = BASE()
    fx.listings = [mkListing()]
    expect((await callAdmin(fx, { action: 'takedownListing', listingId: 'l1' })).res.ok).toBe(false)

    const { res } = await callAdmin(fx, { action: 'takedownListing', listingId: 'l1', reason: '图文不符' })
    expect(res.ok).toBe(true)
    expect(fx.listings[0]).toMatchObject({
      status: LISTING_STATUS.REMOVED, removedReason: '图文不符', removedBy: 'admin-1'
    })
    expect(fx.listings[0].removedAt).toBeTruthy()
  })

  test('重复下架/已售商品下架:前置态不符报冲突', async () => {
    const fx = BASE()
    fx.listings = [mkListing({ status: LISTING_STATUS.SOLD })]
    const { res } = await callAdmin(fx, { action: 'takedownListing', listingId: 'l1', reason: 'x' })
    expect(res.ok).toBe(false)
  })

  test('非管理员无权操作', async () => {
    const fx = BASE()
    fx.listings = [mkListing()]
    const { res } = await callAdmin(fx, { action: 'takedownListing', listingId: 'l1', reason: 'x' }, 'stranger')
    expect(res.ok).toBe(false)
    expect(fx.listings[0].status).toBe(LISTING_STATUS.ON_SALE)
  })
})

describe('listListings 商品总览', () => {
  test('分页返回 + 状态筛选 + 封面换链', async () => {
    const fx = BASE()
    fx.listings = [mkListing(), mkListing({ _id: 'l2', status: LISTING_STATUS.REMOVED })]
    const all = (await callAdmin(fx, { action: 'listListings' })).res
    expect(all.ok).toBe(true)
    expect(all.data).toHaveLength(2)
    expect(all.data[0].cover).toContain('https://tmp/')
    const removed = (await callAdmin(fx, { action: 'listListings', status: LISTING_STATUS.REMOVED })).res
    expect(removed.data).toHaveLength(1)
  })
})

describe('revokeMaster 资格撤销与商品联动(评审)', () => {
  const withMaster = () => {
    const fx = BASE()
    fx.masters = [{ _id: 'm1', openid: 'm1', status: 'approved', realName: '张三丰' }]
    fx.listings = [
      mkListing(),
      mkListing({ _id: 'l2', status: LISTING_STATUS.SOLD }),
      mkListing({ _id: 'l3', sellerOpenid: 'other', status: LISTING_STATUS.ON_SALE })
    ]
    return fx
  }

  test('撤销资格:原因必填,条件原子 approved->rejected,在售商品批量下架', async () => {
    const fx = withMaster()
    expect((await callAdmin(fx, { action: 'revokeMaster', masterId: 'm1' })).res.ok).toBe(false)

    const { res } = await callAdmin(fx, { action: 'revokeMaster', masterId: 'm1', reason: '多次有效投诉' })
    expect(res.ok).toBe(true)
    expect(res.listingsOffShelf).toBe(1)
    expect(fx.masters[0]).toMatchObject({ status: 'rejected', rejectReason: '多次有效投诉', operator: 'admin-1' })
    expect(fx.listings[0].status).toBe(LISTING_STATUS.OFF_SHELF)
    expect(fx.listings[0].offShelfReason).toContain('资格变更')
    expect(fx.listings[1].status).toBe(LISTING_STATUS.SOLD)          // 已售不动
    expect(fx.listings[2].status).toBe(LISTING_STATUS.ON_SALE)       // 他人商品不动
    expect(fx.masters[0].listingSyncPending).toBe(false)
  })

  test('非 approved 师傅不可撤销(与审核驳回是两个动作)', async () => {
    const fx = withMaster()
    fx.masters[0].status = 'pending'
    const { res } = await callAdmin(fx, { action: 'revokeMaster', masterId: 'm1', reason: 'x' })
    expect(res.ok).toBe(false)
  })

  test('联动失败不静默:持久化 listingSyncPending 三字段,重试补偿后清除', async () => {
    const fx = withMaster()
    global.__failUpdate = (name) => name === 'listings'
    const { res } = await callAdmin(fx, { action: 'revokeMaster', masterId: 'm1', reason: '违规' })
    expect(res.ok).toBe(true)
    expect(res.partial).toBe(true)
    expect(fx.masters[0].status).toBe('rejected')                     // 资格撤销本体已生效
    expect(fx.masters[0].listingSyncPending).toBe(true)               // 失败持久化,页面刷新后仍可见
    expect(fx.masters[0].listingSyncPendingCount).toBe(1)
    expect(fx.masters[0].listingSyncError).toBeTruthy()
    expect(fx.listings[0].status).toBe(LISTING_STATUS.ON_SALE)

    // 重试按钮 -> offShelfSellerListings 幂等补偿
    delete global.__failUpdate
    const { res: retry } = await callAdmin(fx, { action: 'offShelfSellerListings', masterId: 'm1' })
    expect(retry.ok).toBe(true)
    expect(retry.listingsOffShelf).toBe(1)
    expect(fx.listings[0].status).toBe(LISTING_STATUS.OFF_SHELF)
    expect(fx.masters[0].listingSyncPending).toBe(false)
    expect(fx.masters[0].listingSyncPendingCount).toBe(0)
  })

  test('auditMaster 驳回同样联动下架(重提交场景可能挂着在售商品)', async () => {
    const fx = withMaster()
    fx.masters[0].status = 'pending'
    const { res } = await callAdmin(fx, { action: 'auditMaster', masterId: 'm1', pass: false, reason: '资料造假' })
    expect(res.ok).toBe(true)
    expect(res.listingsOffShelf).toBe(1)
    expect(fx.listings[0].status).toBe(LISTING_STATUS.OFF_SHELF)
  })

  test('auditMaster 通过不触发下架', async () => {
    const fx = withMaster()
    fx.masters[0].status = 'pending'
    const { res } = await callAdmin(fx, { action: 'auditMaster', masterId: 'm1', pass: true })
    expect(res.ok).toBe(true)
    expect(fx.listings[0].status).toBe(LISTING_STATUS.ON_SALE)
  })
})

describe('executeDeletion 删号清理商品与取号记录(评审:不扩大 PII 债务)', () => {
  test('商品硬删(文档+照片+检测记录),contact_logs 按 viewerOpenid 清理', async () => {
    const fx = Object.assign(BASE(), {
      deletion_requests: [{ _id: 'dr1', openid: 'm1', status: 'open' }],
      orders: [], complaints: [], upload_logs: [], reviews: [], users: [], member_logs: [],
      listings: [
        mkListing({ photos: [fid('m1', 'a'), fid('m1', 'b')] }),
        mkListing({ _id: 'l9', sellerOpenid: 'other', photos: [fid('other', 'z')] })
      ],
      media_checks: [
        { _id: 'c1', type: 'listing', targetId: 'l1', fileID: fid('m1', 'a'), status: 'risky' },
        { _id: 'c2', type: 'listing', targetId: 'l9', fileID: fid('other', 'z'), status: 'pending' }
      ],
      contact_logs: [
        { _id: 'hash1', viewerOpenid: 'm1', day: '2026-08-01', count: 3 },
        { _id: 'hash2', viewerOpenid: 'someone', day: '2026-08-01', count: 1 }
      ]
    })
    const { res, deleted } = await callAdmin(fx, { action: 'executeDeletion', requestId: 'dr1' })
    expect(res.ok).toBe(true)
    expect(res.summary.listingsRemoved).toBe(1)
    expect(res.summary.contactLogsRemoved).toBe(1)
    expect(deleted).toEqual([fid('m1', 'a'), fid('m1', 'b')])
    expect(fx.listings.map(l => l._id)).toEqual(['l9'])                       // 他人商品不动
    expect(fx.media_checks.map(c => c._id)).toEqual(['c2'])                   // 本人商品的检测记录删净
    expect(fx.contact_logs.map(c => c.viewerOpenid)).toEqual(['someone'])
    expect(fx.deletion_requests[0].status).toBe('executed')
  })

  test('商品照片删除失败:文档保留,工单进 pending_retry', async () => {
    const fx = Object.assign(BASE(), {
      deletion_requests: [{ _id: 'dr1', openid: 'm1', status: 'open' }],
      orders: [], complaints: [], upload_logs: [], reviews: [], users: [], member_logs: [],
      listings: [mkListing()]
    })
    global.__mockDeleteFile = (fileList) => ({
      fileList: fileList.map(f => ({ fileID: f, status: 1, errMsg: 'ACCESS_DENIED' }))
    })
    const { res } = await callAdmin(fx, { action: 'executeDeletion', requestId: 'dr1' })
    delete global.__mockDeleteFile
    expect(res.partial).toBe(true)
    expect(fx.listings).toHaveLength(1)
    expect(fx.deletion_requests[0].status).toBe('pending_retry')
  })
})
