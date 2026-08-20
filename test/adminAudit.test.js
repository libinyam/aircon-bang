// admin 审计留痕与并发防覆盖:auditMaster/handleComplaint/handleDeletionRequest
const { fakeDb } = require('./stubs/fakeDb')

async function callAdmin(fx, event, openid = 'admin-1') {
  jest.resetModules()
  global.__mockDb = fakeDb(fx)
  global.__mockCtx = { OPENID: openid }
  const { main } = require('../cloudfunctions/admin/index')
  const res = await main(event)
  delete global.__mockDb
  delete global.__mockCtx
  return res
}

const BASE = () => ({
  config: [{ _id: 'app', adminOpenids: ['admin-1', 'admin-2'] }],
  masters: [],
  complaints: [],
  deletion_requests: []
})

describe('auditMaster 审计字段', () => {
  test('通过审核:写 operator 与 auditedAt', async () => {
    const fx = BASE()
    fx.masters = [{ _id: 'm1', status: 'pending' }]
    const r = await callAdmin(fx, { action: 'auditMaster', masterId: 'm1', pass: true })
    expect(r.ok).toBe(true)
    expect(fx.masters[0].status).toBe('approved')
    expect(fx.masters[0].operator).toBe('admin-1')
    expect(fx.masters[0].auditedAt).toBeTruthy()
  })

  test('驳回:同样留痕,且驳回理由写入', async () => {
    const fx = BASE()
    fx.masters = [{ _id: 'm1', status: 'pending' }]
    const r = await callAdmin(fx, { action: 'auditMaster', masterId: 'm1', pass: false, reason: '照片模糊' }, 'admin-2')
    expect(r.ok).toBe(true)
    expect(fx.masters[0].status).toBe('rejected')
    expect(fx.masters[0].rejectReason).toBe('照片模糊')
    expect(fx.masters[0].operator).toBe('admin-2')
  })
})

describe('handleComplaint 条件原子更新', () => {
  test('关闭投诉:写 operator,状态翻转', async () => {
    const fx = BASE()
    fx.complaints = [{ _id: 'c1', status: 'open' }]
    const r = await callAdmin(fx, { action: 'handleComplaint', complaintId: 'c1', note: '已电话调解' })
    expect(r.ok).toBe(true)
    expect(fx.complaints[0].status).toBe('closed')
    expect(fx.complaints[0].handleNote).toBe('已电话调解')
    expect(fx.complaints[0].operator).toBe('admin-1')
  })

  test('已关闭的投诉二次处理:返回失败,不覆盖首次处理记录', async () => {
    const fx = BASE()
    fx.complaints = [{ _id: 'c1', status: 'open' }]
    await callAdmin(fx, { action: 'handleComplaint', complaintId: 'c1', note: '首次处理' })
    const r2 = await callAdmin(fx, { action: 'handleComplaint', complaintId: 'c1', note: '并发覆盖' }, 'admin-2')
    expect(r2.ok).toBe(false)
    expect(fx.complaints[0].handleNote).toBe('首次处理')
    expect(fx.complaints[0].operator).toBe('admin-1')
  })

  test('处理记录必填', async () => {
    const fx = BASE()
    fx.complaints = [{ _id: 'c1', status: 'open' }]
    const r = await callAdmin(fx, { action: 'handleComplaint', complaintId: 'c1', note: '  ' })
    expect(r.ok).toBe(false)
    expect(fx.complaints[0].status).toBe('open')
  })

  test('关闭订单最后一条 open 投诉:解除订单的自动确认冻结', async () => {
    const fx = BASE()
    fx.complaints = [{ _id: 'c1', orderId: 'o1', status: 'open' }]
    fx.orders = [{ _id: 'o1', status: 'pending_confirm', disputeHold: true }]
    const r = await callAdmin(fx, { action: 'handleComplaint', complaintId: 'c1', note: '已电话调解' })
    expect(r.ok).toBe(true)
    expect(fx.orders[0].disputeHold).toBe(false)
  })

  test('同单还有其他 open 投诉:关一条不解除冻结', async () => {
    const fx = BASE()
    fx.complaints = [
      { _id: 'c1', orderId: 'o1', status: 'open' },
      { _id: 'c2', orderId: 'o1', status: 'open' }   // 理论上去重拦着,防御历史/并发数据
    ]
    fx.orders = [{ _id: 'o1', status: 'pending_confirm', disputeHold: true }]
    await callAdmin(fx, { action: 'handleComplaint', complaintId: 'c1', note: '先处理一条' })
    expect(fx.orders[0].disputeHold).toBe(true)
  })
})

describe('handleDeletionRequest 条件原子更新', () => {
  test('已关闭的申请二次处理:返回失败,处理记录不被覆盖', async () => {
    const fx = BASE()
    // :必须先 executeDeletion 到 executed 态才能关单
    fx.deletion_requests = [{ _id: 'd1', status: 'executed' }]
    const r1 = await callAdmin(fx, { action: 'handleDeletionRequest', requestId: 'd1', note: '已删除订单联系方式' })
    expect(r1.ok).toBe(true)
    expect(fx.deletion_requests[0].operator).toBe('admin-1')
    const r2 = await callAdmin(fx, { action: 'handleDeletionRequest', requestId: 'd1', note: '重复处理' }, 'admin-2')
    expect(r2.ok).toBe(false)
    expect(fx.deletion_requests[0].handleNote).toBe('已删除订单联系方式')
  })
})
