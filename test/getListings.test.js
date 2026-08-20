// getListings 白名单分层 + contact 取号防线(买空调频道)
// 隐私核心:market/mine/detail 任何响应不含电话;电话仅 contact 按次下发+原子日限频
const { fakeDb } = require('./stubs/fakeDb')
const { LISTING_STATUS } = require('../cloudfunctions/_shared/biz')

const NOW = new Date('2026-08-01T02:00:00Z').getTime()   // 北京时间 2026-08-01 10:00
const fid = (n) => `cloud://env.x/listings/m1/${n}.jpg`
const PHONE = '13800138000'

function listing(over = {}) {
  return Object.assign({
    _id: 'l1', listingNo: 'GD2607311200-0001', sellerOpenid: 'm1', sellerDisplayName: '张师傅',
    cityName: '青岛市', cityKey: '青岛', condition: 'used', title: '格力挂机', desc: '成色不错',
    brand: '格力', unitType: 'wall', hp: 'hp15', priceYuan: 1200, usedGrade: 'g9', usedYears: 'y1_3',
    photos: [fid('a'), fid('b')], photosRisk: false, deleting: false,
    status: LISTING_STATUS.ON_SALE, createdAt: new Date(NOW - 3600 * 1000)
  }, over)
}

function fixtures(over = {}) {
  return Object.assign({
    listings: [listing()],
    masters: [{ _id: 'm1', openid: 'm1', status: 'approved', phone: PHONE, realName: '张三丰', stats: { done: 8, reviewCount: 5, totalStars: 24 } }],
    contact_logs: []
  }, over)
}

async function call(action, event, fx, openid = 'buyer1') {
  jest.resetModules()
  global.__mockDb = fakeDb(fx)
  global.__mockCtx = { OPENID: openid }
  const { main } = require('../cloudfunctions/getListings/index')
  const res = await main(Object.assign({ action }, event))
  delete global.__mockDb
  delete global.__mockCtx
  return res
}

beforeAll(() => { jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] }) })
afterAll(() => { jest.useRealTimers() })

describe('market 市场列表', () => {
  test('只出在售;封面以 cover 单字段下发,不带原始 photos/desc/卖家字段', async () => {
    const fx = fixtures({
      listings: [
        listing(),
        listing({ _id: 'l2', status: LISTING_STATUS.OFF_SHELF }),
        listing({ _id: 'l3', status: LISTING_STATUS.SOLD }),
        listing({ _id: 'l4', status: LISTING_STATUS.REMOVED })
      ]
    })
    const r = await call('market', {}, fx)
    expect(r.ok).toBe(true)
    expect(r.data).toHaveLength(1)
    const row = r.data[0]
    expect(row.cover).toBe('https://tmp/' + fid('a'))
    expect(row).not.toHaveProperty('photos')
    expect(row).not.toHaveProperty('desc')
    expect(row).not.toHaveProperty('sellerOpenid')
    expect(row).not.toHaveProperty('sellerDisplayName')
    expect(JSON.stringify(r)).not.toContain(PHONE)
    expect(JSON.stringify(r)).not.toContain('cityKey')
  })

  test('condition 筛选:非法值忽略,合法值生效', async () => {
    const fx = fixtures({
      listings: [listing(), listing({ _id: 'l2', condition: 'new' })]
    })
    expect((await call('market', { condition: 'used' }, fx)).data).toHaveLength(1)
    expect((await call('market', { condition: 'weird' }, fx)).data).toHaveLength(2)
  })

  test('围观视角换链失败不回退 fileID(cover 置空, 同口径)', async () => {
    global.__mockTempFileURL = (fileList) => ({ fileList: fileList.map(f => ({ fileID: f })) })
    const r = await call('market', {}, fixtures())
    delete global.__mockTempFileURL
    expect(r.data[0].cover).toBe('')
    expect(JSON.stringify(r)).not.toContain('cloud://')
  })
})

describe('mine 我的列表', () => {
  test('本人全状态可见,含管理字段,removedBy 不下发', async () => {
    const fx = fixtures({
      listings: [
        listing(),
        listing({ _id: 'l2', status: LISTING_STATUS.REMOVED, removedReason: '违规商品', removedBy: 'admin-1' })
      ]
    })
    const r = await call('mine', {}, fx, 'm1')
    expect(r.data).toHaveLength(2)
    const removed = r.data.find(d => d._id === 'l2')
    expect(removed.removedReason).toBe('违规商品')
    expect(JSON.stringify(r)).not.toContain('admin-1')
  })
})

