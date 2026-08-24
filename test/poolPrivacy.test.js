// 订单池隐私投影:列表不下发照片 fileID——上传路径含发单用户 openid,
// 池卡片又不展示图,原样下发既泄露持久身份标识又浪费流量;只给 photoCount
const { fakeDb } = require('./stubs/fakeDb')

const FUTURE = () => new Date(Date.now() + 3600 * 1000)
const RECENT = () => new Date(Date.now() - 1000)

async function callPool(fx, openid = 'm1') {
  jest.resetModules()
  global.__mockDb = fakeDb(fx)
  global.__mockCtx = { OPENID: openid }
  const { main } = require('../cloudfunctions/getOrders/index')
  const res = await main({ action: 'pool' })
  delete global.__mockDb
  delete global.__mockCtx
  return res
}

const FX = () => ({
  orders: [
    {
      _id: 'o1', status: 'published', userOpenid: 'user-1', cityName: '广州市', cityKey: '广州',
      category: 'repair', categories: ['repair', 'clean'],   // 多选单:池响应只该见 categoryName,全集键不下发
      publishedAt: RECENT(), expectEnd: FUTURE(),
      photos: ['cloud://x/orders/user-1/a.jpg', 'cloud://x/orders/user-1/b.jpg'],
      userPhone: '13800138000', addressDetail: '3栋502',
      location: { type: 'Point', coordinates: [113.264385, 23.129112] }
    },
    {
      _id: 'o2', status: 'published', userOpenid: 'user-2', cityName: '广州市', cityKey: '广州',
      category: 'repair', publishedAt: RECENT(), expectEnd: FUTURE(), photos: []
    }
  ],
  masters: [{ _id: 'm1', openid: 'm1', status: 'approved', serviceCity: '广州市', cityKey: '广州', categories: ['repair'], memberExpireAt: FUTURE() }]
})

describe('订单池列表投影', () => {
  test('响应不含照片 fileID 与发单人 openid 痕迹,photoCount 保留"有无图"信息', async () => {
    const r = await callPool(FX())
    expect(r.ok).toBe(true)
    expect(r.data).toHaveLength(2)
    const byId = Object.fromEntries(r.data.map(o => [o._id, o]))
    expect(byId.o1.photos).toBeUndefined()
    expect(byId.o1.photoCount).toBe(2)
    expect(byId.o2.photoCount).toBe(0)
    // 整个响应任何角落都不能出现 fileID / 用户 openid 路径
    const body = JSON.stringify(r)
    expect(body).not.toContain('cloud://')
    expect(body).not.toContain('user-1')
    // 既有脱敏不回退:手机号/门牌照旧不可见,坐标照旧模糊;
    // 多选全集 categories 是匹配用内部键,围观展示走 categoryName,不下发
    expect(byId.o1.userPhone).toBeUndefined()
    expect(byId.o1.addressDetail).toBeUndefined()
    expect(byId.o1.categories).toBeUndefined()
    expect(byId.o1.location.coordinates).toEqual([113.26, 23.13])
  })
})
