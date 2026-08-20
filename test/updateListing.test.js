// updateListing 卖家商品管理:条件原子流转 + 删除可重试(买空调频道)
const { fakeDb } = require('./stubs/fakeDb')
const { LISTING_STATUS } = require('../cloudfunctions/_shared/biz')

const NOW = new Date('2026-08-01T02:00:00Z').getTime()
const fid = (n) => `cloud://env.x/listings/m1/${n}.jpg`

function listing(over = {}) {
  return Object.assign({
    _id: 'l1', sellerOpenid: 'm1', status: LISTING_STATUS.OFF_SHELF,
    photos: [fid('a'), fid('b')], priceYuan: 1000, deleting: false,
    createdAt: new Date(NOW - 24 * 3600 * 1000)
  }, over)
}

function fixtures(over = {}) {
  return Object.assign({
    listings: [listing()],
    masters: [{ _id: 'm1', openid: 'm1', status: 'approved' }],
    media_checks: []
  }, over)
}

async function call(action, event, fx, openid = 'm1') {
  jest.resetModules()
  global.__mockDb = fakeDb(fx)
  global.__mockCtx = { OPENID: openid }
  global.__deletedFiles = []
  const { main } = require('../cloudfunctions/updateListing/index')
  const res = await main(Object.assign({ action }, event))
  const deleted = global.__deletedFiles
  delete global.__mockDb
  delete global.__mockCtx
  delete global.__deletedFiles
  delete global.__mockDeleteFile
  return { res, deleted }
}

beforeAll(() => { jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] }) })
afterAll(() => { jest.useRealTimers() })

describe('offShelf / markSold / editPrice 条件原子流转', () => {
  test('在售 -> 下架', async () => {
    const fx = fixtures({ listings: [listing({ status: LISTING_STATUS.ON_SALE })] })
    const { res } = await call('offShelf', { listingId: 'l1' }, fx)
    expect(res.ok).toBe(true)
    expect(fx.listings[0].status).toBe(LISTING_STATUS.OFF_SHELF)
    expect(fx.listings[0].offShelfAt).toBeTruthy()
  })

  test('已下架再下架:前置态不符报冲突', async () => {
    const fx = fixtures()
    const { res } = await call('offShelf', { listingId: 'l1' }, fx)
    expect(res.ok).toBe(false)
    expect(res.msg).toContain('状态已变化')
  })

  test('他人商品不可操作(归属进原子条件)', async () => {
    const fx = fixtures({ listings: [listing({ status: LISTING_STATUS.ON_SALE })] })
    const { res } = await call('offShelf', { listingId: 'l1' }, fx, 'm2')
    expect(res.ok).toBe(false)
    expect(fx.listings[0].status).toBe(LISTING_STATUS.ON_SALE)
  })

  test('标已售:在售与已下架都可(防锁死),已售不可再标', async () => {
    const fx = fixtures({ listings: [listing({ status: LISTING_STATUS.ON_SALE })] })
    expect((await call('markSold', { listingId: 'l1' }, fx)).res.ok).toBe(true)
    expect(fx.listings[0].status).toBe(LISTING_STATUS.SOLD)

    const fx2 = fixtures()
    expect((await call('markSold', { listingId: 'l1' }, fx2)).res.ok).toBe(true)

    const fx3 = fixtures({ listings: [listing({ status: LISTING_STATUS.SOLD })] })
    expect((await call('markSold', { listingId: 'l1' }, fx3)).res.ok).toBe(false)
  })

  test('改价:范围校验与前置态', async () => {
    const fx = fixtures()
    expect((await call('editPrice', { listingId: 'l1', priceYuan: 888 }, fx)).res.ok).toBe(true)
    expect(fx.listings[0].priceYuan).toBe(888)
    expect((await call('editPrice', { listingId: 'l1', priceYuan: 88.5 }, fx)).res.ok).toBe(false)
    expect((await call('editPrice', { listingId: 'l1', priceYuan: 0 }, fx)).res.ok).toBe(false)

    const fxSold = fixtures({ listings: [listing({ status: LISTING_STATUS.SOLD })] })
    expect((await call('editPrice', { listingId: 'l1', priceYuan: 500 }, fxSold)).res.ok).toBe(false)
  })
})

