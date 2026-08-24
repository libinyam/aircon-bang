// complain 投诉:归属校验、单订单去重、24h 限频、内容安全集成
const { fakeDb } = require('./stubs/fakeDb')

async function complain(fx, event, openid = 'u1', { msgSecCheck } = {}) {
  jest.resetModules()
  global.__mockDb = fakeDb(fx)
  global.__mockCtx = { OPENID: openid }
  // 给桩补 openapi:默认放行——没有它正常用例会隐式走 fail-open 假绿
  const cloudStub = require('wx-server-sdk')
  cloudStub.openapi = { security: { msgSecCheck: msgSecCheck || (async () => ({})) } }
  try {
    const { main } = require('../cloudfunctions/complain/index')
    return await main(event)
  } finally {
    // main 抛错也要还原全局,不污染后续用例
    delete cloudStub.openapi
    delete global.__mockDb
    delete global.__mockCtx
  }
}

const err87014 = () => Object.assign(new Error('risky content'), { errCode: 87014 })

const BASE = () => ({
  orders: [{ _id: 'o1', orderNo: 'N1', status: 'accepted', userOpenid: 'u1', masterOpenid: 'm1' }],
  complaints: []
})

describe('complain', () => {
  test('订单双方可投诉,写入 open 记录', async () => {
    const fx = BASE()
    const r = await complain(fx, { orderId: 'o1', content: '师傅迟到两小时未沟通' })
    expect(r.ok).toBe(true)
    expect(fx.complaints).toHaveLength(1)
    expect(fx.complaints[0]).toMatchObject({ orderId: 'o1', status: 'open', fromRole: 'user' })
    // 冻结标记先于投诉记录落库:cron 自动确认的原子条件靠它拦并发
    expect(fx.orders[0].disputeHold).toBe(true)
  })

  test('被拒绝的投诉(围观者/重复/限频)不打冻结标记', async () => {
    const fx = BASE()
    fx.complaints = [{ _id: 'c1', orderId: 'o1', status: 'open', fromOpenid: 'u1' }]
    const r = await complain(fx, { orderId: 'o1', content: '再投诉一次刷屏' })
    expect(r.ok).toBe(false)
    expect(fx.orders[0].disputeHold).toBeUndefined()
  })

  test('围观者无权投诉', async () => {
    const r = await complain(BASE(), { orderId: 'o1', content: '这单有问题啊啊' }, 'stranger')
    expect(r.ok).toBe(false)
  })

  test('同单已有 open 投诉:拒绝重复提交', async () => {
    const fx = BASE()
    fx.complaints = [{ _id: 'c1', orderId: 'o1', status: 'open', fromOpenid: 'u1' }]
    const r = await complain(fx, { orderId: 'o1', content: '再投诉一次刷屏' })
    expect(r.ok).toBe(false)
    expect(r.msg).toContain('已有待处理投诉')
    expect(fx.complaints).toHaveLength(1)
  })

  test('对方也不能对同单再开新投诉:去重是订单维度', async () => {
    const fx = BASE()
    fx.complaints = [{ _id: 'c1', orderId: 'o1', status: 'open', fromOpenid: 'u1' }]
    const r = await complain(fx, { orderId: 'o1', content: '用户恶意差评投诉' }, 'm1')
    expect(r.ok).toBe(false)
  })

  test('投诉已关闭:允许重新发起(纠纷复发)', async () => {
    const fx = BASE()
    fx.complaints = [{ _id: 'c1', orderId: 'o1', status: 'closed', fromOpenid: 'u1' }]
    const r = await complain(fx, { orderId: 'o1', content: '上次处理后问题复发' })
    expect(r.ok).toBe(true)
    expect(fx.complaints).toHaveLength(2)
  })

  test('24h 内第4条投诉被限频(跨订单的全局限制仍在)', async () => {
    const fx = {
      orders: [
        { _id: 'o4', orderNo: 'N4', status: 'accepted', userOpenid: 'u1', masterOpenid: 'm1' }
      ],
      complaints: [1, 2, 3].map(i => ({
        _id: 'c' + i, orderId: 'o' + i, status: 'open', fromOpenid: 'u1', createdAt: new Date()
      }))
    }
    const r = await complain(fx, { orderId: 'o4', content: '第四条应被限频拦下' })
    expect(r.ok).toBe(false)
    expect(r.msg).toContain('上限')
  })

  test('内容太短拒绝', async () => {
    const r = await complain(BASE(), { orderId: 'o1', content: '差评' })
    expect(r.ok).toBe(false)
  })

  test.each([
    ['null', null],
    ['数字', 12345],
    ['对象', { text: '师傅迟到两小时未沟通' }]
  ])('content 非字符串(%s):参数错误而非 500', async (_label, content) => {
    const r = await complain(BASE(), { orderId: 'o1', content })
    expect(r.ok).toBe(false)
    expect(r.msg).toContain('参数错误')
  })

  describe('内容安全集成', () => {
    test('订单投诉命中 87014:拒绝,不写投诉、不打 disputeHold', async () => {
      const fx = BASE()
      const r = await complain(fx, { orderId: 'o1', content: '这段内容命中违规词' }, 'u1', {
        msgSecCheck: async () => { throw err87014() }
      })
      expect(r.ok).toBe(false)
      expect(r.msg).toContain('违规')
      expect(fx.complaints).toHaveLength(0)
      expect(fx.orders[0].disputeHold).toBeUndefined()
    })

    test('商品举报命中 87014:拒绝,不写投诉', async () => {
      const fx = {
        listings: [{ _id: 'l1', listingNo: 'GD1', title: '格力挂机', sellerOpenid: 'm1' }],
        orders: [], complaints: []
      }
      const r = await complain(fx, { listingId: 'l1', content: '这段内容命中违规词' }, 'buyer1', {
        msgSecCheck: async () => { throw err87014() }
      })
      expect(r.ok).toBe(false)
      expect(r.msg).toContain('违规')
      expect(fx.complaints).toHaveLength(0)
    })

    test('非 87014 异常:显式 fail-open 放行并记录日志(正常用例不得隐式走这条)', async () => {
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const fx = BASE()
        const r = await complain(fx, { orderId: 'o1', content: '接口抖动时的正常投诉' }, 'u1', {
          msgSecCheck: async () => { throw new Error('network down') }
        })
        expect(r.ok).toBe(true)
        expect(fx.complaints).toHaveLength(1)
        expect(errSpy).toHaveBeenCalledWith('msgSecCheck error', expect.any(Error))
      } finally {
        errSpy.mockRestore()
      }
    })
  })
})

