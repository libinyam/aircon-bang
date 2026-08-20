// 账号删除执行闭环:成功 / 有未结纠纷阻断 / 部分失败重试 / 重复执行 / 关单前置
const { fakeDb } = require('./stubs/fakeDb')

async function callAdmin(fx, event, openid = 'admin-1') {
  jest.resetModules()
  global.__mockDb = fakeDb(fx)
  global.__mockCtx = { OPENID: openid }
  global.__deletedFiles = global.__deletedFiles || []
  const { main } = require('../cloudfunctions/admin/index')
  const res = await main(event)
  delete global.__mockDb
  delete global.__mockCtx
  return res
}

const U = 'user-x' // 申请删除的账号
const FX = () => ({
  config: [{ _id: 'app', adminOpenids: ['admin-1'] }],
  deletion_requests: [{ _id: U, openid: U, status: 'open', createdAt: new Date() }],
  users: [{ _id: U, openid: U, phone: '13800138000', contactName: '王先生' }],
  masters: [],
  orders: [],
  reviews: [],
  complaints: [],
  member_logs: [],
  media_checks: [],
  upload_logs: []
})

beforeEach(() => { global.__deletedFiles = [] })
afterEach(() => { delete global.__deletedFiles; delete global.__mockDeleteFile })

describe('成功执行:用户角色全量删除/匿名化', () => {
  test('订单匿名化+照片删除,用户档案删除,评价解除关联,工单 executed', async () => {
    const fx = FX()
    fx.orders = [{
      _id: 'o1', userOpenid: U, masterOpenid: 'm-1', status: 'completed',
      userPhone: '13800138000', userName: '王先生', addressDetail: '3栋502',
      masterPhone: '13911112222', photos: ['cloud://a.jpg']
    }]
    fx.reviews = [{ _id: 'o1', userOpenid: U, masterOpenid: 'm-1', stars: 5, content: '很好' }]
    fx.upload_logs = [{ _id: 'ul1', openid: U, scene: 'order', status: 'pending', fileIDs: ['cloud://pending.jpg'] }]

    const r = await callAdmin(fx, { action: 'executeDeletion', requestId: U })
    expect(r.ok).toBe(true)
    expect(r.blocked).toBeUndefined()
    // 订单:个人字段清空,openid 解除关联,照片文件已删
    const o = fx.orders[0]
    expect(o.userOpenid).toBe('deleted')
    expect(o.userPhone).toBe('')
    expect(o.addressDetail).toBe('')
    expect(o.photos).toEqual([])
    expect(global.__deletedFiles).toContain('cloud://a.jpg')
    expect(global.__deletedFiles).toContain('cloud://pending.jpg')
    // 用户档案删除;评价保留内容但解除关联;上传登记文档移除
    expect(fx.users).toHaveLength(0)
    expect(fx.reviews[0].userOpenid).toBe('deleted')
    expect(fx.reviews[0].content).toBe('很好')
    expect(fx.upload_logs).toHaveLength(0)
    // 工单 executed + 不可变摘要
    const req = fx.deletion_requests[0]
    expect(req.status).toBe('executed')
    expect(req.execution).toMatchObject({ operator: 'admin-1', ordersAnonymized: 1, userRemoved: true })
    expect(req.execution.retained.length).toBeGreaterThan(0)
  })

  test('师傅角色:资质照片删除、档案删除、接单侧匿名化、账务留痕仅清姓名', async () => {
    const fx = FX()
    fx.deletion_requests[0].isMaster = true
    fx.masters = [{ _id: U, openid: U, realName: '李师傅', qualPhotos: ['cloud://id1.jpg'], orphanQualPhotos: ['cloud://old.jpg'], avatarPhoto: 'cloud://avatar.jpg' }]
    fx.orders = [{ _id: 'o2', userOpenid: 'other-user', masterOpenid: U, status: 'completed', masterName: '李师傅', masterPhone: '139' }]
    fx.member_logs = [{ _id: 'req-1', masterId: U, masterName: '李师傅', amount: 300, months: 3 }]
    fx.media_checks = [{ _id: 'mc1', targetId: U, status: 'pending', fileID: 'cloud://id1.jpg' }]

    const r = await callAdmin(fx, { action: 'executeDeletion', requestId: U })
    expect(r.ok).toBe(true)
    expect(fx.masters).toHaveLength(0)
    expect(global.__deletedFiles).toEqual(expect.arrayContaining(['cloud://id1.jpg', 'cloud://old.jpg', 'cloud://avatar.jpg']))
    const o = fx.orders[0]
    expect(o.masterOpenid).toBe('deleted')
    expect(o.masterName).toBe('')
    expect(o.masterPhone).toBe('')
    // 用户侧字段不动:那是对方的服务记录
    expect(o.userOpenid).toBe('other-user')
    // 账务凭证保留,仅清姓名;送检记录作废
    expect(fx.member_logs[0].amount).toBe(300)
    expect(fx.member_logs[0].masterName).toBe('')
    expect(fx.media_checks[0].status).toBe('superseded')
    expect(fx.deletion_requests[0].execution.masterRemoved).toBe(true)
  })
})