describe('onShelf 重新上架的四道闸', () => {
  test('正常重挂:清除系统下架原因', async () => {
    const fx = fixtures({ listings: [listing({ offShelfReason: '师傅资格变更,已自动下架' })] })
    const { res } = await call('onShelf', { listingId: 'l1' }, fx)
    expect(res.ok).toBe(true)
    expect(fx.listings[0].status).toBe(LISTING_STATUS.ON_SALE)
    expect(fx.listings[0].offShelfReason).toBe('')
  })

  test('资格已失效 -> 拒绝(降权后不能复挂)', async () => {
    const fx = fixtures()
    fx.masters[0].status = 'rejected'
    const { res } = await call('onShelf', { listingId: 'l1' }, fx)
    expect(res.ok).toBe(false)
    expect(res.msg).toContain('资格')
  })

  test('照片被摘光 -> 拒绝', async () => {
    const fx = fixtures({ listings: [listing({ photos: [] })] })
    const { res } = await call('onShelf', { listingId: 'l1' }, fx)
    expect(res.ok).toBe(false)
    expect(res.msg).toContain('照片')
  })

  test('在售已满20件 -> 拒绝(评审:与发布同口径,防先囤后架绕限)', async () => {
    const fx = fixtures()
    const old = new Date(NOW - 48 * 3600 * 1000)
    for (let i = 0; i < 20; i++) {
      fx.listings.push(listing({ _id: 'on' + i, status: LISTING_STATUS.ON_SALE, createdAt: old }))
    }
    const { res } = await call('onShelf', { listingId: 'l1' }, fx)
    expect(res.ok).toBe(false)
    expect(res.msg).toContain('上限')
  })

  test('删除进行中(deleting)的商品不能复活', async () => {
    const fx = fixtures({ listings: [listing({ deleting: true })] })
    const { res } = await call('onShelf', { listingId: 'l1' }, fx)
    expect(res.ok).toBe(false)
  })
})

describe('deleteListing 固定顺序与可重试(评审)', () => {
  test('仅已下架可删:在售/已售/违规下架都拒绝', async () => {
    for (const status of [LISTING_STATUS.ON_SALE, LISTING_STATUS.SOLD, LISTING_STATUS.REMOVED]) {
      const fx = fixtures({ listings: [listing({ status })] })
      const { res } = await call('deleteListing', { listingId: 'l1' }, fx)
      expect(res.ok).toBe(false)
      expect(fx.listings).toHaveLength(1)
    }
  })

  test('成功删除:照片删净、文档移除、未决审核记录作废', async () => {
    const fx = fixtures({
      media_checks: [
        { _id: 'c1', targetId: 'l1', type: 'listing', status: 'pending', fileID: fid('a') },
        { _id: 'c2', targetId: 'l1', type: 'listing', status: 'processing', fileID: fid('b') },
        { _id: 'c3', targetId: 'other', type: 'listing', status: 'pending', fileID: 'x' }
      ]
    })
    const { res, deleted } = await call('deleteListing', { listingId: 'l1' }, fx)
    expect(res.ok).toBe(true)
    expect(deleted).toEqual([fid('a'), fid('b')])
    expect(fx.listings).toHaveLength(0)
    expect(fx.media_checks.find(c => c._id === 'c1').status).toBe('superseded')
    expect(fx.media_checks.find(c => c._id === 'c2').status).toBe('superseded')
    expect(fx.media_checks.find(c => c._id === 'c3').status).toBe('pending')
  })

  test('删文件失败:保留文档与 fileID(带 deleting 标记)可重试,重试成功后清干净', async () => {
    const fx = fixtures()
    global.__mockDeleteFile = (fileList) => ({
      fileList: fileList.map(f => ({ fileID: f, status: 1, errMsg: 'ACCESS_DENIED' }))
    })
    const { res } = await call('deleteListing', { listingId: 'l1' }, fx)
    expect(res.ok).toBe(false)
    expect(res.msg).toContain('重试')
    expect(fx.listings).toHaveLength(1)
    expect(fx.listings[0].deleting).toBe(true)
    expect(fx.listings[0].photos).toEqual([fid('a'), fid('b')])

    // 重按删除:幂等续跑(claim 条件仍命中 off_shelf,文件删除恢复后走完)
    const { res: retry } = await call('deleteListing', { listingId: 'l1' }, fx)
    expect(retry.ok).toBe(true)
    expect(fx.listings).toHaveLength(0)
  })

  test('删除中的商品他人视角/未知动作防线', async () => {
    const fx = fixtures()
    expect((await call('deleteListing', { listingId: 'l1' }, fx, 'm2')).res.ok).toBe(false)
    expect(fx.listings).toHaveLength(1)
    const { res } = await call('archive', { listingId: 'l1' }, fx)
    expect(res.ok).toBe(false)
    expect(res.msg).toContain('未知操作')
  })
})
