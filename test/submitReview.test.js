// submitReview 评价幂等与失败分流:
// _id 冲突 = 已评价(自愈补标记);普通写失败 = 可重试,绝不错误推进 reviewed
const { fakeDb } = require('./stubs/fakeDb')

function order(over = {}) {
  return Object.assign({
    _id: 'o1', orderNo: 'AC1', categoryName: '空调维修', status: 'completed',
    userOpenid: 'user-1', masterOpenid: 'master-1', reviewed: false
  }, over)
}
const master = () => ({ _id: 'M1', openid: 'master-1', stats: { done: 1, reviewCount: 2, totalStars: 8 } })

async function review(event, fx, openid = 'user-1', { msgSecCheck } = {}) {
  jest.resetModules()
  global.__mockDb = fakeDb(fx)
  global.__mockCtx = { OPENID: openid }
  const cloudStub = require('wx-server-sdk')
  cloudStub.openapi = { security: { msgSecCheck: msgSecCheck || (async () => ({})) } }
  try {
    const { main } = require('../cloudfunctions/submitReview/index')
    return await main(event)
  } finally {
    // main 抛错也要还原全局,不污染后续用例
    delete cloudStub.openapi
    delete global.__mockDb
    delete global.__mockCtx
  }
}

describe('正常路径', () => {
  test('写入评价、翻 reviewed、师傅口碑累计', async () => {
    const fx = { orders: [order()], masters: [master()], reviews: [] }
    const r = await review({ orderId: 'o1', stars: 5, content: '师傅很专业' }, fx)
    expect(r.ok).toBe(true)
    expect(fx.reviews[0]).toMatchObject({ _id: 'o1', stars: 5, masterOpenid: 'master-1' })
    expect(fx.orders[0].reviewed).toBe(true)
    expect(fx.masters[0].stats.reviewCount).toBe(3)
    expect(fx.masters[0].stats.totalStars).toBe(13)
  })
})

describe('权限与状态闸门', () => {
  test.each([
    ['非本人评价', { openid: 'someone' }, {}],
    ['订单未完成', {}, { status: 'accepted' }],
    ['订单已标记评价', {}, { reviewed: true }]
  ])('%s -> 拒绝', async (_l, opts, over) => {
    const fx = { orders: [order(over)], masters: [master()], reviews: [] }
    const r = await review({ orderId: 'o1', stars: 5 }, fx, opts.openid || 'user-1')
    expect(r.ok).toBe(false)
    expect(fx.reviews).toHaveLength(0)
  })

  test.each([[0], [6], ['abc']])('星级 %s 非法 -> 拒绝', async (stars) => {
    const fx = { orders: [order()], masters: [master()], reviews: [] }
    const r = await review({ orderId: 'o1', stars }, fx)
    expect(r.ok).toBe(false)
  })
})

describe('content 类型与长度校验', () => {
  test.each([[null], [123], [['数组']], [{ text: '对象' }]])(
    'content 为 %p:返回参数错误,不送检、不写库、不动统计', async (content) => {
      const msgSecCheck = jest.fn(async () => ({}))
      const fx = { orders: [order()], masters: [master()], reviews: [] }
      const r = await review({ orderId: 'o1', stars: 5, content }, fx, 'user-1', { msgSecCheck })
      expect(r.ok).toBe(false)
      expect(r.msg).toContain('参数错误')
      expect(msgSecCheck).not.toHaveBeenCalled()
      expect(fx.reviews).toHaveLength(0)
      expect(fx.orders[0].reviewed).toBe(false)
      expect(fx.masters[0].stats.reviewCount).toBe(2)
    })

  test('缺省与空字符串仍允许提交', async () => {
    const fx1 = { orders: [order()], masters: [master()], reviews: [] }
    expect((await review({ orderId: 'o1', stars: 5 }, fx1)).ok).toBe(true)
    const fx2 = { orders: [order()], masters: [master()], reviews: [] }
    expect((await review({ orderId: 'o1', stars: 5, content: '' }, fx2)).ok).toBe(true)
  })

  test('长度边界:300 字通过,301 字拒绝', async () => {
    const fx1 = { orders: [order()], masters: [master()], reviews: [] }
    expect((await review({ orderId: 'o1', stars: 5, content: '好'.repeat(300) }, fx1)).ok).toBe(true)
    const fx2 = { orders: [order()], masters: [master()], reviews: [] }
    const r = await review({ orderId: 'o1', stars: 5, content: '好'.repeat(301) }, fx2)
    expect(r.ok).toBe(false)
    expect(fx2.reviews).toHaveLength(0)
  })
})

describe('幂等冲突 vs 普通写失败', () => {
  test('评价文档已存在(_id 冲突):自愈补翻 reviewed,拒绝重复', async () => {
    const fx = {
      orders: [order()], masters: [master()],
      reviews: [{ _id: 'o1', orderId: 'o1', stars: 4 }] // 上次写入成功但 reviewed 没翻
    }
    const r = await review({ orderId: 'o1', stars: 5 }, fx)
    expect(r.ok).toBe(false)
    expect(r.msg).toContain('已评价过')
    expect(fx.orders[0].reviewed).toBe(true)  // 自愈
    expect(fx.reviews).toHaveLength(1)
    expect(fx.reviews[0].stars).toBe(4)       // 原评价不被覆盖
  })

  test('普通写失败(超时/抖动):返回可重试,reviewed 不被错误推进', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const fx = { orders: [order()], masters: [master()], reviews: [] }
    global.__failNextAdd = true
    const r = await review({ orderId: 'o1', stars: 5 }, fx)
    delete global.__failNextAdd
    errSpy.mockRestore()
    expect(r.ok).toBe(false)
    expect(r.msg).toContain('重试')
    expect(fx.orders[0].reviewed).toBe(false) // 关键:没有错误推进
    expect(fx.masters[0].stats.reviewCount).toBe(2) // 口碑也没动
    // 用户重试可成功
    const r2 = await review({ orderId: 'o1', stars: 5, content: '重试成功' }, fx)
    expect(r2.ok).toBe(true)
    expect(fx.orders[0].reviewed).toBe(true)
  })
})

describe('评价统计记账:失败不永久漏计', () => {
  afterEach(() => { delete global.__failUpdate })

  test('成功路径:statsApplied 翻 true,口碑累计', async () => {
    const fx = { orders: [order()], masters: [master()], reviews: [] }
    const r = await review({ orderId: 'o1', stars: 5, content: '很专业' }, fx)
    expect(r.ok).toBe(true)
    expect(fx.reviews[0].statsApplied).toBe(true)
    expect(fx.masters[0].stats.reviewCount).toBe(3)   // master() 起始 reviewCount 2
    expect(fx.masters[0].stats.totalStars).toBe(13)   // 起始 8 + 5
  })

  test('口碑累计失败:回滚 statsApplied 留给 cron 补账,提交仍成功', async () => {
    const fx = { orders: [order()], masters: [master()], reviews: [] }
    global.__failUpdate = (col) => col === 'masters'
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    let r
    try {
      r = await review({ orderId: 'o1', stars: 5 }, fx)
    } finally {
      errSpy.mockRestore()
    }
    expect(r.ok).toBe(true)
    expect(fx.reviews[0].statsApplied).toBe(false)   // cron 2c 按 false 补记
    expect(fx.masters[0].stats.reviewCount).toBe(2)
  })
})