describe('阻断项:未完结订单/未结投诉先处理', () => {
  test('进行中订单阻断,不动任何数据,工单保持 open 并记录阻断项', async () => {
    const fx = FX()
    fx.orders = [{ _id: 'o1', userOpenid: U, status: 'accepted', userPhone: '138', photos: [] }]
    const r = await callAdmin(fx, { action: 'executeDeletion', requestId: U })
    expect(r.blocked).toBe(true)
    expect(r.blockers.join()).toContain('进行中订单')
    expect(fx.users).toHaveLength(1)          // 什么都没删
    expect(fx.orders[0].userPhone).toBe('138')
    expect(fx.deletion_requests[0].status).toBe('open')
    expect(fx.deletion_requests[0].lastBlockers.length).toBe(1)
  })

  test('涉及其订单的未结投诉阻断;投诉关闭后可执行', async () => {
    const fx = FX()
    fx.orders = [{ _id: 'o1', userOpenid: U, status: 'completed', photos: [] }]
    fx.complaints = [{ _id: 'c1', orderId: 'o1', fromOpenid: 'm-1', status: 'open' }]
    const r1 = await callAdmin(fx, { action: 'executeDeletion', requestId: U })
    expect(r1.blocked).toBe(true)
    expect(r1.blockers.join()).toContain('未结投诉')

    fx.complaints[0].status = 'closed'
    const r2 = await callAdmin(fx, { action: 'executeDeletion', requestId: U })
    expect(r2.blocked).toBeUndefined()
    expect(fx.deletion_requests[0].status).toBe('executed')
  })
})

