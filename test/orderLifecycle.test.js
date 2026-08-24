// 订单生命周期行为测试:finish(含撤销)/ confirm(含驳回通知)/ cancel
const { fakeDb } = require('./stubs/fakeDb')

function order(over = {}) {
  return Object.assign({
    _id: 'o1', orderNo: 'AC1', status: 'accepted', categoryName: '空调维修',
    userOpenid: 'user-1', masterOpenid: 'master-1', reviewed: false,
    publishedAt: new Date()
  }, over)
}

async function call(fnDir, event, openid, fx, { sends, msgSecCheck } = {}) {
  jest.resetModules()
  global.__mockDb = fakeDb(fx)
  global.__mockCtx = { OPENID: openid }
  const cloudStub = require('wx-server-sdk')
  cloudStub.openapi = {
    // 取消/驳回原因会过文本安全:默认放行,用例可注入 87014
    security: { msgSecCheck: msgSecCheck || (async () => ({})) },
    subscribeMessage: { send: async (msg) => { if (sends) sends.push(msg); return {} } }
  }
  try {
    const { main } = require(`../cloudfunctions/${fnDir}/index`)
    return await main(event)
  } finally {
    delete cloudStub.openapi
    delete global.__mockDb
    delete global.__mockCtx
  }
}

const err87014 = () => Object.assign(new Error('risky content'), { errCode: 87014 })

describe('finishOrder:标记完成', () => {
  test('接单师傅:accepted -> pending_confirm,记录 finishedAt', async () => {
    const fx = { orders: [order()], config: [{ _id: 'app' }] }
    const r = await call('finishOrder', { orderId: 'o1' }, 'master-1', fx)
    expect(r.ok).toBe(true)
    expect(fx.orders[0].status).toBe('pending_confirm')
    expect(fx.orders[0].finishedAt).toBeInstanceOf(Date)
  })

  test.each([
    ['别的师傅', 'master-2', {}],
    ['用户本人', 'user-1', {}],
    ['状态不是 accepted', 'master-1', { status: 'published' }]
  ])('%s 点完成:命中 0 行拒绝', async (_label, openid, over) => {
    const fx = { orders: [order(over)], config: [{ _id: 'app' }] }
    const r = await call('finishOrder', { orderId: 'o1' }, openid, fx)
    expect(r.ok).toBe(false)
    expect(fx.orders[0].status).toBe(over.status || 'accepted')
  })

  test('配置了 tplOrderFinish:完成后给用户推确认提醒', async () => {
    const sends = []
    const fx = { orders: [order()], config: [{ _id: 'app', tplOrderFinish: 'TPL-F' }] }
    const r = await call('finishOrder', { orderId: 'o1' }, 'master-1', fx, { sends })
    expect(r.ok).toBe(true)
    expect(sends).toHaveLength(1)
    expect(sends[0].touser).toBe('user-1')
    expect(sends[0].templateId).toBe('TPL-F')
    expect(sends[0].data).toEqual({
      character_string5: { value: 'AC1' },
      thing6: { value: '空调维修已完成' },
      thing16: { value: '请验收并确认,72小时未确认将自动完成' }
    })
  })

  test('推送失败不影响完成动作', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const fx = { orders: [order()], config: [{ _id: 'app', tplOrderFinish: 'TPL-F' }] }
    jest.resetModules()
    global.__mockDb = fakeDb(fx)
    global.__mockCtx = { OPENID: 'master-1' }
    const cloudStub = require('wx-server-sdk')
    cloudStub.openapi = { subscribeMessage: { send: async () => { throw new Error('43101 用户未订阅') } } }
    const r = await require('../cloudfunctions/finishOrder/index').main({ orderId: 'o1' })
    delete cloudStub.openapi
    delete global.__mockDb
    delete global.__mockCtx
    errSpy.mockRestore()
    expect(r.ok).toBe(true)
    expect(fx.orders[0].status).toBe('pending_confirm')
  })
})

describe('finishOrder:撤销完成', () => {
  test('师傅误点后撤销:pending_confirm -> accepted,不计驳回', async () => {
    const fx = { orders: [order({ status: 'pending_confirm' })], config: [{ _id: 'app' }] }
    const r = await call('finishOrder', { orderId: 'o1', undo: true }, 'master-1', fx)
    expect(r.ok).toBe(true)
    expect(fx.orders[0].status).toBe('accepted')
    expect(fx.orders[0].undoneAt).toBeInstanceOf(Date)
    expect(fx.orders[0].rejectCount).toBeUndefined()
  })

  test('非待确认状态/非接单师傅:撤销被拒', async () => {
    const fx = { orders: [order({ status: 'pending_confirm' })], config: [{ _id: 'app' }] }
    const r1 = await call('finishOrder', { orderId: 'o1', undo: true }, 'master-2', fx)
    expect(r1.ok).toBe(false)
    const fx2 = { orders: [order()], config: [{ _id: 'app' }] }
    const r2 = await call('finishOrder', { orderId: 'o1', undo: true }, 'master-1', fx2)
    expect(r2.ok).toBe(false)
  })
})

