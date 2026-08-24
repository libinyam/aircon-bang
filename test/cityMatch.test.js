// 城市匹配键:展示名与匹配键分离的全链路行为
// 病灶:师傅手填"青岛"、订单定位解析"青岛市",字符串严格相等导致师傅永久空池
// 方案:normalizeCity 归一出 cityKey,发单/入驻落库,池/详情/通知/抢单按键匹配,admin 可回填存量
const { fakeDb } = require('./stubs/fakeDb')
const { normalizeCity } = require('../cloudfunctions/_shared/biz')

const FUTURE = () => new Date(Date.now() + 3600 * 1000)
const RECENT = () => new Date(Date.now() - 1000)

describe('normalizeCity 归一化规则', () => {
  test.each([
    ['青岛市', '青岛'], ['青岛', '青岛'], [' 青岛市 ', '青岛'],
    ['北京市', '北京'], ['恩施土家族苗族自治州', '恩施土家族苗族'],
    ['大兴安岭地区', '大兴安岭'], ['锡林郭勒盟', '锡林郭勒'],
    ['', ''], [null, ''], [undefined, '']
  ])('%s -> %s', (input, expected) => {
    expect(normalizeCity(input)).toBe(expected)
  })

  test('等价输入生成同一个匹配键(验收核心)', () => {
    expect(normalizeCity('青岛')).toBe(normalizeCity('青岛市'))
  })
})

// ---- 订单池:手填"青岛"的师傅能看到"青岛市"的订单 ----
async function callGetOrders(fx, event, openid) {
  jest.resetModules()
  global.__mockDb = fakeDb(fx)
  global.__mockCtx = { OPENID: openid }
  const { main } = require('../cloudfunctions/getOrders/index')
  const res = await main(event)
  delete global.__mockDb
  delete global.__mockCtx
  return res
}

const qingdaoOrder = (over = {}) => Object.assign({
  _id: 'o1', status: 'published', userOpenid: 'user-1',
  cityName: '青岛市', cityKey: '青岛', category: 'repair',
  publishedAt: RECENT(), expectEnd: FUTURE(), photos: []
}, over)

describe('订单池按 cityKey 匹配', () => {
  test('师傅手填"青岛"(档案未回填 cityKey):能看到"青岛市"的订单', async () => {
    const fx = {
      orders: [qingdaoOrder()],
      masters: [{ _id: 'm1', openid: 'm1', status: 'approved', serviceCity: '青岛', categories: ['repair'], memberExpireAt: FUTURE() }]
    }
    const r = await callGetOrders(fx, { action: 'pool' }, 'm1')
    expect(r.ok).toBe(true)
    expect(r.data).toHaveLength(1)
  })

  test('不同城市仍然隔离:深圳师傅看不到青岛的单', async () => {
    const fx = {
      orders: [qingdaoOrder()],
      masters: [{ _id: 'm1', openid: 'm1', status: 'approved', serviceCity: '深圳市', cityKey: '深圳', categories: ['repair'], memberExpireAt: FUTURE() }]
    }
    const r = await callGetOrders(fx, { action: 'pool' }, 'm1')
    expect(r.ok).toBe(true)
    expect(r.data).toHaveLength(0)
  })

  test('详情围观资格:老订单没有 cityKey 也按归一化键比较(JS 侧兜底)', async () => {
    const fx = {
      orders: [qingdaoOrder({ cityKey: undefined })],   // 未回填的存量订单
      masters: [{ _id: 'm1', openid: 'm1', status: 'approved', serviceCity: '青岛', categories: ['repair'], memberExpireAt: FUTURE() }],
      reviews: []
    }
    const r = await callGetOrders(fx, { action: 'detail', orderId: 'o1' }, 'm1')
    expect(r.ok).toBe(true)
    expect(r.role).toBe('viewer')
  })
})

// ---- 抢单:原子条件按 cityKey ----
describe('抢单按 cityKey 匹配', () => {
  async function grab(fx, openid) {
    jest.resetModules()
    global.__mockDb = fakeDb(fx)
    global.__mockCtx = { OPENID: openid }
    const { main } = require('../cloudfunctions/grabOrder/index')
    const res = await main({ orderId: 'o1' })
    delete global.__mockDb
    delete global.__mockCtx
    return res
  }
  const masters = () => [
    { _id: 'm1', openid: 'm1', status: 'approved', serviceCity: '青岛', categories: ['repair'], memberExpireAt: FUTURE(), realName: '李师傅', phone: '13911112222' },
    { _id: 'm2', openid: 'm2', status: 'approved', serviceCity: '深圳市', cityKey: '深圳', categories: ['repair'], memberExpireAt: FUTURE(), realName: '外地', phone: '13900001111' }
  ]

  test('手填"青岛"的师傅可抢"青岛市"的单;跨城依旧抢不到', async () => {
    const fx = {
      orders: [qingdaoOrder({ userPhone: '138', userName: '王', address: 'x小区', addressDetail: '' })],
      masters: masters(), config: [{ _id: 'app' }],
      wallets: [{ _id: 'm1', balance: 50000 }, { _id: 'm2', balance: 50000 }], wallet_logs: []
    }
    const r1 = await grab(fx, 'm2')
    expect(r1.ok).toBe(false)                       // 深圳师傅直调也抢不到青岛的单(服务费已退回)
    const r2 = await grab(fx, 'm1')
    expect(r2.ok).toBe(true)
    expect(fx.orders[0].masterOpenid).toBe('m1')
  })
})

