// mediaCheckCallback 违规处置时序(评审重构):
// pending -原子认领-> processing(存 suggest) -> 业务文档摘图成功 -> 才删文件 -> 落终态
// 文档更新失败打 applyPending 不删文件;目标已删置 superseded;摘光照片的在售商品自动下架
const { fakeDb } = require('./stubs/fakeDb')
const { LISTING_STATUS, STATUS } = require('../cloudfunctions/_shared/biz')

const fid = (ns, o, n) => `cloud://env.x/${ns}/${o}/${n}.jpg`

async function callCb(event, fx, { openid } = {}) {
  jest.resetModules()
  global.__mockDb = fakeDb(fx)
  // 来源上下文:默认模拟微信消息推送(无 OPENID);openid 参数模拟客户端直调
  global.__mockCtx = openid ? { OPENID: openid } : {}
  global.__deletedFiles = []
  const { main } = require('../cloudfunctions/mediaCheckCallback/index')
  const res = await main(event)
  const deleted = global.__deletedFiles
  delete global.__mockDb
  delete global.__mockCtx
  delete global.__deletedFiles
  delete global.__failUpdate
  delete global.__mockDeleteFile
  return { res, deleted }
}

const riskyEvent = (traceId) => ({ trace_id: traceId, result: { suggest: 'risky', label: 20001 } })

describe('来源校验', () => {
  test('客户端直调(带 OPENID):拒绝,伪造 risky 也不能摘图删文件', async () => {
    const fx = {
      media_checks: [{ _id: 'c1', traceId: 't1', type: 'listing', targetId: 'l1', fileID: fid('listings', 'm1', 'a'), status: 'pending' }],
      listings: [{ _id: 'l1', status: LISTING_STATUS.ON_SALE, photos: [fid('listings', 'm1', 'a')] }]
    }
    const { res, deleted } = await callCb(riskyEvent('t1'), fx, { openid: 'attacker' })
    expect(res).toContain('not from message push')
    expect(fx.media_checks[0].status).toBe('pending')
    expect(fx.listings[0].photos).toHaveLength(1)
    expect(deleted).toEqual([])
  })
})

describe('状态闸与 pass 路径', () => {
  test('pass:认领后直接落终态,不动业务文档不删文件', async () => {
    const fx = {
      media_checks: [{ _id: 'c1', traceId: 't1', type: 'listing', targetId: 'l1', fileID: fid('listings', 'm1', 'a'), status: 'pending' }],
      listings: [{ _id: 'l1', status: LISTING_STATUS.ON_SALE, photos: [fid('listings', 'm1', 'a')] }]
    }
    const { res, deleted } = await callCb({ trace_id: 't1', result: { suggest: 'pass' } }, fx)
    expect(res).toBe('ok')
    expect(fx.media_checks[0].status).toBe('pass')
    expect(fx.listings[0].photos).toHaveLength(1)
    expect(deleted).toEqual([])
  })

  test('未知 traceId / 已处理记录:忽略且无副作用(防重放,)', async () => {
    const fx = { media_checks: [{ _id: 'c1', traceId: 't1', type: 'order', targetId: 'o1', fileID: 'f', status: 'risky' }], orders: [] }
    expect((await callCb(riskyEvent('ghost'), fx)).res).toContain('unknown trace')
    const { res, deleted } = await callCb(riskyEvent('t1'), fx)
    expect(res).toContain('already handled')
    expect(deleted).toEqual([])
  })
})

describe('违规处置顺序:文档先行,文件后删(order 与 listing 同规则)', () => {
  test('order 违规:摘图+photosRisk -> 删文件 -> 终态含 suggest/claimedAt', async () => {
    const f = fid('orders', 'u1', 'a')
    const fx = {
      media_checks: [{ _id: 'c1', traceId: 't1', type: 'order', targetId: 'o1', fileID: f, status: 'pending' }],
      orders: [{ _id: 'o1', status: STATUS.ACCEPTED, photos: [f, 'keep.jpg'] }]
    }
    const { deleted } = await callCb(riskyEvent('t1'), fx)
    expect(fx.orders[0].photos).toEqual(['keep.jpg'])
    expect(fx.orders[0].photosRisk).toBe(true)
    expect(deleted).toEqual([f])
    expect(fx.media_checks[0]).toMatchObject({ status: 'risky', suggest: 'risky', applyPending: false })
    expect(fx.media_checks[0].claimedAt).toBeTruthy()
  })

  test('listing 违规:摘图后仍有照片 -> 保持在售', async () => {
    const f = fid('listings', 'm1', 'a')
    const fx = {
      media_checks: [{ _id: 'c1', traceId: 't1', type: 'listing', targetId: 'l1', fileID: f, status: 'pending' }],
      listings: [{ _id: 'l1', status: LISTING_STATUS.ON_SALE, photos: [f, 'keep.jpg'] }]
    }
    await callCb(riskyEvent('t1'), fx)
    expect(fx.listings[0].photos).toEqual(['keep.jpg'])
    expect(fx.listings[0].photosRisk).toBe(true)
    expect(fx.listings[0].status).toBe(LISTING_STATUS.ON_SALE)
  })

  test('listing 最后一张被摘 -> 自动下架并写系统原因(评审:不留在售零图商品)', async () => {
    const f = fid('listings', 'm1', 'a')
    const fx = {
      media_checks: [{ _id: 'c1', traceId: 't1', type: 'listing', targetId: 'l1', fileID: f, status: 'pending' }],
      listings: [{ _id: 'l1', status: LISTING_STATUS.ON_SALE, photos: [f] }]
    }
    const { deleted } = await callCb(riskyEvent('t1'), fx)
    expect(fx.listings[0].photos).toEqual([])
    expect(fx.listings[0].status).toBe(LISTING_STATUS.OFF_SHELF)
    expect(fx.listings[0].offShelfReason).toContain('照片违规')
    expect(deleted).toEqual([f])
  })

  test('已下架商品摘光照片:不重复动状态(条件下架只动 on_sale)', async () => {
    const f = fid('listings', 'm1', 'a')
    const fx = {
      media_checks: [{ _id: 'c1', traceId: 't1', type: 'listing', targetId: 'l1', fileID: f, status: 'pending' }],
      listings: [{ _id: 'l1', status: LISTING_STATUS.SOLD, photos: [f] }]
    }
    await callCb(riskyEvent('t1'), fx)
    expect(fx.listings[0].status).toBe(LISTING_STATUS.SOLD)
  })

  test('master 资质违规:只打 qualRisk 不删文件(留人工审核判断)', async () => {
    const fx = {
      media_checks: [{ _id: 'c1', traceId: 't1', type: 'master', targetId: 'm1', fileID: 'q.jpg', status: 'pending' }],
      masters: [{ _id: 'm1', qualRisk: false }]
    }
    const { deleted } = await callCb(riskyEvent('t1'), fx)
    expect(fx.masters[0].qualRisk).toBe(true)
    expect(deleted).toEqual([])
    expect(fx.media_checks[0].status).toBe('risky')
  })
})

