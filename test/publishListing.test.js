// publishListing 发布商品全闸门行为测试(买空调频道)
const { fakeDb } = require('./stubs/fakeDb')
const { LISTING_STATUS } = require('../cloudfunctions/_shared/biz')

const NOW = new Date('2026-08-01T02:00:00Z').getTime()
const JPEG = () => Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10])
const fid = (openid, name) => `cloud://env.appid/listings/${openid}/${name}.jpg`

function baseEvent() {
  return {
    requestId: 'req-1',
    condition: 'used',
    title: '格力1.5匹挂机 九成新',
    desc: '自用格力挂机,制冷正常,内外机都做过深度清洗',
    brand: '格力',
    unitType: 'wall',
    hp: 'hp15',
    priceYuan: 1200,
    usedGrade: 'g9',
    usedYears: 'y1_3',
    photos: [fid('m1', 'a')]
  }
}

function fixtures() {
  return {
    listings: [],
    masters: [{ _id: 'm1', openid: 'm1', status: 'approved', realName: '张三丰', serviceCity: '青岛市', cityKey: '青岛', phone: '13800138000' }],
    media_checks: []
  }
}

async function publish(event, fx, { msgSec, download, ctx } = {}) {
  jest.resetModules()
  global.__mockDb = fakeDb(fx)
  global.__mockCtx = ctx || { OPENID: 'm1' }
  global.__mockDownload = download || JPEG
  global.__deletedFiles = []
  const cloudStub = require('wx-server-sdk')
  cloudStub.openapi = {
    security: {
      msgSecCheck: msgSec || (async () => ({})),
      mediaCheckAsync: async () => ({ traceId: 'trace-' + Math.random().toString(36).slice(2) })
    }
  }
  const { main } = require('../cloudfunctions/publishListing/index')
  const res = await main(event)
  const deleted = global.__deletedFiles
  delete cloudStub.openapi
  delete global.__mockDb
  delete global.__mockCtx
  delete global.__mockDownload
  delete global.__deletedFiles
  return { res, deleted }
}

beforeAll(() => { jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] }) })
afterAll(() => { jest.useRealTimers() })

describe('卖家资格闸门', () => {
  test('非师傅 -> 拒绝', async () => {
    const fx = fixtures()
    fx.masters = []
    const { res } = await publish(baseEvent(), fx)
    expect(res.ok).toBe(false)
    expect(res.msg).toContain('审核通过的师傅')
  })

  test('审核中的师傅 -> 拒绝', async () => {
    const fx = fixtures()
    fx.masters[0].status = 'pending'
    const { res } = await publish(baseEvent(), fx)
    expect(res.ok).toBe(false)
    expect(fx.listings).toHaveLength(0)
  })
})

describe('参数闸门', () => {
  test.each([
    ['缺 requestId', { requestId: '' }, '请求标识'],
    ['非法 condition', { condition: 'refurb' }, '新机或二手机'],
    ['非法机型', { unitType: 'window' }, '机型'],
    ['非法匹数', { hp: '1.5' }, '匹数'],
    ['二手缺成色', { usedGrade: '' }, '成色'],
    ['二手缺年限', { usedYears: 'forever' }, '使用年限'],
    ['标题太短', { title: '空调' }, '至少4个字'],
    ['标题超长', { title: 'x'.repeat(31) }, '最多30个字'],
    ['描述太短', { desc: '好用' }, '至少10个字'],
    ['描述超长', { desc: 'x'.repeat(501) }, '太长'],
    ['品牌缺失', { brand: ' ' }, '品牌'],
    ['品牌超长', { brand: '一二三四五六七八九十一二三' }, '品牌名太长'],
    ['价格小数', { priceYuan: 1200.5 }, '整数'],
    ['价格为0', { priceYuan: 0 }, '整数'],
    ['价格越界', { priceYuan: 100000 }, '整数'],
    ['价格字符串', { priceYuan: '1200' }, '整数'],
    ['无照片', { photos: [] }, '至少上传1张'],
    ['照片超6张', { photos: Array.from({ length: 7 }, (_, i) => fid('m1', 'p' + i)) }, '最多6张']
  ])('%s -> 拒绝', async (_label, over, msgPart) => {
    const fx = fixtures()
    const { res } = await publish(Object.assign(baseEvent(), over), fx)
    expect(res.ok).toBe(false)
    expect(res.msg).toContain(msgPart)
    expect(fx.listings).toHaveLength(0)
  })

  test('新机不写入二手专属字段(usedGrade/usedYears)', async () => {
    const fx = fixtures()
    const { res } = await publish(Object.assign(baseEvent(), { condition: 'new', usedGrade: '', usedYears: '' }), fx)
    expect(res.ok).toBe(true)
    expect(fx.listings[0]).not.toHaveProperty('usedGrade')
    expect(fx.listings[0]).not.toHaveProperty('usedYears')
  })
})

describe('联系方式拦截(防绕过电话分层)', () => {
  test.each([
    ['描述带手机号', { desc: '性价比高有意联系13912345678详谈' }],
    ['标题带微信引导', { title: '格力挂机 微信号:acbuy2026' }],
    ['描述带网址', { desc: '详情见 https://example.com/item 自提优先' }],
    ['描述带vx引导', { desc: '机器很新有意加vx: gree_seller 细聊价格' }]
  ])('%s -> 拒绝', async (_label, over) => {
    const { res } = await publish(Object.assign(baseEvent(), over), fixtures())
    expect(res.ok).toBe(false)
    expect(res.msg).toContain('联系方式')
  })
})