describe('detail 详情按角色分层', () => {
  test('围观者看在售:有正文/照片临时链接/实时认证标识,无电话无 openid', async () => {
    const r = await call('detail', { listingId: 'l1' }, fixtures())
    expect(r.ok).toBe(true)
    expect(r.isOwner).toBe(false)
    expect(r.sellerVerified).toBe(true)
    expect(r.sellerStats).toEqual({ done: 8, reviewCount: 5, totalStars: 24 })
    expect(r.data.desc).toBe('成色不错')
    expect(r.data.photos).toEqual(['https://tmp/' + fid('a'), 'https://tmp/' + fid('b')])
    const json = JSON.stringify(r)
    expect(json).not.toContain(PHONE)
    expect(json).not.toContain('sellerOpenid')  // openid 字段不下发(临时链接路径含 openid 与 getOrders 现状同口径)
    expect(json).not.toContain('张三丰')         // realName 全名不泄露,只给派生的"张师傅"
  })

  test('已售可看但资格撤销后不再显示认证(sellerVerified 实时派生)', async () => {
    const fx = fixtures({ listings: [listing({ status: LISTING_STATUS.SOLD })] })
    fx.masters[0].status = 'rejected'
    const r = await call('detail', { listingId: 'l1' }, fx)
    expect(r.ok).toBe(true)
    expect(r.sellerVerified).toBe(false)
  })

  test('围观者不可看已下架/违规下架/删除中', async () => {
    for (const over of [
      { status: LISTING_STATUS.OFF_SHELF },
      { status: LISTING_STATUS.REMOVED },
      { deleting: true }
    ]) {
      const fx = fixtures({ listings: [listing(over)] })
      const r = await call('detail', { listingId: 'l1' }, fx)
      expect(r.ok).toBe(false)
    }
  })

  test('本人全程可见含下架原因,但 removedBy 不下发', async () => {
    const fx = fixtures({
      listings: [listing({ status: LISTING_STATUS.REMOVED, removedReason: '违规', removedBy: 'admin-1' })]
    })
    const r = await call('detail', { listingId: 'l1' }, fx, 'm1')
    expect(r.ok).toBe(true)
    expect(r.isOwner).toBe(true)
    expect(r.data.removedReason).toBe('违规')
    expect(JSON.stringify(r)).not.toContain('admin-1')
  })

  test('商品不存在 -> 明确空态文案(分享链接指向已删商品)', async () => {
    const r = await call('detail', { listingId: 'ghost' }, fixtures())
    expect(r.ok).toBe(false)
    expect(r.msg).toContain('不存在或已删除')
  })
})

describe('contact 取号(评审:双复查 + 原子日限频 + 响应外无电话)', () => {
  test('成功取号:返回实时电话,计数文档条件自增', async () => {
    const fx = fixtures()
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    const r1 = await call('contact', { listingId: 'l1' }, fx)
    const r2 = await call('contact', { listingId: 'l1' }, fx)
    const logged = logSpy.mock.calls.map(c => c.join(' ')).join('\n')
    logSpy.mockRestore()
    expect(r1.ok).toBe(true)
    expect(r1.phone).toBe(PHONE)
    expect(fx.contact_logs).toHaveLength(1)
    expect(fx.contact_logs[0].count).toBe(2)
    expect(fx.contact_logs[0].viewerOpenid).toBe('buyer1')
    // 计数文档 _id 是哈希,不含裸 openid;日期按北京时间
    expect(fx.contact_logs[0]._id).toMatch(/^[0-9a-f]{32}$/)
    expect(fx.contact_logs[0].day).toBe('2026-08-01')
    // 结构化日志不得夹带电话号码(评审)
    expect(logged).not.toContain(PHONE)
    expect(r2.ok).toBe(true)
  })

  test('达日限频 -> 拒绝且不再自增', async () => {
    const fx = fixtures()
    const { contactDay, contactKey, CONTACT_DAILY_LIMIT } =
      require('../cloudfunctions/getListings/index')._internals
    const day = contactDay(NOW)
    fx.contact_logs = [{ _id: contactKey('buyer1', day), viewerOpenid: 'buyer1', day, count: CONTACT_DAILY_LIMIT }]
    const r = await call('contact', { listingId: 'l1' }, fx)
    expect(r.ok).toBe(false)
    expect(r.msg).toContain('上限')
    expect(fx.contact_logs[0].count).toBe(CONTACT_DAILY_LIMIT)
    expect(JSON.stringify(r)).not.toContain(PHONE)
  })

  test('卖家资格已失效 -> 拒绝(资格撤销的读时兜底闸)', async () => {
    const fx = fixtures()
    fx.masters[0].status = 'rejected'
    const r = await call('contact', { listingId: 'l1' }, fx)
    expect(r.ok).toBe(false)
    expect(JSON.stringify(r)).not.toContain(PHONE)
  })

  test('非在售商品不可取号(已售/下架即收口)', async () => {
    for (const status of [LISTING_STATUS.SOLD, LISTING_STATUS.OFF_SHELF, LISTING_STATUS.REMOVED]) {
      const fx = fixtures({ listings: [listing({ status })] })
      const r = await call('contact', { listingId: 'l1' }, fx)
      expect(r.ok).toBe(false)
    }
  })

  test('卖家取自己商品的号 -> 拒绝', async () => {
    const r = await call('contact', { listingId: 'l1' }, fixtures(), 'm1')
    expect(r.ok).toBe(false)
  })

  test('contactDay 按北京时间日切(UTC 晚间已是北京次日)', () => {
    const { contactDay } = require('../cloudfunctions/getListings/index')._internals
    expect(contactDay(Date.UTC(2026, 7, 1, 15, 0))).toBe('2026-08-01')  // BJ 23:00
    expect(contactDay(Date.UTC(2026, 7, 1, 17, 0))).toBe('2026-08-02')  // BJ 次日 01:00
  })
})