describe('confirmOrder:确认与驳回', () => {
  const master = () => ({ _id: 'M1', openid: 'master-1', stats: { done: 3 } })

  test('用户确认:pending_confirm -> completed,师傅完成数 +1', async () => {
    const fx = { orders: [order({ status: 'pending_confirm' })], masters: [master()], config: [{ _id: 'app' }] }
    const r = await call('confirmOrder', { orderId: 'o1' }, 'user-1', fx)
    expect(r.ok).toBe(true)
    expect(fx.orders[0].status).toBe('completed')
    expect(fx.masters[0].stats.done).toBe(4)
    expect(fx.orders[0].statsCredited).toBe(true)
  })

  describe('确认完成统计记账:失败不永久漏计', () => {
    afterEach(() => { delete global.__failUpdate })

    test('统计累计失败:回滚认领标记,确认仍成功,cron 可按 statsCredited:false 补账', async () => {
      const fx = { orders: [order({ status: 'pending_confirm' })], masters: [master()], config: [{ _id: 'app' }] }
      global.__failUpdate = (col) => col === 'masters'
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
      let r
      try {
        r = await call('confirmOrder', { orderId: 'o1' }, 'user-1', fx)
      } finally {
        errSpy.mockRestore()
      }
      expect(r.ok).toBe(true)
      expect(fx.orders[0].status).toBe('completed')
      expect(fx.orders[0].statsCredited).toBe(false)   // 回滚,下一轮 cron 补账
      expect(fx.masters[0].stats.done).toBe(3)
    })
  })

  test('非发单人确认:命中 0 行拒绝', async () => {
    const fx = { orders: [order({ status: 'pending_confirm' })], masters: [master()], config: [{ _id: 'app' }] }
    const r = await call('confirmOrder', { orderId: 'o1' }, 'user-2', fx)
    expect(r.ok).toBe(false)
    expect(fx.orders[0].status).toBe('pending_confirm')
  })

  test('用户驳回:退回 accepted,rejectCount 累计,原因留痕', async () => {
    const fx = { orders: [order({ status: 'pending_confirm' })], masters: [master()], config: [{ _id: 'app' }] }
    const r = await call('confirmOrder', { orderId: 'o1', reject: true, reason: ' 外机还在响 ' }, 'user-1', fx)
    expect(r.ok).toBe(true)
    expect(fx.orders[0].status).toBe('accepted')
    expect(fx.orders[0].rejectCount).toBe(1)
    expect(fx.orders[0].lastRejectReason).toBe('外机还在响')
    expect(fx.masters[0].stats.done).toBe(3) // 驳回不加完成数
  })

  test('配置了 tplOrderRejected:驳回后给师傅推通知', async () => {
    const sends = []
    const fx = {
      orders: [order({ status: 'pending_confirm' })],
      masters: [master()],
      config: [{ _id: 'app', tplOrderRejected: 'TPL-R' }]
    }
    const r = await call('confirmOrder', { orderId: 'o1', reject: true, reason: '没修好' }, 'user-1', fx, { sends })
    expect(r.ok).toBe(true)
    expect(sends).toHaveLength(1)
    expect(sends[0].touser).toBe('master-1')
    expect(sends[0].templateId).toBe('TPL-R')
    expect(sends[0].data).toEqual({
      character_string6: { value: 'AC1' },
      thing10: { value: '用户反馈服务未完成,请联系客户处理' },
      thing5: { value: '没修好' }
    })
  })

  describe('驳回原因校验:不推进状态', () => {
    const pc = () => ({ orders: [order({ status: 'pending_confirm' })], masters: [master()], config: [{ _id: 'app' }] })

    test.each([[null], [123], [{ text: '对象' }]])('非字符串原因 %p -> 参数错误', async (reason) => {
      const fx = pc()
      const r = await call('confirmOrder', { orderId: 'o1', reject: true, reason }, 'user-1', fx)
      expect(r.ok).toBe(false)
      expect(r.msg).toContain('参数错误')
      expect(fx.orders[0].status).toBe('pending_confirm')
      expect(fx.orders[0].rejectCount).toBeUndefined()
    })

    test('超长原因(101字) -> 拒绝;100 字仍可通过', async () => {
      const fx = pc()
      const r = await call('confirmOrder', { orderId: 'o1', reject: true, reason: '长'.repeat(101) }, 'user-1', fx)
      expect(r.ok).toBe(false)
      expect(fx.orders[0].status).toBe('pending_confirm')

      const fx2 = pc()
      const ok = await call('confirmOrder', { orderId: 'o1', reject: true, reason: '长'.repeat(100) }, 'user-1', fx2)
      expect(ok.ok).toBe(true)
      expect(fx2.orders[0].status).toBe('accepted')
    })

    test('命中 87014:拒绝,订单仍在 pending_confirm,rejectCount 不变', async () => {
      const fx = pc()
      const r = await call('confirmOrder', { orderId: 'o1', reject: true, reason: '违规内容' }, 'user-1', fx, {
        msgSecCheck: async () => { throw err87014() }
      })
      expect(r.ok).toBe(false)
      expect(r.msg).toContain('违规')
      expect(fx.orders[0].status).toBe('pending_confirm')
      expect(fx.orders[0].rejectCount).toBeUndefined()
    })
  })
})

