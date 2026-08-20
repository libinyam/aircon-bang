// getOrders detail 四分支权限回归:
// owner 全貌 / master 全貌 / 同城同品类师傅围观脱敏版 / 其他人拒绝
const { fakeDb } = require('./stubs/fakeDb')

const ORDER_ACCEPTED = {
  _id: 'o-accepted', orderNo: 'AC1', status: 'accepted',
  userOpenid: 'user-1', userPhone: '13800138000', userName: '王先生',
  masterOpenid: 'master-1', masterName: '李师傅', masterPhone: '13900139000',
  category: 'repair', categoryName: '空调维修', desc: '不制冷',
  address: '某小区', addressDetail: '3栋502', cityName: '广州市',
  photos: [], location: { type: 'Point', coordinates: [113.264385, 23.129112] },
  reviewed: false, publishedAt: new Date('2026-08-01')
}
const ORDER_PUBLISHED = {
  _id: 'o-published', orderNo: 'AC2', status: 'published',
  userOpenid: 'user-1', userPhone: '13800138000', userName: '王先生',
  masterOpenid: '', category: 'repair', categoryName: '空调维修', desc: '异响',
  address: '某小区', addressDetail: '5栋101', cityName: '广州市',
  photos: ['cloud://x/orders/user-1/a.jpg'],
  location: { type: 'Point', coordinates: [113.264385, 23.129112] },
  reviewed: false, publishedAt: new Date('2026-08-01')
}
const MASTERS = [
  { _id: 'm1', openid: 'master-1', status: 'approved', serviceCity: '广州市', categories: ['repair'], stats: { done: 8, reviewCount: 5, totalStars: 24 } },
  { _id: 'm2', openid: 'master-2', status: 'approved', serviceCity: '广州市', categories: ['repair'], stats: { done: 0, reviewCount: 0, totalStars: 0 } },
  { _id: 'm3', openid: 'master-3', status: 'approved', serviceCity: '深圳市', categories: ['repair'], stats: { done: 0, reviewCount: 0, totalStars: 0 } },
  { _id: 'm4', openid: 'master-4', status: 'approved', serviceCity: '广州市', categories: ['clean'], stats: { done: 0, reviewCount: 0, totalStars: 0 } }
]

// 每个用例独立加载模块:先注入 mock db 与身份,再 require(getOrders 在模块顶层取 db)
async function callDetail(openid, orderId) {
  jest.resetModules()
  global.__mockDb = fakeDb({
    orders: [JSON.parse(JSON.stringify(ORDER_ACCEPTED)), JSON.parse(JSON.stringify(ORDER_PUBLISHED))],
    masters: JSON.parse(JSON.stringify(MASTERS)),
    reviews: []
  })
  global.__mockCtx = { OPENID: openid }
  const { main } = require('../cloudfunctions/getOrders/index')
  const res = await main({ action: 'detail', orderId })
  delete global.__mockDb
  delete global.__mockCtx
  return res
}

describe('detail 权限四分支', () => {
  test('owner:看全貌(含手机号/门牌),role=user,带师傅口碑', async () => {
    const r = await callDetail('user-1', 'o-accepted')
    expect(r.ok).toBe(true)
    expect(r.role).toBe('user')
    expect(r.data.userPhone).toBe('13800138000')
    expect(r.data.addressDetail).toBe('3栋502')
    expect(r.masterStats).toEqual({ done: 8, reviewCount: 5, totalStars: 24 })
  })

  test('接单师傅:看全貌,role=master', async () => {
    const r = await callDetail('master-1', 'o-accepted')
    expect(r.ok).toBe(true)
    expect(r.role).toBe('master')
    expect(r.data.userPhone).toBe('13800138000')
    expect(r.data.addressDetail).toBe('3栋502')
  })

  test('围观师傅(同城同品类)看 published 单:脱敏版,无手机号/门牌,坐标模糊', async () => {
    const r = await callDetail('master-2', 'o-published')
    expect(r.ok).toBe(true)
    expect(r.role).toBe('viewer')
    expect(r.data).not.toHaveProperty('userPhone')
    expect(r.data).not.toHaveProperty('userName')
    expect(r.data).not.toHaveProperty('addressDetail')
    expect(r.data).not.toHaveProperty('userOpenid')
    expect(r.data.location.coordinates).toEqual([113.26, 23.13])
    // 照片经云函数换成临时链接
    expect(r.data.photos).toEqual(['https://tmp/cloud://x/orders/user-1/a.jpg'])
  })

  test.each([
    ['跨城市师傅', 'master-3', 'o-published'],
    ['品类不符师傅', 'master-4', 'o-published'],
    ['无关普通用户', 'stranger-1', 'o-published'],
    ['围观师傅看非 published 单', 'master-2', 'o-accepted']
  ])('拒绝:%s', async (_label, openid, orderId) => {
    const r = await callDetail(openid, orderId)
    expect(r.ok).toBe(false)
    // 拒绝响应不携带任何订单数据
    expect(r.data).toBeUndefined()
  })

  test('订单不存在:拒绝', async () => {
    const r = await callDetail('user-1', 'no-such-order')
    expect(r.ok).toBe(false)
  })
})

