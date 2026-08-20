// publishOrder 发单全闸门行为测试
const { fakeDb } = require('./stubs/fakeDb')

// 北京时间 2026-08-01 10:00(UTC 02:00):当天上午时段(8-12点)仍有效
const NOW = new Date('2026-08-01T02:00:00Z').getTime()
const JPEG = () => Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10])
const fid = (openid, name) => `cloud://env.appid/orders/${openid}/${name}.jpg`

function baseEvent() {
  return {
    category: 'repair',
    desc: '空调开机不制冷,外机不转',
    photos: [],
    location: { latitude: 23.129112, longitude: 113.264385 },
    address: '天河某小区',
    addressDetail: '3栋502',
    cityName: '广州市',
    expectDate: '2026-08-01',
    slotKey: 'morning',
    phone: '13800138000',
    contactName: '王先生'
  }
}

function fixtures() {
  return { orders: [], users: [{ openid: 'u1' }], config: [{ _id: 'app' }], media_checks: [] }
}

async function publish(event, fx, { msgSec, mediaCheck, download, send } = {}) {
  jest.resetModules()
  global.__mockDb = fakeDb(fx)
  global.__mockCtx = { OPENID: 'u1' }
  global.__mockDownload = download || JPEG
  global.__deletedFiles = []
  const cloudStub = require('wx-server-sdk')
  cloudStub.openapi = {
    security: {
      msgSecCheck: msgSec || (async () => ({})),
      mediaCheckAsync: mediaCheck || (async () => ({ traceId: 'trace-1' }))
    },
    subscribeMessage: { send: send || (async () => ({})) }
  }
  const { main } = require('../cloudfunctions/publishOrder/index')
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

describe('参数闸门', () => {
  test.each([
    ['非法品类', { category: 'tv' }, '服务类型'],
    ['描述太短', { desc: '坏了' }, '至少5个字'],
    ['描述超长', { desc: 'x'.repeat(501) }, '太长'],
    ['缺定位', { location: null }, '上门地址'],
    ['缺城市', { cityName: '' }, '城市'],
    ['非法时段 key', { slotKey: 'midnight' }, '期望上门时间'],
    ['日期格式错误', { expectDate: '8月1日' }, '期望上门时间'],
    ['手机号非法', { phone: '12345' }, '手机号'],
    ['照片超6张', { photos: Array.from({ length: 7 }, (_, i) => fid('u1', 'p' + i)) }, '最多6张']
  ])('%s -> 拒绝', async (_label, over, msgPart) => {
    const { res } = await publish(Object.assign(baseEvent(), over), fixtures())
    expect(res.ok).toBe(false)
    expect(res.msg).toContain(msgPart)
  })

  test('期望时段已过 -> 拒绝(昨天上午)', async () => {
    const { res } = await publish(Object.assign(baseEvent(), { expectDate: '2026-07-31' }), fixtures())
    expect(res.ok).toBe(false)
    expect(res.msg).toContain('已过')
  })

  test('超过30天 -> 拒绝', async () => {
    const { res } = await publish(Object.assign(baseEvent(), { expectDate: '2026-09-05' }), fixtures())
    expect(res.ok).toBe(false)
    expect(res.msg).toContain('30天')
  })
})

describe('坐标信任边界', () => {
  test.each([
    ['缺经度', { latitude: 23.1 }],
    ['缺纬度', { longitude: 113.2 }],
    ['字符串坐标', { latitude: '23.1', longitude: '113.2' }],
    ['NaN', { latitude: NaN, longitude: 113.2 }],
    ['Infinity', { latitude: 23.1, longitude: Infinity }],
    ['纬度越界', { latitude: 90.01, longitude: 113.2 }],
    ['经度越界', { latitude: 23.1, longitude: -180.5 }]
  ])('%s -> 明确拒绝,不进 Geo.Point / 不写库', async (_label, loc) => {
    const fx = fixtures()
    const { res } = await publish(Object.assign(baseEvent(), { location: loc }), fx)
    expect(res.ok).toBe(false)
    expect(res.msg).toContain('上门地址')
    expect(fx.orders).toHaveLength(0)
  })

  test('边界值 ±90/±180 与合法的 0 值放行', async () => {
    const { res } = await publish(Object.assign(baseEvent(), {
      location: { latitude: 0, longitude: 180 }
    }), fixtures())
    expect(res.ok).toBe(true)
  })
})

describe('日期真实性', () => {
  test.each([
    ['2026-02-31', '2月31日'], ['2026-02-30', '2月30日'], ['2026-04-31', '4月31日'],
    ['2026-00-15', '月份00'], ['2026-13-01', '月份13'],
    ['2026-08-00', '日期00'], ['2026-08-32', '日期32'],
    ['2027-02-29', '非闰年2月29']
  ])('不存在的日期 %s(%s)-> 拒绝,不被 Date.UTC 归一化放行', async (expectDate) => {
    const { res } = await publish(Object.assign(baseEvent(), { expectDate }), fixtures())
    expect(res.ok).toBe(false)
    expect(res.msg).toContain('日期不合法')
  })

  test('闰年 2028-02-29 是真实日期:走后续窗口校验(30天外被拒,而不是日期不合法)', async () => {
    const { res } = await publish(Object.assign(baseEvent(), { expectDate: '2028-02-29' }), fixtures())
    expect(res.ok).toBe(false)
    expect(res.msg).toContain('30天')
  })

  test('合法日期照常建单,expectDate/expectEnd 指同一天', async () => {
    const fx = fixtures()
    const { res } = await publish(Object.assign(baseEvent(), { expectDate: '2026-08-02' }), fx)
    expect(res.ok).toBe(true)
    expect(fx.orders[0].expectDate).toBe('2026-08-02')
    expect(fx.orders[0].expectEnd.getTime()).toBe(Date.UTC(2026, 7, 2, 12 - 8))
  })
})

describe('照片安全闸门', () => {
  test('非本人命名空间的 fileID -> 拒绝(且不删别人的文件)', async () => {
    const ev = Object.assign(baseEvent(), { photos: [fid('someone-else', 'a')] })
    const { res, deleted } = await publish(ev, fixtures())
    expect(res.ok).toBe(false)
    expect(res.msg).toContain('照片校验失败')
    expect(deleted).toEqual([])
  })

  test('伪造扩展名 -> 拒绝', async () => {
    const ev = Object.assign(baseEvent(), { photos: [`cloud://env.appid/orders/u1/x.exe`] })
    const { res } = await publish(ev, fixtures())
    expect(res.ok).toBe(false)
  })

  test('魔数不是图片 -> 拒绝并删除本次上传', async () => {
    const ev = Object.assign(baseEvent(), { photos: [fid('u1', 'a')] })
    const { res, deleted } = await publish(ev, fixtures(), {
      download: () => Buffer.from([0x4D, 0x5A, 0x90, 0x00]) // PE 头伪装 .jpg
    })
    expect(res.ok).toBe(false)
    expect(res.msg).toContain('jpg/png')
    expect(deleted).toEqual(ev.photos)
  })
})

describe('限频与内容安全', () => {
  test('1小时内已发3单 -> 拒绝并清理本次照片', async () => {
    const fx = fixtures()
    fx.orders = [1, 2, 3].map(i => ({ _id: 'o' + i, userOpenid: 'u1', publishedAt: new Date(NOW - 10 * 60 * 1000) }))
    const ev = Object.assign(baseEvent(), { photos: [fid('u1', 'a')] })
    const { res, deleted } = await publish(ev, fx)
    expect(res.ok).toBe(false)
    expect(res.msg).toContain('频繁')
    expect(deleted).toEqual(ev.photos)
  })

  test('文本命中违规(87014)-> 拒绝', async () => {
    const { res } = await publish(baseEvent(), fixtures(), {
      msgSec: async () => { throw { errCode: 87014 } }
    })
    expect(res.ok).toBe(false)
    expect(res.msg).toContain('违规')
  })

  test('内容安全接口自身异常 -> 放行(fail-open)', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const { res } = await publish(baseEvent(), fixtures(), {
      msgSec: async () => { throw { errCode: -1, errMsg: 'timeout' } }
    })
    errSpy.mockRestore()
    expect(res.ok).toBe(true)
  })
})

