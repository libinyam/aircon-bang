// grabOrder 抢单并发唯一性 + 资格闸门 + 按单扣费(接单费制)
// 并发语义:条件原子更新 where(status=published),第二人 update 命中 0 行即失败——
// 真库的原子性由 TCB 保证,这里验证代码路径确实依赖该语义(而不是先查后改)
// 扣费语义:先原子扣款(balance>=fee 条件更新)再抢单,没抢到补偿退回;流水 _id 幂等
const { fakeDb } = require('./stubs/fakeDb')

const FUTURE = () => new Date(Date.now() + 3600 * 1000)
const RECENT = () => new Date(Date.now() - 1000)
// 家用 2000 / 商用 30000(_shared/biz.js 的 SCENES.grabFee,单位分)
const HOME_FEE = 2000
const COMM_FEE = 30000

function fixtures() {
  return {
    orders: [{
      _id: 'o1', status: 'published', userOpenid: 'user-1', cityName: '广州市', cityKey: '广州',
      category: 'repair', scene: 'home', publishedAt: RECENT(), expectEnd: FUTURE(),
      userPhone: '13800138000', userName: '王先生', address: '某小区', addressDetail: '3栋502',
      orderNo: 'AC1', masterOpenid: ''
    }],
    masters: [
      { _id: 'm1', openid: 'master-1', status: 'approved', serviceCity: '广州市',
        categories: ['repair'], realName: '李师傅', phone: '13911112222' },
      { _id: 'm2', openid: 'master-2', status: 'approved', serviceCity: '广州市',
        categories: ['repair'], realName: '张师傅', phone: '13933334444' },
      { _id: 'm4', openid: 'master-pending', status: 'pending', serviceCity: '广州市',
        categories: ['repair'], realName: '待审', phone: '13977778888' },
      { _id: 'm5', openid: 'master-othercity', status: 'approved', serviceCity: '深圳市',
        categories: ['repair'], realName: '外地', phone: '13900001111' }
    ],
    // 默认人手 50000 分(¥500):够接商用单,便于各用例自行改小
    wallets: [
      { _id: 'master-1', balance: 50000 },
      { _id: 'master-2', balance: 50000 },
      { _id: 'master-pending', balance: 50000 },
      { _id: 'master-othercity', balance: 50000 }
    ],
    wallet_logs: [],
    config: [{ _id: 'app', adminOpenids: [], tplOrderTaken: '' }]
  }
}

async function grab(openid, db, orderId = 'o1') {
  jest.resetModules()
  global.__mockDb = db
  global.__mockCtx = { OPENID: openid }
  const { main } = require('../cloudfunctions/grabOrder/index')
  const res = await main({ orderId })
  delete global.__mockDb
  delete global.__mockCtx
  return res
}

