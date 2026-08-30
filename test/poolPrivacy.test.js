// 订单池隐私投影:照片只以换链后的临时 URL 下发(池卡片缩略,最多 3 张)——
// 原始 fileID 路径含发单用户 openid,任何情况下不得出现在响应;换链失败置空,photoCount 兜底
const { fakeDb } = require('./stubs/fakeDb')

const FUTURE = () => new Date(Date.now() + 3600 * 1000)
const RECENT = () => new Date(Date.now() - 1000)

async function callPool(fx, openid = 'm1', mockTemp) {
  jest.resetModules()
  global.__mockDb = fakeDb(fx)
  global.__mockCtx = { OPENID: openid }
  if (mockTemp) global.__mockTempFileURL = mockTemp
  const { main } = require('../cloudfunctions/getOrders/index')
  const res = await main({ action: 'pool' })
  delete global.__mockDb
  delete global.__mockCtx
  delete global.__mockTempFileURL
  return res
}

// 干净临时链 mock:URL 与 fileID 无关即可——本测试钉"原始 fileID 不外泄"的投影规则。
//修复后另钉一条:传给 getTempFileURL 的必须是匿名副本 fileID(不含 openid)
const cleanTemp = (list) => ({ fileList: list.map((f, i) => ({ fileID: f, tempFileURL: 'https://tmp/photo-' + i + '.jpg' })) })

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
  test('照片以临时链下发,响应不含原始 fileID 与发单人 openid 痕迹', async () => {
    const seen = []
    const r = await callPool(FX(), 'm1', (list) => { seen.push(...list); return cleanTemp(list) })
    expect(r.ok).toBe(true)
    expect(r.data).toHaveLength(2)
    //换链请求的入参必须是匿名副本,含 openid 的 fileID 连换链环节都不出现
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.join('|')).not.toContain('user-1')
    expect(seen.join('|')).toContain('alias/')
    const byId = Object.fromEntries(r.data.map(o => [o._id, o]))
    expect(byId.o1.photos).toEqual(['https://tmp/photo-0.jpg', 'https://tmp/photo-1.jpg'])
    expect(byId.o1.photoCount).toBe(2)
    expect(byId.o2.photos).toEqual([])
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

  test('超过 3 张照片:缩略限量 3 张,photoCount 保留全量数', async () => {
    const fx = FX()
    fx.orders[0].photos = [1, 2, 3, 4, 5].map(n => 'cloud://x/orders/user-1/p' + n + '.jpg')
    const r = await callPool(fx, 'm1', cleanTemp)
    const byId = Object.fromEntries(r.data.map(o => [o._id, o]))
    expect(byId.o1.photos).toHaveLength(3)
    expect(byId.o1.photoCount).toBe(5)
  })

  test('换链抛错:缩略置空不回退 fileID,photoCount 兜底', async () => {
    const r = await callPool(FX(), 'm1', async () => { throw new Error('boom') })
    const byId = Object.fromEntries(r.data.map(o => [o._id, o]))
    expect(byId.o1.photos).toEqual([])
    expect(byId.o1.photoCount).toBe(2)
    expect(JSON.stringify(r)).not.toContain('cloud://')
  })

  test('个别照片缺链:只下发换到的,photoCount 不虚报', async () => {
    const partialTemp = (list) => ({ fileList: list.map((f, i) => ({ fileID: f, tempFileURL: i === 0 ? 'https://tmp/ok.jpg' : '' })) })
    const r = await callPool(FX(), 'm1', partialTemp)
    const byId = Object.fromEntries(r.data.map(o => [o._id, o]))
    expect(byId.o1.photos).toEqual(['https://tmp/ok.jpg'])
    expect(byId.o1.photoCount).toBe(2)
  })
})