describe('成功路径', () => {
  test('建单字段完整:状态/结构化时段/脱敏相关字段齐备,手机号回填用户档案', async () => {
    const fx = fixtures()
    const ev = Object.assign(baseEvent(), { photos: [fid('u1', 'a')] })
    const { res } = await publish(ev, fx)
    expect(res.ok).toBe(true)
    expect(res.orderNo).toMatch(/^AC\d{10}-\d{8}$/) // AC+年月日时分(10位)-8位随机

    const order = fx.orders[0]
    expect(order.status).toBe('published')
    expect(order.userOpenid).toBe('u1')
    expect(order.expectSlot).toBe('morning')
    expect(order.expectEnd.getTime()).toBe(Date.UTC(2026, 7, 1, 12 - 8))
    expect(order.addressDetail).toBe('3栋502')
    expect(order.reviewed).toBe(false)
    // 手机号回填,下次发单免填
    expect(fx.users[0].phone).toBe('13800138000')
    // 照片送检登记
    expect(fx.media_checks).toHaveLength(1)
    expect(fx.media_checks[0]).toMatchObject({ type: 'order', status: 'pending' })
  })
})

describe('订单号按北京时间生成,不依赖宿主时区', () => {
  const { makeOrderNo } = require('../cloudfunctions/publishOrder/index')._internals

  test('UTC 环境下北京时间 14:00 的单号时间部分仍是 1400', () => {
    // 2026-08-08 06:00 UTC = 北京 14:00
    expect(makeOrderNo(Date.UTC(2026, 7, 8, 6, 0))).toMatch(/^AC2608081400-\d{8}$/)
  })

  test('跨日:北京时间 00:30 不会生成前一天日期', () => {
    // 2026-07-31 16:30 UTC = 北京 2026-08-01 00:30
    expect(makeOrderNo(Date.UTC(2026, 6, 31, 16, 30))).toMatch(/^AC2608010030-\d{8}$/)
  })

  test('发单落库的单号与 publishedAt 的北京时间口径一致', async () => {
    // 测试时钟 2026-08-01T02:00:00Z = 北京 10:00
    const fx = fixtures()
    const { res } = await publish(baseEvent(), fx)
    expect(res.orderNo).toMatch(/^AC2608011000-\d{8}$/)
  })
})

