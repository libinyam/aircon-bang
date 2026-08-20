// grabOrder 抢单并发唯一性 + 资格闸门
// 并发语义:条件原子更新 where(status=published),第二人 update 命中 0 行即失败——
// 真库的原子性由 TCB 保证,这里验证代码路径确实依赖该语义(而不是先查后改)
const { fakeDb } = require('./stubs/fakeDb')

const FUTURE = () => new Date(Date.now() + 3600 * 1000)
const RECENT = () => new Date(Date.now() - 1000)

function fixtures() {
  return {
    orders: [{
      _id: 'o1', status: 'published', userOpenid: 'user-1', cityName: '广州市', cityKey: '广州',
      category: 'repair', publishedAt: RECENT(), expectEnd: FUTURE(),
      userPhone: '13800138000', userName: '王先生', address: '某小区', addressDetail: '3栋502',
      orderNo: 'AC1', masterOpenid: ''
    }],
    masters: [
      { _id: 'm1', openid: 'master-1', status: 'approved', serviceCity: '广州市',
        categories: ['repair'], memberExpireAt: FUTURE(), realName: '李师傅', phone: '13911112222' },
      { _id: 'm2', openid: 'master-2', status: 'approved', serviceCity: '广州市',
        categories: ['repair'], memberExpireAt: FUTURE(), realName: '张师傅', phone: '13933334444' },
      { _id: 'm3', openid: 'master-expired', status: 'approved', serviceCity: '广州市',
        categories: ['repair'], memberExpireAt: new Date(Date.now() - 1000), realName: '过期', phone: '13955556666' },
      { _id: 'm4', openid: 'master-pending', status: 'pending', serviceCity: '广州市',
        categories: ['repair'], memberExpireAt: FUTURE(), realName: '待审', phone: '13977778888' },
      { _id: 'm5', openid: 'master-othercity', status: 'approved', serviceCity: '深圳市',
        categories: ['repair'], memberExpireAt: FUTURE(), realName: '外地', phone: '13900001111' }
    ],
    config: [{ _id: 'app', adminOpenids: [], tplOrderTaken: '' }]
  }
}

async function grab(openid, db) {
  jest.resetModules()
  global.__mockDb = db
  global.__mockCtx = { OPENID: openid }
  const { main } = require('../cloudfunctions/grabOrder/index')
  const res = await main({ orderId: 'o1' })
  delete global.__mockDb
  delete global.__mockCtx
  return res
}

describe('grabOrder 并发唯一性', () => {
  test('第一人抢到:状态翻转 accepted,拿到用户手机号与完整地址', async () => {
    const fx = fixtures()
    const r = await grab('master-1', fakeDb(fx))
    expect(r.ok).toBe(true)
    expect(r.userPhone).toBe('13800138000')
    expect(r.address).toBe('某小区 3栋502')
    expect(fx.orders[0].status).toBe('accepted')
    expect(fx.orders[0].masterOpenid).toBe('master-1')
  })

  test('第二人再抢同一单:命中 0 行,提示手慢,接单人不变', async () => {
    const fx = fixtures()
    const db = fakeDb(fx)
    const r1 = await grab('master-1', db)
    const r2 = await grab('master-2', db)
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(false)
    expect(r2.msg).toContain('手慢了')
    expect(fx.orders[0].masterOpenid).toBe('master-1')
  })
})

describe('grabOrder 资格闸门', () => {
  test.each([
    ['会员过期', 'master-expired', '会员已到期'],
    ['未过审核', 'master-pending', '入驻并通过审核'],
    ['发单人自己(伪造师傅身份场景)', 'user-1', '入驻并通过审核']
  ])('%s -> 拒绝', async (_label, openid, msgPart) => {
    const fx = fixtures()
    const r = await grab(openid, fakeDb(fx))
    expect(r.ok).toBe(false)
    expect(r.msg).toContain(msgPart)
    expect(fx.orders[0].status).toBe('published')
  })

  test('跨城市师傅:条件更新命中 0 行(封死绕过订单池直接抢)', async () => {
    const fx = fixtures()
    const r = await grab('master-othercity', fakeDb(fx))
    expect(r.ok).toBe(false)
    expect(fx.orders[0].status).toBe('published')
  })

  test('过期需求(expectEnd 已过):不可抢', async () => {
    const fx = fixtures()
    fx.orders[0].expectEnd = new Date(Date.now() - 1000)
    const r = await grab('master-1', fakeDb(fx))
    expect(r.ok).toBe(false)
    expect(fx.orders[0].status).toBe('published')
  })
})