// ---- 发单:落库带 cityKey,通知按 cityKey 圈师傅 ----
describe('发单侧 cityKey', () => {
  async function publish(fx, sends) {
    jest.resetModules()
    global.__mockDb = fakeDb(fx)
    global.__mockCtx = { OPENID: 'u1' }
    const cloudStub = require('wx-server-sdk')
    cloudStub.openapi = {
      security: { msgSecCheck: async () => ({}), mediaCheckAsync: async () => ({ traceId: 't' }) },
      subscribeMessage: { send: async (m) => { sends.push(m) } }
    }
    const { main } = require('../cloudfunctions/publishOrder/index')
    const res = await main({
      requestId: 'cm-1', category: 'repair', scene: 'home', desc: '空调开机不制冷,外机不转', photos: [],
      location: { latitude: 36.07, longitude: 120.38 }, address: '市南某小区',
      cityName: '青岛市', expectDate: futureDate(), slotKey: 'morning',
      phone: '13800138000', contactName: '王先生'
    })
    delete cloudStub.openapi
    delete global.__mockDb
    delete global.__mockCtx
    return res
  }
  // 明天(本地即可,时段校验只要求未过期且30天内)
  function futureDate() {
    const d = new Date(Date.now() + 24 * 3600 * 1000)
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
  }

  test('订单落库带 cityKey;订阅通知按 cityKey 圈同城师傅', async () => {
    const sends = []
    const fx = {
      orders: [], users: [{ openid: 'u1' }], media_checks: [],
      config: [{ _id: 'app', tplNewOrder: 'TPL-N' }],
      masters: [
        // 接单费制:推送不再筛会员,approved 同城即推;m2 异城不发
        { _id: 'm1', openid: 'm1', status: 'approved', serviceCity: '青岛', cityKey: '青岛' },
        { _id: 'm2', openid: 'm2', status: 'approved', serviceCity: '深圳市', cityKey: '深圳' }
      ]
    }
    const r = await publish(fx, sends)
    expect(r.ok).toBe(true)
    expect(fx.orders[0].cityName).toBe('青岛市')   // 展示名保留
    expect(fx.orders[0].cityKey).toBe('青岛')      // 匹配键归一
    expect(sends.map(s => s.touser)).toEqual(['m1'])
  })
})

// ---- applyMaster:入驻侧键校验 ----
describe('入驻侧 cityKey', () => {
  async function apply(fx, serviceCity) {
    jest.resetModules()
    global.__mockDb = fakeDb(fx)
    global.__mockCtx = { OPENID: 'm-new' }
    global.__mockDownload = () => Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10])
    const cloudStub = require('wx-server-sdk')
    cloudStub.openapi = {
      security: { msgSecCheck: async () => ({}), mediaCheckAsync: async () => ({ traceId: 't' }) }
    }
    const { main } = require('../cloudfunctions/applyMaster/index')
    const res = await main({
      realName: '李师傅', phone: '13911112222', serviceCity, categories: ['repair'],
      idCardFront: 'cloud://env.x/quals/m-new/f.jpg', idCardBack: 'cloud://env.x/quals/m-new/b.jpg'
    })
    delete cloudStub.openapi
    delete global.__mockDb
    delete global.__mockCtx
    delete global.__mockDownload
    return res
  }

  test('手填"青岛市":归一化落库 cityKey=青岛,展示名保留原样', async () => {
    const fx = { masters: [], media_checks: [] }
    const r = await apply(fx, '青岛市')
    expect(r.ok).toBe(true)
    expect(fx.masters[0].serviceCity).toBe('青岛市')
    expect(fx.masters[0].cityKey).toBe('青岛')
  })

  test.each([['市'], ['X'], ['   ']])('无法识别的手输城市 %s:明确拒绝,不静默保存', async (city) => {
    const fx = { masters: [], media_checks: [] }
    const r = await apply(fx, city)
    expect(r.ok).toBe(false)
    expect(r.msg).toContain('无法识别')
    expect(fx.masters).toHaveLength(0)
  })
})

// ---- admin 回填:存量数据补键 ----
describe('backfillCityKeys 存量回填', () => {
  async function callAdmin(fx, event) {
    jest.resetModules()
    global.__mockDb = fakeDb(fx)
    global.__mockCtx = { OPENID: 'admin-1' }
    const { main } = require('../cloudfunctions/admin/index')
    const res = await main(event)
    delete global.__mockDb
    delete global.__mockCtx
    return res
  }

  test('师傅/订单按现行规则补 cityKey,重跑幂等', async () => {
    const fx = {
      config: [{ _id: 'app', adminOpenids: ['admin-1'] }],
      masters: [
        { _id: 'm1', serviceCity: '青岛' },
        { _id: 'm2', serviceCity: '深圳市', cityKey: '深圳' }   // 已有且一致:跳过
      ],
      orders: [{ _id: 'o1', cityName: '青岛市' }]
    }
    const r1 = await callAdmin(fx, { action: 'backfillCityKeys' })
    expect(r1).toMatchObject({ ok: true, masters: 1, orders: 1 })
    expect(fx.masters[0].cityKey).toBe('青岛')
    expect(fx.orders[0].cityKey).toBe('青岛')

    const r2 = await callAdmin(fx, { action: 'backfillCityKeys' })
    expect(r2).toMatchObject({ ok: true, masters: 0, orders: 0 })
  })
})