describe('cancelOrder:取消权限与计数', () => {
  test('published:发单人可直接取消', async () => {
    const fx = { orders: [order({ status: 'published', masterOpenid: '' })], masters: [] }
    const r = await call('cancelOrder', { orderId: 'o1' }, 'user-1', fx)
    expect(r.ok).toBe(true)
    expect(fx.orders[0].status).toBe('cancelled')
    expect(fx.orders[0].cancelBy).toBe('user')
  })

  test('published:围观者无权取消', async () => {
    const fx = { orders: [order({ status: 'published', masterOpenid: '' })], masters: [] }
    const r = await call('cancelOrder', { orderId: 'o1' }, 'someone', fx)
    expect(r.ok).toBe(false)
    expect(fx.orders[0].status).toBe('published')
  })

  test('accepted:必须填原因', async () => {
    const fx = { orders: [order()], masters: [] }
    const r = await call('cancelOrder', { orderId: 'o1', reason: '  ' }, 'user-1', fx)
    expect(r.ok).toBe(false)
    expect(r.msg).toContain('原因')
  })

  test('accepted:师傅取消计入 stats.cancelled(异常行为可追溯)', async () => {
    const fx = {
      orders: [order()],
      masters: [{ _id: 'M1', openid: 'master-1', stats: { done: 0, cancelled: 0 } }]
    }
    const r = await call('cancelOrder', { orderId: 'o1', reason: '客户改期了' }, 'master-1', fx)
    expect(r.ok).toBe(true)
    expect(fx.orders[0].cancelBy).toBe('master')
    expect(fx.masters[0].stats.cancelled).toBe(1)
  })

  test('completed:不能取消;已取消的再取消也被拒', async () => {
    const fx = { orders: [order({ status: 'completed' })], masters: [] }
    const r = await call('cancelOrder', { orderId: 'o1', reason: 'x' }, 'user-1', fx)
    expect(r.ok).toBe(false)
    expect(r.msg).toContain('不能取消')

    const fx2 = { orders: [order({ status: 'published', masterOpenid: '' })], masters: [] }
    await call('cancelOrder', { orderId: 'o1' }, 'user-1', fx2)
    const again = await call('cancelOrder', { orderId: 'o1' }, 'user-1', fx2)
    expect(again.ok).toBe(false)
  })

  describe('取消原因校验:不推进状态', () => {
    test.each([[null], [123], [{ text: '对象' }]])('accepted + 非字符串原因 %p -> 参数错误', async (reason) => {
      const fx = { orders: [order()], masters: [] }
      const r = await call('cancelOrder', { orderId: 'o1', reason }, 'user-1', fx)
      expect(r.ok).toBe(false)
      expect(r.msg).toContain('参数错误')
      expect(fx.orders[0].status).toBe('accepted')
    })

    test('accepted + 超长原因(101字) -> 拒绝', async () => {
      const fx = { orders: [order()], masters: [] }
      const r = await call('cancelOrder', { orderId: 'o1', reason: '长'.repeat(101) }, 'user-1', fx)
      expect(r.ok).toBe(false)
      expect(fx.orders[0].status).toBe('accepted')
    })

    test('命中 87014:拒绝,订单保持 accepted', async () => {
      const fx = { orders: [order()], masters: [] }
      const r = await call('cancelOrder', { orderId: 'o1', reason: '违规内容' }, 'user-1', fx, {
        msgSecCheck: async () => { throw err87014() }
      })
      expect(r.ok).toBe(false)
      expect(r.msg).toContain('违规')
      expect(fx.orders[0].status).toBe('accepted')
      expect(fx.orders[0].cancelReason).toBeUndefined()
    })

    test('published 空原因仍允许直接取消(不送检)', async () => {
      const msgSecCheck = jest.fn(async () => ({}))
      const fx = { orders: [order({ status: 'published', masterOpenid: '' })], masters: [] }
      const r = await call('cancelOrder', { orderId: 'o1' }, 'user-1', fx, { msgSecCheck })
      expect(r.ok).toBe(true)
      expect(msgSecCheck).not.toHaveBeenCalled()
    })
  })
})