describe('grabOrder 并发唯一性 + 扣费', () => {
  test('第一人抢到:扣家用费,写扣款流水,返回 feeCharged', async () => {
    const fx = fixtures()
    const r = await grab('master-1', fakeDb(fx))
    expect(r.ok).toBe(true)
    expect(r.feeCharged).toBe(HOME_FEE)
    expect(r.sceneName).toBe('家用')
    expect(r.userPhone).toBe('13800138000')
    expect(r.address).toBe('某小区 3栋502')
    expect(fx.orders[0].status).toBe('accepted')
    expect(fx.orders[0].masterOpenid).toBe('master-1')
    expect(fx.wallets[0].balance).toBe(50000 - HOME_FEE)
    expect(fx.wallet_logs.some(l => l._id === 'grab:o1:master-1' && l.amount === -HOME_FEE)).toBe(true)
  })

  test('第二人再抢同一单:扣款前被前置闸拒绝,不产生扣款/退款流水', async () => {
    const fx = fixtures()
    const db = fakeDb(fx)
    const r1 = await grab('master-1', db)
    const r2 = await grab('master-2', db)
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(false)
    expect(r2.msg).toContain('手慢了')
    expect(fx.orders[0].masterOpenid).toBe('master-1')
    // 败者在扣款前即被拒:余额分毫未动、零流水(不再是"先扣又退"白穿易碎点)
    expect(fx.wallets[1].balance).toBe(50000)
    expect(fx.wallet_logs.filter(l => l.openid === 'master-2')).toHaveLength(0)
    // 胜者只被扣一次
    expect(fx.wallets[0].balance).toBe(50000 - HOME_FEE)
  })

  test('终态单(已取消)再抢:扣款前拒绝,余额不动、无流水', async () => {
    const fx = fixtures()
    fx.orders[0].status = 'cancelled'
    const r = await grab('master-1', fakeDb(fx))
    expect(r.ok).toBe(false)
    expect(r.msg).toContain('手慢了')
    expect(fx.wallets[0].balance).toBe(50000)
    expect(fx.wallet_logs).toHaveLength(0)
  })

  test('商用单扣 30000:按订单 scene 定档', async () => {
    const fx = fixtures()
    fx.orders[0].scene = 'commercial'
    const r = await grab('master-1', fakeDb(fx))
    expect(r.ok).toBe(true)
    expect(r.feeCharged).toBe(COMM_FEE)
    expect(fx.wallets[0].balance).toBe(50000 - COMM_FEE)
  })

  test('老订单无 scene:按家用计费(与前端口径一致)', async () => {
    const fx = fixtures()
    delete fx.orders[0].scene
    const r = await grab('master-1', fakeDb(fx))
    expect(r.ok).toBe(true)
    expect(r.feeCharged).toBe(HOME_FEE)
  })
})

describe('grabOrder 资格与余额闸门', () => {
  test.each([
    ['未过审核', 'master-pending', '入驻并通过审核'],
    ['发单人自己(伪造师傅身份场景)', 'user-1', '入驻并通过审核']
  ])('%s -> 拒绝', async (_label, openid, msgPart) => {
    const fx = fixtures()
    const r = await grab(openid, fakeDb(fx))
    expect(r.ok).toBe(false)
    expect(r.msg).toContain(msgPart)
    expect(fx.orders[0].status).toBe('published')
  })

  test('余额不足:拒绝并明示金额,订单不动、无流水', async () => {
    const fx = fixtures()
    fx.wallets[0].balance = HOME_FEE - 1
    const r = await grab('master-1', fakeDb(fx))
    expect(r.ok).toBe(false)
    expect(r.msg).toContain('余额不足')
    expect(r.msg).toContain('20')
    expect(fx.orders[0].status).toBe('published')
    expect(fx.wallets[0].balance).toBe(HOME_FEE - 1)
    expect(fx.wallet_logs).toHaveLength(0)
  })

  test('没有钱包文档(从未充值):视同余额不足', async () => {
    const fx = fixtures()
    fx.wallets = []
    const r = await grab('master-1', fakeDb(fx))
    expect(r.ok).toBe(false)
    expect(r.msg).toContain('余额不足')
    expect(fx.orders[0].status).toBe('published')
  })

  test('余额只够家用、接商用单:按商用档拒', async () => {
    const fx = fixtures()
    fx.orders[0].scene = 'commercial'
    fx.wallets[0].balance = 20000   // 够家用不够商用
    const r = await grab('master-1', fakeDb(fx))
    expect(r.ok).toBe(false)
    expect(r.msg).toContain('300')
    expect(fx.orders[0].status).toBe('published')
  })

  test('跨城市师傅:抢单命中 0 行,先扣的服务费退回(封死绕池直抢)', async () => {
    const fx = fixtures()
    const r = await grab('master-othercity', fakeDb(fx))
    expect(r.ok).toBe(false)
    expect(fx.orders[0].status).toBe('published')
    expect(fx.wallets[3].balance).toBe(50000)
  })

  test('过期需求(expectEnd 已过):不可抢,服务费退回', async () => {
    const fx = fixtures()
    fx.orders[0].expectEnd = new Date(Date.now() - 1000)
    const r = await grab('master-1', fakeDb(fx))
    expect(r.ok).toBe(false)
    expect(fx.orders[0].status).toBe('published')
    expect(fx.wallets[0].balance).toBe(50000)
  })

  test('前会员制字段 memberExpireAt 不再是门槛:过期档案只要余额够即可接单', async () => {
    const fx = fixtures()
    fx.masters[0].memberExpireAt = new Date(Date.now() - 1000)  // 会员早已过期
    const r = await grab('master-1', fakeDb(fx))
    expect(r.ok).toBe(true)   // 接单费制:过期会员同样可自费接单
    expect(fx.wallets[0].balance).toBe(50000 - HOME_FEE)
  })
})