describe('失败与竞态防线(评审核心)', () => {
  test('业务文档更新失败:打 applyPending 留在 processing,文件绝不删', async () => {
    const f = fid('listings', 'm1', 'a')
    const fx = {
      media_checks: [{ _id: 'c1', traceId: 't1', type: 'listing', targetId: 'l1', fileID: f, status: 'pending' }],
      listings: [{ _id: 'l1', status: LISTING_STATUS.ON_SALE, photos: [f] }]
    }
    global.__failUpdate = (name) => name === 'listings'
    const { deleted } = await callCb(riskyEvent('t1'), fx)
    expect(fx.media_checks[0].status).toBe('processing')
    expect(fx.media_checks[0].applyPending).toBe(true)
    expect(fx.listings[0].photos).toEqual([f])   // 图还在
    expect(deleted).toEqual([])                  // 文件也在:不会出现"库里挂着已删文件"
  })

  test('目标文档已删除(商品已被卖家删掉):置 superseded 终态,不删文件不挂起', async () => {
    const fx = {
      media_checks: [{ _id: 'c1', traceId: 't1', type: 'listing', targetId: 'ghost', fileID: 'f.jpg', status: 'pending' }],
      listings: []
    }
    const { deleted } = await callCb(riskyEvent('t1'), fx)
    expect(fx.media_checks[0].status).toBe('superseded')
    expect(fx.media_checks[0].applyPending).toBe(false)
    expect(deleted).toEqual([])
  })

  test('文件删除失败:文档已摘图,打 cleanupPending 交给 cron 补偿', async () => {
    const f = fid('orders', 'u1', 'a')
    const fx = {
      media_checks: [{ _id: 'c1', traceId: 't1', type: 'order', targetId: 'o1', fileID: f, status: 'pending' }],
      orders: [{ _id: 'o1', photos: [f] }]
    }
    global.__mockDeleteFile = (fileList) => ({
      fileList: fileList.map(x => ({ fileID: x, status: 1, errMsg: 'ACCESS_DENIED' }))
    })
    await callCb(riskyEvent('t1'), fx)
    expect(fx.orders[0].photos).toEqual([])
    expect(fx.media_checks[0]).toMatchObject({ status: 'risky', cleanupPending: true })
  })
})

describe('masterAvatar 展示头像违规处置(公开照片同口径:摘除+删文件)', () => {
  test('违规:条件原子摘除 avatarPhoto 并删文件', async () => {
    const f = fid('avatars', 'm1', 'a')
    const fx = {
      media_checks: [{ _id: 'c1', traceId: 't1', type: 'masterAvatar', targetId: 'm1', fileID: f, status: 'pending' }],
      masters: [{ _id: 'm1', avatarPhoto: f }]
    }
    const { deleted } = await callCb(riskyEvent('t1'), fx)
    expect(fx.masters[0].avatarPhoto).toBe('')
    expect(deleted).toEqual([f])
    expect(fx.media_checks[0].status).toBe('risky')
  })

  test('师傅已换新头像:旧检测不误清新图,置 superseded 不删文件', async () => {
    const fx = {
      media_checks: [{ _id: 'c1', traceId: 't1', type: 'masterAvatar', targetId: 'm1', fileID: fid('avatars', 'm1', 'old'), status: 'pending' }],
      masters: [{ _id: 'm1', avatarPhoto: fid('avatars', 'm1', 'new') }]
    }
    const { deleted } = await callCb(riskyEvent('t1'), fx)
    expect(fx.masters[0].avatarPhoto).toBe(fid('avatars', 'm1', 'new'))
    expect(deleted).toEqual([])
    expect(fx.media_checks[0].status).toBe('superseded')
  })
})