describe('商品举报(买空调频道,targetType=listing)', () => {
  const LBASE = () => ({
    listings: [{ _id: 'l1', listingNo: 'GD1', title: '格力挂机', sellerOpenid: 'm1' }],
    orders: [],
    complaints: []
  })

  test('浏览者可举报,记录带 targetType/listingNo/标题快照,不动订单冻结', async () => {
    const fx = LBASE()
    const r = await complain(fx, { listingId: 'l1', content: '照片与实物严重不符' }, 'buyer1')
    expect(r.ok).toBe(true)
    expect(fx.complaints[0]).toMatchObject({
      targetType: 'listing', listingId: 'l1', listingNo: 'GD1', listingTitle: '格力挂机',
      fromOpenid: 'buyer1', fromRole: 'viewer', status: 'open'
    })
    expect(fx.complaints[0]).not.toHaveProperty('orderId')
  })

  test('卖家不能举报自己的商品;商品不存在拒绝', async () => {
    expect((await complain(LBASE(), { listingId: 'l1', content: '自己举报自己刷屏' }, 'm1')).ok).toBe(false)
    expect((await complain(LBASE(), { listingId: 'ghost', content: '举报不存在的商品' }, 'buyer1')).ok).toBe(false)
  })

  test('同人同商品去重:open 期间不可重复举报,他人仍可举报', async () => {
    const fx = LBASE()
    fx.complaints = [{ _id: 'c1', listingId: 'l1', status: 'open', fromOpenid: 'buyer1' }]
    expect((await complain(fx, { listingId: 'l1', content: '再举报一次刷屏' }, 'buyer1')).ok).toBe(false)
    expect((await complain(fx, { listingId: 'l1', content: '我也发现货不对板' }, 'buyer2')).ok).toBe(true)
    expect(fx.complaints).toHaveLength(2)
  })

  test('24h 限频与订单投诉共享额度', async () => {
    const fx = LBASE()
    fx.complaints = [1, 2, 3].map(i => ({
      _id: 'c' + i, orderId: 'o' + i, status: 'open', fromOpenid: 'buyer1', createdAt: new Date()
    }))
    const r = await complain(fx, { listingId: 'l1', content: '第四条应被限频拦下' }, 'buyer1')
    expect(r.ok).toBe(false)
    expect(r.msg).toContain('上限')
  })

  test('订单投诉记录补 targetType=order(管理端按类型分渲染)', async () => {
    const fx = BASE()
    await complain(fx, { orderId: 'o1', content: '师傅迟到两小时未沟通' })
    expect(fx.complaints[0].targetType).toBe('order')
  })
})

describe('订单投诉并发收口', () => {
  test('预查通过但 disputeHold 已被并发者抢占:拒绝,不写投诉', async () => {
    // 场景:并发请求刚抢到标记、投诉还没落库——count 预查是 0,只有抢占闸能拦住
    const fx = BASE()
    fx.orders[0].disputeHold = true
    const r = await complain(fx, { orderId: 'o1', content: '并发重复的投诉内容' }, 'm1')
    expect(r.ok).toBe(false)
    expect(r.msg).toContain('已有待处理投诉')
    expect(fx.complaints).toHaveLength(0)
  })

  test('建投诉落库失败:回滚 disputeHold 保持可重试,返回失败', async () => {
    const fx = BASE()
    global.__failNextAdd = true
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const r = await complain(fx, { orderId: 'o1', content: '正常投诉但数据库抖动' })
      expect(r.ok).toBe(false)
      expect(r.msg).toContain('稍后重试')
      expect(fx.orders[0].disputeHold).toBe(false)
      expect(fx.complaints).toHaveLength(0)
    } finally {
      errSpy.mockRestore()
      delete global.__failNextAdd
    }
  })
})