describe('grabOrder 退款失败落库待补', () => {
  // 只炸退款更新(无 balance 条件的钱包更新),扣款更新(balance>=fee 条件)放行
  const failRefundUpdate = (name, filter) => name === 'wallets' && !filter.balance

  test('抢单 miss 后退款失败:落 need_manual 退款流水,文案承诺自动退回', async () => {
    const fx = fixtures()
    const db = fakeDb(fx)
    global.__failUpdate = failRefundUpdate
    try {
      const r = await grab('master-othercity', db)   // 城市不符 -> miss -> 退款被炸
      expect(r.ok).toBe(false)
      expect(r.msg).toContain('自动退回')
      expect(fx.wallets[3].balance).toBe(50000 - HOME_FEE)   // 扣款成功、退款未到账
      const pending = fx.wallet_logs.find(l => l._id === 'refund:grab:o1:master-othercity')
      expect(pending).toMatchObject({ type: 'refund', amount: HOME_FEE, status: 'need_manual' })
    } finally {
      delete global.__failUpdate
    }
  })

  test('正常退款不受影响:无注入时 miss 退款照常落账', async () => {
    const fx = fixtures()
    const r = await grab('master-othercity', fakeDb(fx))
    expect(r.ok).toBe(false)
    expect(fx.wallets[3].balance).toBe(50000)
    const refund = fx.wallet_logs.find(l => l._id === 'refund:grab:o1:master-othercity')
    expect(refund.amount).toBe(HOME_FEE)
    expect(refund.status).toBeUndefined()   // 正常退款流水无 status,与待补流水区分
  })
})

describe('grabOrder 品类多选单(任一交集即可抢)', () => {
  const multiFx = (masterCats) => ({
    orders: [{
      _id: 'o1', status: 'published', userOpenid: 'user-1', cityName: '广州市', cityKey: '广州',
      category: 'repair', categories: ['repair', 'clean'],   // 多选单:首选项镜像 + 全集
      publishedAt: RECENT(), expectEnd: FUTURE(),
      userPhone: '13800138000', userName: '王先生', address: '某小区', addressDetail: '',
      orderNo: 'AC1', masterOpenid: ''
    }],
    masters: [{
      _id: 'm1', openid: 'master-x', status: 'approved', serviceCity: '广州市', cityKey: '广州',
      categories: masterCats, memberExpireAt: FUTURE(), realName: '李师傅', phone: '13911112222'
    }],
    // 接单费制:多选单默认无 scene 字段(老单形状),按家用档扣,余额须够
    wallets: [{ _id: 'master-x', balance: 50000 }],
    wallet_logs: [],
    config: [{ _id: 'app' }]
  })

  test('只会清洗的师傅能抢 [维修,清洗] 的多选单(原子条件按 categories 交集命中)', async () => {
    const fx = multiFx(['clean'])
    const r = await grab('master-x', fakeDb(fx))
    expect(r.ok).toBe(true)
    expect(fx.orders[0].masterOpenid).toBe('master-x')
  })

  test('能力完全无交集([移机]):条件更新命中 0 行', async () => {
    const fx = multiFx(['move'])
    const r = await grab('master-x', fakeDb(fx))
    expect(r.ok).toBe(false)
    expect(fx.orders[0].status).toBe('published')
  })
})
