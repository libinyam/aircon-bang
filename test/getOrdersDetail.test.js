// getOrders detail 四分支权限回归():
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
    // 照片经匿名副本换临时链下发:URL 不得含发单人 openid
    expect(r.data.photos).toHaveLength(1)
    expect(r.data.photos[0]).toMatch(/^https:\/\/tmp\//)
    expect(r.data.photos[0]).not.toContain('user-1')
    expect(JSON.stringify(r.data)).not.toContain('orders/user-1')
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

describe('detail 围观资格:品类多选任一交集', () => {
  // 多选单:首选项镜像 category=repair,全集 categories=[repair,clean]
  const multiOrder = () => {
    const o = JSON.parse(JSON.stringify(ORDER_PUBLISHED))
    o.categories = ['repair', 'clean']
    return o
  }
  async function callDetailAs(openid, order) {
    jest.resetModules()
    global.__mockDb = fakeDb({
      orders: [order],
      masters: [
        { _id: 'mc', openid: 'master-clean', status: 'approved', serviceCity: '广州市', categories: ['clean'], stats: { done: 0, reviewCount: 0, totalStars: 0 } },
        { _id: 'mm', openid: 'master-move', status: 'approved', serviceCity: '广州市', categories: ['move'], stats: { done: 0, reviewCount: 0, totalStars: 0 } }
      ],
      reviews: []
    })
    global.__mockCtx = { OPENID: openid }
    const { main } = require('../cloudfunctions/getOrders/index')
    const res = await main({ action: 'detail', orderId: order._id })
    delete global.__mockDb
    delete global.__mockCtx
    return res
  }

  test('只会清洗的师傅可围观 [维修,清洗] 的单;能力无交集([移机])拒绝', async () => {
    const r1 = await callDetailAs('master-clean', multiOrder())
    expect(r1.ok).toBe(true)
    expect(r1.role).toBe('viewer')

    const r2 = await callDetailAs('master-move', multiOrder())
    expect(r2.ok).toBe(false)
    expect(r2.data).toBeUndefined()
  })
})

describe('viewer 钱包余额随详情下发(接单费制,原会员口径)', () => {
  test('无钱包文档:walletBalance 0(详情仍可看,前端引导充值)', async () => {
    const r1 = await callDetail('master-2', 'o-published')
    expect(r1.ok).toBe(true)
    expect(r1.walletBalance).toBe(0)
  })

  test('有钱包:下发真实余额', async () => {
    jest.resetModules()
    const fx = {
      orders: [JSON.parse(JSON.stringify(ORDER_PUBLISHED))],
      masters: [{ _id: 'm9', openid: 'master-9', status: 'approved', serviceCity: '广州市', categories: ['repair'] }],
      reviews: [],
      wallets: [{ _id: 'master-9', balance: 30000 }]
    }
    global.__mockDb = fakeDb(fx)
    global.__mockCtx = { OPENID: 'master-9' }
    const { main } = require('../cloudfunctions/getOrders/index')
    const r2 = await main({ action: 'detail', orderId: 'o-published' })
    delete global.__mockDb
    delete global.__mockCtx
    expect(r2.walletBalance).toBe(30000)
  })

  test('订单双方视角不下发 walletBalance(前端视为不受限)', async () => {
    const r = await callDetail('user-1', 'o-accepted')
    expect(r.walletBalance).toBeUndefined()
  })

  test('围观脱敏版放行 scene/sceneName(前端显示家用/商用与接单费)', async () => {
    jest.resetModules()
    const order = JSON.parse(JSON.stringify(ORDER_PUBLISHED))
    order.scene = 'commercial'
    order.sceneName = '商用'
    global.__mockDb = fakeDb({ orders: [order], masters: JSON.parse(JSON.stringify(MASTERS)), reviews: [] })
    global.__mockCtx = { OPENID: 'master-2' }
    const { main } = require('../cloudfunctions/getOrders/index')
    const r = await main({ action: 'detail', orderId: 'o-published' })
    delete global.__mockDb
    delete global.__mockCtx
    expect(r.data.scene).toBe('commercial')
    expect(r.data.sceneName).toBe('商用')
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
      // 落库形状含双方 openid(submitReview 写入):响应必须剔除
      reviews: [{ _id: 'o-accepted', orderId: 'o-accepted', userOpenid: 'user-1', masterOpenid: 'master-1', stars: 5, content: '很给力' }]
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

describe('masterStats 头像临时链接(信任卡 v4.1)', () => {
  afterEach(() => { delete global.__mockTempFileURL })

  function callWithMaster(master) {
    jest.resetModules()
    global.__mockDb = fakeDb({
      orders: [JSON.parse(JSON.stringify(ORDER_ACCEPTED))],
      masters: [master],
      reviews: []
    })
    global.__mockCtx = { OPENID: 'user-1' }
    const { main } = require('../cloudfunctions/getOrders/index')
    return main({ action: 'detail', orderId: 'o-accepted' }).then(r => {
      delete global.__mockDb
      delete global.__mockCtx
      return r
    })
  }

  test('有头像:经匿名副本换临时链随口碑下发,URL 不含师傅 openid', async () => {
    const m = JSON.parse(JSON.stringify(MASTERS[0]))
    m.avatarPhoto = 'cloud://x/avatars/master-1/a.jpg'
    const r = await callWithMaster(m)
    expect(r.masterStats.avatar).toMatch(/^https:\/\/tmp\//)
    expect(r.masterStats.avatar).not.toContain('master-1')
    expect(r.masterStats.done).toBe(8)
  })

  test('无头像:不带 avatar 字段(前端姓氏首字兜底)', async () => {
    const r = await callWithMaster(JSON.parse(JSON.stringify(MASTERS[0])))
    expect(r.masterStats).not.toHaveProperty('avatar')
  })

  test('头像换链抛错:不阻塞详情,口碑照常下发', async () => {
    const m = JSON.parse(JSON.stringify(MASTERS[0]))
    m.avatarPhoto = 'cloud://x/avatars/master-1/a.jpg'
    global.__mockTempFileURL = () => { throw new Error('storage timeout') }
    const r = await callWithMaster(m)
    expect(r.ok).toBe(true)
    expect(r.masterStats.done).toBe(8)
    expect(r.masterStats).not.toHaveProperty('avatar')
  })
})

describe('双方视角不下发 openid', () => {
  // 双方互不需要对方 openid(前端零引用已核);手机号/门牌等联系字段照常
  async function callGet(openid, event) {
    jest.resetModules()
    global.__mockDb = fakeDb({
      orders: [JSON.parse(JSON.stringify(ORDER_ACCEPTED)), JSON.parse(JSON.stringify(ORDER_PUBLISHED))],
      masters: JSON.parse(JSON.stringify(MASTERS)),
      reviews: []
    })
    global.__mockCtx = { OPENID: openid }
    const { main } = require('../cloudfunctions/getOrders/index')
    const res = await main(event)
    delete global.__mockDb
    delete global.__mockCtx
    return res
  }

  test('userList:联系字段完整,但两侧 openid 都不下发', async () => {
    const r = await callGet('user-1', { action: 'userList' })
    expect(r.ok).toBe(true)
    expect(r.data.length).toBeGreaterThan(0)
    r.data.forEach(o => {
      expect(o.userOpenid).toBeUndefined()
      expect(o.masterOpenid).toBeUndefined()
      expect(o.userPhone).toBe('13800138000')
      expect(o.addressDetail).toBeTruthy()
    })
  })

  test('masterList:同口径,用户电话照常(接单后可见)', async () => {
    const r = await callGet('master-1', { action: 'masterList' })
    expect(r.ok).toBe(true)
    r.data.forEach(o => {
      expect(o.userOpenid).toBeUndefined()
      expect(o.masterOpenid).toBeUndefined()
      expect(o.userPhone).toBe('13800138000')
    })
  })

  test('detail 双方分支:owner/master 都拿不到双方 openid,业务字段不受影响', async () => {
    const r1 = await callGet('user-1', { action: 'detail', orderId: 'o-accepted' })
    expect(r1.role).toBe('user')
    expect(r1.data.userOpenid).toBeUndefined()
    expect(r1.data.masterOpenid).toBeUndefined()
    expect(r1.data.masterName).toBe('李师傅')     // 对方展示信息照常

    const r2 = await callGet('master-1', { action: 'detail', orderId: 'o-accepted' })
    expect(r2.role).toBe('master')
    expect(r2.data.userOpenid).toBeUndefined()
    expect(r2.data.masterOpenid).toBeUndefined()
    expect(r2.data.userPhone).toBe('13800138000') // 师傅接单后可见用户电话
  })
})