describe('viewer 会员状态随详情下发', () => {
  test('会员有效:memberValid true;过期/未开通:false(详情仍可看)', async () => {
    // 固定 MASTERS 里 master-2 无 memberExpireAt -> false
    const r1 = await callDetail('master-2', 'o-published')
    expect(r1.ok).toBe(true)
    expect(r1.memberValid).toBe(false)

    // 有效会员单独构造
    jest.resetModules()
    const fx = {
      orders: [JSON.parse(JSON.stringify(ORDER_PUBLISHED))],
      masters: [{ _id: 'm9', openid: 'master-9', status: 'approved', serviceCity: '广州市', categories: ['repair'], memberExpireAt: new Date(Date.now() + 3600 * 1000) }],
      reviews: []
    }
    global.__mockDb = fakeDb(fx)
    global.__mockCtx = { OPENID: 'master-9' }
    const { main } = require('../cloudfunctions/getOrders/index')
    const r2 = await main({ action: 'detail', orderId: 'o-published' })
    delete global.__mockDb
    delete global.__mockCtx
    expect(r2.memberValid).toBe(true)
  })

  test('订单双方视角不下发 memberValid(前端视为不受限)', async () => {
    const r = await callDetail('user-1', 'o-accepted')
    expect(r.memberValid).toBeUndefined()
  })
})

describe('viewer 照片严格换链:换链失败不回退原始 fileID', () => {
  afterEach(() => { delete global.__mockTempFileURL })

  test('getTempFileURL 抛错:围观师傅拿到空照片列表,不含 openid 路径', async () => {
    global.__mockTempFileURL = () => { throw new Error('storage timeout') }
    const r = await callDetail('master-2', 'o-published')
    expect(r.ok).toBe(true)
    expect(r.data.photos).toEqual([])
  })

  test('个别文件缺 tempFileURL:该文件被剔除而不是回退 fileID', async () => {
    global.__mockTempFileURL = (fileList) => ({
      fileList: fileList.map((f, i) => i === 0 ? { fileID: f } : { fileID: f, tempFileURL: 'https://tmp/' + f })
    })
    const r = await callDetail('master-2', 'o-published')
    expect(r.ok).toBe(true)
    expect(r.data.photos).toEqual([])   // ORDER_PUBLISHED 只有1张,被剔除
    expect(JSON.stringify(r.data)).not.toContain('user-1')   // 响应任何角落都不带发单人 openid
  })

  test('订单双方(owner)换链失败仍回退 fileID:创建者本人可读,看图能力不受影响', async () => {
    global.__mockTempFileURL = () => { throw new Error('storage timeout') }
    const r = await callDetail('user-1', 'o-published')
    expect(r.ok).toBe(true)
    expect(r.data.photos).toEqual(['cloud://x/orders/user-1/a.jpg'])
  })
})

describe('detail 并行取评价与师傅口碑', () => {
  test('owner 看已评价的完成单:review 与 masterStats 同时返回', async () => {
    jest.resetModules()
    const order = JSON.parse(JSON.stringify(ORDER_ACCEPTED))
    order.status = 'completed'
    order.reviewed = true
    global.__mockDb = fakeDb({
      orders: [order],
      masters: JSON.parse(JSON.stringify(MASTERS)),
      reviews: [{ _id: 'o-accepted', orderId: 'o-accepted', stars: 5, content: '很给力' }]
    })
    global.__mockCtx = { OPENID: 'user-1' }
    const { main } = require('../cloudfunctions/getOrders/index')
    const r = await main({ action: 'detail', orderId: 'o-accepted' })
    delete global.__mockDb
    delete global.__mockCtx
    expect(r.ok).toBe(true)
    expect(r.role).toBe('user')
    expect(r.review).toEqual({ _id: 'o-accepted', orderId: 'o-accepted', stars: 5, content: '很给力' })
    expect(r.masterStats).toEqual({ done: 8, reviewCount: 5, totalStars: 24 })
  })
})