describe('照片安全闸门', () => {
  test('他人命名空间 -> 拒绝且不删别人的文件', async () => {
    const ev = Object.assign(baseEvent(), { photos: [fid('someone-else', 'a')] })
    const { res, deleted } = await publish(ev, fixtures())
    expect(res.ok).toBe(false)
    expect(deleted).toEqual([])
  })

  test('orders 命名空间的文件报 listing 场景 -> 拒绝', async () => {
    const ev = Object.assign(baseEvent(), { photos: [`cloud://env.appid/orders/m1/a.jpg`] })
    const { res } = await publish(ev, fixtures())
    expect(res.ok).toBe(false)
  })

  test('魔数不是图片 -> 拒绝并删除本次上传', async () => {
    const ev = baseEvent()
    const { res, deleted } = await publish(ev, fixtures(), {
      download: () => Buffer.from([0x4D, 0x5A, 0x90, 0x00])
    })
    expect(res.ok).toBe(false)
    expect(deleted).toEqual(ev.photos)
  })

  test('文本命中违规(87014)-> 拒绝并删除已上传照片', async () => {
    const ev = baseEvent()
    const { res, deleted } = await publish(ev, fixtures(), {
      msgSec: async () => { throw { errCode: 87014 } }
    })
    expect(res.ok).toBe(false)
    expect(res.msg).toContain('违规')
    expect(deleted).toEqual(ev.photos)
  })
})

describe('限频与在架上限', () => {
  test('1小时内已发3件 -> 拒绝并清理本次照片', async () => {
    const fx = fixtures()
    fx.listings = [1, 2, 3].map(i => ({
      _id: 'l' + i, sellerOpenid: 'm1', status: LISTING_STATUS.ON_SALE, createdAt: new Date(NOW - 10 * 60 * 1000)
    }))
    const ev = baseEvent()
    const { res, deleted } = await publish(ev, fx)
    expect(res.ok).toBe(false)
    expect(res.msg).toContain('频繁')
    expect(deleted).toEqual(ev.photos)
  })

  test('在售满20件 -> 拒绝(off_shelf 不计入,防锁死)', async () => {
    const fx = fixtures()
    const old = new Date(NOW - 24 * 3600 * 1000)
    fx.listings = Array.from({ length: 20 }, (_, i) => ({
      _id: 'l' + i, sellerOpenid: 'm1', status: LISTING_STATUS.ON_SALE, createdAt: old
    }))
    const { res } = await publish(baseEvent(), fx)
    expect(res.ok).toBe(false)
    expect(res.msg).toContain('上限')

    // 同样20件但已下架:不计入上限,可继续发布
    fx.listings.forEach(l => { l.status = LISTING_STATUS.OFF_SHELF })
    const { res: res2 } = await publish(baseEvent(), fx)
    expect(res2.ok).toBe(true)
  })
})

describe('发布幂等(requestId)', () => {
  test('同 requestId 重复提交:返回原单,不重复上架也不删照片', async () => {
    const fx = fixtures()
    const { res: first } = await publish(baseEvent(), fx)
    expect(first.ok).toBe(true)
    const { res: again, deleted } = await publish(baseEvent(), fx)
    expect(again.ok).toBe(true)
    expect(again.duplicated).toBe(true)
    expect(again.listingId).toBe(first.listingId)
    expect(fx.listings).toHaveLength(1)
    expect(deleted).toEqual([])
  })

  test('不同卖家同 requestId:各自成单,互不冒领', async () => {
    const fx = fixtures()
    fx.masters.push({ _id: 'm2', openid: 'm2', status: 'approved', realName: '李四', serviceCity: '青岛市', cityKey: '青岛', phone: '13900139000' })
    const { res: a } = await publish(baseEvent(), fx)
    const ev2 = Object.assign(baseEvent(), { photos: [fid('m2', 'b')] })
    const { res: b } = await publish(ev2, fx, { ctx: { OPENID: 'm2' } })
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    expect(b.duplicated).toBeUndefined()
    expect(a.listingId).not.toBe(b.listingId)
    expect(fx.listings).toHaveLength(2)
  })

  test('makeListingId 是卖家作用域哈希', () => {
    const { makeListingId } = require('../cloudfunctions/publishListing/index')._internals
    expect(makeListingId('a', 'r1')).not.toBe(makeListingId('b', 'r1'))
    expect(makeListingId('a', 'r1')).toBe(makeListingId('a', 'r1'))
    expect(makeListingId('a', 'r1')).toMatch(/^[0-9a-f]{32}$/)
  })
})

describe('成功路径', () => {
  test('落库字段全貌:不存电话/姓名快照,状态在售,送检登记为 listing 类', async () => {
    const fx = fixtures()
    const { res } = await publish(baseEvent(), fx)
    expect(res.ok).toBe(true)
    expect(res.listingNo).toMatch(/^GD\d{10}-\d{8}$/)

    const l = fx.listings[0]
    expect(l.status).toBe(LISTING_STATUS.ON_SALE)
    expect(l.sellerOpenid).toBe('m1')
    expect(l.sellerDisplayName).toBe('张师傅')
    // 评审红线:商品文档不存电话与姓名快照
    expect(l).not.toHaveProperty('sellerPhone')
    expect(l).not.toHaveProperty('sellerName')
    expect(JSON.stringify(l)).not.toContain('13800138000')
    expect(JSON.stringify(l)).not.toContain('张三丰')
    expect(l.cityName).toBe('青岛市')
    expect(l.cityKey).toBe('青岛')
    expect(l.condition).toBe('used')
    expect(l.usedGrade).toBe('g9')
    expect(l.usedYears).toBe('y1_3')
    expect(l.priceYuan).toBe(1200)
    expect(l.photosRisk).toBe(false)
    expect(l.deleting).toBe(false)
    expect(fx.media_checks).toHaveLength(1)
    expect(fx.media_checks[0]).toMatchObject({ type: 'listing', targetId: res.listingId, status: 'pending' })
  })
})