describe('新单通知轮转选取', () => {
  const validMaster = (id, city) => ({
    _id: id, openid: id, status: 'approved', cityKey: city,
    memberExpireAt: new Date(NOW + 3600 * 1000)
  })

  test('同城有效会员被选中即打卡 lastNotifiedAt;异城/过期不选;模板未配置不打扰', async () => {
    const fx = fixtures()
    fx.config = [{ _id: 'app', tplNewOrder: 'TPL-NEW' }]
    fx.masters = [
      validMaster('m1', '广州'),
      validMaster('m2', '广州'),
      validMaster('m3', '深圳'),                                                                 // 异城
      Object.assign(validMaster('m4', '广州'), { memberExpireAt: new Date(NOW - 1000) })          // 会员过期
    ]
    const sent = []
    const { res } = await publish(baseEvent(), fx, { send: async (m) => { sent.push(m.touser); return {} } })
    expect(res.ok).toBe(true)
    // fakeDb 的 orderBy 是空操作,选取顺序不可断言,只断言选中集合与打卡
    expect(sent.sort()).toEqual(['m1', 'm2'])
    expect(fx.masters[0].lastNotifiedAt).toBeDefined()
    expect(fx.masters[1].lastNotifiedAt).toBeDefined()
    expect(fx.masters[2].lastNotifiedAt).toBeUndefined()
    expect(fx.masters[3].lastNotifiedAt).toBeUndefined()

    // 模板未配置:不查询不打扰,发单照常成功
    const fx2 = fixtures()
    fx2.masters = [validMaster('m1', '广州')]
    const sent2 = []
    const r2 = await publish(baseEvent(), fx2, { send: async (m) => { sent2.push(m.touser); return {} } })
    expect(r2.res.ok).toBe(true)
    expect(sent2).toEqual([])
  })
})