describe('部分失败与重试(验收:失败不显示已完成)', () => {
  test('照片删除失败:该订单不匿名化保留线索,工单 pending_retry;重试成功后 executed', async () => {
    const fx = FX()
    fx.orders = [{ _id: 'o1', userOpenid: U, status: 'completed', userPhone: '138', photos: ['cloud://a.jpg'] }]
    global.__mockDeleteFile = (fileList) => ({
      fileList: fileList.map(f => ({ fileID: f, status: -1, errMsg: 'timeout' }))
    })
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const r1 = await callAdmin(fx, { action: 'executeDeletion', requestId: U })
    errSpy.mockRestore()
    expect(r1.partial).toBe(true)
    const req = fx.deletion_requests[0]
    expect(req.status).toBe('pending_retry')
    expect(req.failedFiles).toEqual(['cloud://a.jpg'])
    expect(fx.orders[0].userPhone).toBe('138')   // 未匿名化,fileID 线索不丢
    expect(fx.orders[0].photos).toEqual(['cloud://a.jpg'])

    // 重试:删除恢复正常
    delete global.__mockDeleteFile
    const r2 = await callAdmin(fx, { action: 'executeDeletion', requestId: U })
    expect(r2.partial).toBeUndefined()
    expect(fx.deletion_requests[0].status).toBe('executed')
    expect(fx.orders[0].userPhone).toBe('')
    expect(fx.orders[0].userOpenid).toBe('deleted')
  })

  test('users.remove 抛错:工单 pending_retry 且 userRemoved 不为 true;重试成功后 executed', async () => {
    const fx = FX()
    global.__failRemove = (col, id) => col === 'users' && id === U
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const r1 = await callAdmin(fx, { action: 'executeDeletion', requestId: U })
    errSpy.mockRestore()
    delete global.__failRemove

    expect(r1.partial).toBe(true)
    const req = fx.deletion_requests[0]
    expect(req.status).toBe('pending_retry')          // 不是 executed:假成功被拦住
    expect(req.failedOps).toEqual(['users.remove:' + U])
    expect(req.execution).toBeUndefined()
    expect(r1.summary.userRemoved).toBe(false)
    expect(fx.users).toHaveLength(1)                  // 档案确实还在

    // 重试:删除恢复正常
    const r2 = await callAdmin(fx, { action: 'executeDeletion', requestId: U })
    expect(r2.partial).toBeUndefined()
    expect(fx.users).toHaveLength(0)
    expect(fx.deletion_requests[0].status).toBe('executed')
    expect(fx.deletion_requests[0].execution.userRemoved).toBe(true)
    expect(fx.deletion_requests[0].failedOps).toEqual([])
  })

  test('用户文档本来就不存在:幂等成功,userRemoved 仍为 true', async () => {
    const fx = FX()
    fx.users = []   // 例如上一轮已删掉档案但落盘前中断,重跑
    const r = await callAdmin(fx, { action: 'executeDeletion', requestId: U })
    expect(r.ok).toBe(true)
    expect(r.partial).toBeUndefined()
    expect(fx.deletion_requests[0].status).toBe('executed')
    expect(fx.deletion_requests[0].execution.userRemoved).toBe(true)
  })
})

describe('重复执行与关单前置(验收:不能仅凭备注关单)', () => {
  test('executed 后再次执行:拒绝', async () => {
    const fx = FX()
    await callAdmin(fx, { action: 'executeDeletion', requestId: U })
    expect(fx.deletion_requests[0].status).toBe('executed')
    const r2 = await callAdmin(fx, { action: 'executeDeletion', requestId: U })
    expect(r2.ok).toBe(false)
  })

  test('open 状态直接填备注关单:拒绝;executed 后才能关', async () => {
    const fx = FX()
    const r1 = await callAdmin(fx, { action: 'handleDeletionRequest', requestId: U, note: '手动处理过了' })
    expect(r1.ok).toBe(false)
    expect(fx.deletion_requests[0].status).toBe('open')

    await callAdmin(fx, { action: 'executeDeletion', requestId: U })
    const r2 = await callAdmin(fx, { action: 'handleDeletionRequest', requestId: U, note: '已核对执行摘要' })
    expect(r2.ok).toBe(true)
    expect(fx.deletion_requests[0].status).toBe('closed')
  })

  test('非管理员无权执行', async () => {
    const fx = FX()
    const r = await callAdmin(fx, { action: 'executeDeletion', requestId: U }, 'not-admin')
    expect(r.ok).toBe(false)
    expect(fx.users).toHaveLength(1)
  })
})

describe('存量检测记录脱敏', () => {
  test('已匿名化订单与已删师傅档案的 media_checks:fileID 置空,traceId 保留;他人目标不动', async () => {
    const fx = FX()
    fx.orders = [{
      _id: 'o1', userOpenid: U, masterOpenid: 'm-1', status: 'completed',
      photos: [`cloud://env/orders/${U}/a.jpg`]
    }]
    fx.masters = [{ _id: 'ma1', openid: U, qualPhotos: [`cloud://env/quals/${U}/q.jpg`] }]
    fx.media_checks = [
      { _id: 'c1', traceId: 't1', targetId: 'o1', fileID: `cloud://env/orders/${U}/a.jpg`, status: 'pass' },
      { _id: 'c2', traceId: 't2', targetId: 'ma1', fileID: `cloud://env/quals/${U}/q.jpg`, status: 'pass' },
      { _id: 'c3', traceId: 't3', targetId: 'other-order', fileID: 'cloud://env/orders/other/b.jpg', status: 'pass' }
    ]
    const r = await callAdmin(fx, { action: 'executeDeletion', requestId: U })
    expect(r.ok).toBe(true)
    expect(r.summary.mediaChecksUnlinked).toBe(2)
    // fileID 路径不再含被删账号 openid,traceId 技术元数据保留
    expect(fx.media_checks[0].fileID).toBe('')
    expect(fx.media_checks[0].traceId).toBe('t1')
    expect(fx.media_checks[1].fileID).toBe('')
    expect(fx.media_checks[1].traceId).toBe('t2')
    expect(fx.media_checks[2].fileID).toContain('other')   // 他人订单的记录不动
  })

  test('照片删除失败的订单不匿名化:其 media_checks 留 fileID 供清理重试', async () => {
    const fx = FX()
    fx.orders = [{
      _id: 'o1', userOpenid: U, status: 'completed',
      photos: [`cloud://env/orders/${U}/a.jpg`]
    }]
    fx.media_checks = [
      { _id: 'c1', traceId: 't1', targetId: 'o1', fileID: `cloud://env/orders/${U}/a.jpg`, status: 'pass' }
    ]
    global.__mockDeleteFile = (fileList) => ({
      fileList: fileList.map(f => ({ fileID: f, status: -1, errMsg: 'timeout' }))
    })
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const r = await callAdmin(fx, { action: 'executeDeletion', requestId: U })
      expect(r.partial).toBe(true)
      expect(fx.orders[0].photos).toEqual([`cloud://env/orders/${U}/a.jpg`])   // 未匿名化
      expect(fx.media_checks[0].fileID).toContain(U)   // 线索保留待重试
    } finally {
      errSpy.mockRestore()
    }
  })
})

describe('health 超期告警(SLA)', () => {
  test('open 满10天计入 deletionsOverdue,重开的按 reopenedAt 起算', async () => {
    const fx = FX()
    const days = (n) => new Date(Date.now() - n * 24 * 3600 * 1000)
    fx.deletion_requests = [
      { _id: 'a', openid: 'a', status: 'open', createdAt: days(11) },
      { _id: 'b', openid: 'b', status: 'pending_retry', createdAt: days(12) },
      { _id: 'c', openid: 'c', status: 'open', createdAt: days(2) },
      { _id: 'd', openid: 'd', status: 'open', createdAt: days(30), reopenedAt: days(1) },
      { _id: 'e', openid: 'e', status: 'closed', createdAt: days(40) }
    ]
    const r = await callAdmin(fx, { action: 'health' })
    expect(r.openDeletions).toBe(4)
    expect(r.deletionsOverdue).toBe(2) // a + b;d 按重开时间只有1天
  })
})

describe('requestDeletion 中间态防重置', () => {
  async function callReq(fx, openid = U) {
    jest.resetModules()
    global.__mockDb = fakeDb(fx)
    global.__mockCtx = { OPENID: openid }
    const { main } = require('../cloudfunctions/requestDeletion/index')
    const res = await main()
    delete global.__mockDb
    delete global.__mockCtx
    return res
  }

  test.each(['open', 'pending_retry', 'executed'])('%s 状态重复申请:提示处理中,不重置工单', async (st) => {
    const fx = { deletion_requests: [{ _id: U, openid: U, status: st }], masters: [] }
    const r = await callReq(fx)
    expect(r.already).toBe(true)
    expect(fx.deletion_requests[0].status).toBe(st)
  })

  test('closed 后再次申请:重开新一轮', async () => {
    const fx = { deletion_requests: [{ _id: U, openid: U, status: 'closed' }], masters: [] }
    const r = await callReq(fx)
    expect(r.already).toBe(false)
    expect(fx.deletion_requests[0].status).toBe('open')
    expect(fx.deletion_requests[0].reopenedAt).toBeTruthy()
  })
})
