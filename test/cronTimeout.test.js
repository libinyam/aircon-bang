// cronTimeout 三个时间窗口的离线自动化:时钟注入 + 内存 db
// 窗口:48h 无人接单关闭 / 完成后 72h 自动确认 / 完结 180 天隐私脱敏
const { fakeDb } = require('./stubs/fakeDb')

const NOW = new Date('2026-08-01T12:00:00Z').getTime()
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000)
const daysAgo = (d) => new Date(NOW - d * 24 * 3600 * 1000)

async function runCron(fx) {
  jest.resetModules()
  global.__mockDb = fakeDb(fx)
  global.__deletedFiles = []
  const { main } = require('../cloudfunctions/cronTimeout/index')
  const res = await main()
  const deleted = global.__deletedFiles
  delete global.__mockDb
  delete global.__deletedFiles
  return { res, deleted }
}

beforeAll(() => { jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] }) })
afterAll(() => { jest.useRealTimers() })

describe('窗口1:48小时无人接单自动关闭', () => {
  test('49h 的 published 关掉,47h 的保留', async () => {
    const fx = {
      orders: [
        { _id: 'old', status: 'published', publishedAt: hoursAgo(49) },
        { _id: 'fresh', status: 'published', publishedAt: hoursAgo(47) }
      ],
      complaints: []
    }
    const { res } = await runCron(fx)
    expect(res.closed).toBe(1)
    const byId = Object.fromEntries(fx.orders.map(o => [o._id, o]))
    expect(byId.old.status).toBe('cancelled')
    expect(byId.old.cancelBy).toBe('system')
    expect(byId.fresh.status).toBe('published')
    // 每次运行写 cron_logs 留痕,管理后台运营体检消费
    expect(fx.cron_logs).toHaveLength(1)
    expect(fx.cron_logs[0]).toMatchObject({ closed: 1, autoConfirmed: 0, privacyCleaned: 0, error: '' })
  })

  test('已接单的订单不受 48h 窗口影响', async () => {
    const fx = { orders: [{ _id: 'a', status: 'accepted', publishedAt: hoursAgo(100) }], complaints: [] }
    const { res } = await runCron(fx)
    expect(res.closed).toBe(0)
    expect(fx.orders[0].status).toBe('accepted')
  })
})

describe('窗口1b:期望上门时段已过自动关闭', () => {
  test('expectEnd 已过的 published 关掉,未过的保留,文案区别于48h', async () => {
    const fx = {
      orders: [
        { _id: 'passed', status: 'published', publishedAt: hoursAgo(3), expectEnd: hoursAgo(1) },
        { _id: 'coming', status: 'published', publishedAt: hoursAgo(3), expectEnd: hoursAgo(-2) }
      ],
      complaints: []
    }
    const { res } = await runCron(fx)
    expect(res.expectClosed).toBe(1)
    expect(res.closed).toBe(0)
    const byId = Object.fromEntries(fx.orders.map(o => [o._id, o]))
    expect(byId.passed.status).toBe('cancelled')
    expect(byId.passed.cancelBy).toBe('system')
    expect(byId.passed.cancelReason).toContain('期望上门时段已过')
    expect(byId.coming.status).toBe('published')
  })

  test('历史缺 expectEnd 字段的单不命中此分支,仍由48h分支兜底', async () => {
    const fx = {
      orders: [{ _id: 'legacy', status: 'published', publishedAt: hoursAgo(49) }],
      complaints: []
    }
    const { res } = await runCron(fx)
    expect(res.expectClosed).toBe(0)
    expect(res.closed).toBe(1)
    expect(fx.orders[0].status).toBe('cancelled')
  })

  test('已接单的订单不受 expectEnd 关单影响', async () => {
    const fx = {
      orders: [{ _id: 'a', status: 'accepted', publishedAt: hoursAgo(3), expectEnd: hoursAgo(1) }],
      complaints: []
    }
    const { res } = await runCron(fx)
    expect(res.expectClosed).toBe(0)
    expect(fx.orders[0].status).toBe('accepted')
  })
})

describe('窗口2:完成后72小时用户未确认自动确认', () => {
  test('73h 的 pending_confirm 自动完成并累计师傅完成数;71h 的保留', async () => {
    const fx = {
      orders: [
        { _id: 'stale', status: 'pending_confirm', finishedAt: hoursAgo(73), masterOpenid: 'm-1', publishedAt: hoursAgo(80) },
        { _id: 'recent', status: 'pending_confirm', finishedAt: hoursAgo(71), masterOpenid: 'm-1', publishedAt: hoursAgo(80) }
      ],
      masters: [{ _id: 'm-1', openid: 'm-1', stats: { done: 5 } }],
      complaints: []
    }
    const { res } = await runCron(fx)
    expect(res.autoConfirmed).toBe(1)
    expect(res.statsCredited).toBe(1)
    const byId = Object.fromEntries(fx.orders.map(o => [o._id, o]))
    expect(byId.stale.status).toBe('completed')
    expect(byId.stale.autoConfirmed).toBe(true)
    expect(byId.stale.statsCredited).toBe(true)
    expect(byId.recent.status).toBe('pending_confirm')
    expect(fx.masters[0].stats.done).toBe(6)
  })
})

describe('窗口2:未结投诉冻结自动确认', () => {
  const staleOrder = (over = {}) => Object.assign({
    _id: 'o1', status: 'pending_confirm', finishedAt: hoursAgo(73),
    masterOpenid: 'm-1', publishedAt: hoursAgo(80)
  }, over)
  const master = () => [{ _id: 'm-1', openid: 'm-1', stats: { done: 5 } }]

  test('有未结投诉:不自动确认,不加师傅完成数', async () => {
    const fx = {
      orders: [staleOrder({ disputeHold: true })],
      masters: master(),
      complaints: [{ _id: 'c1', orderId: 'o1', status: 'open' }]
    }
    const { res } = await runCron(fx)
    expect(res.autoConfirmed).toBe(0)
    expect(res.autoConfirmHeld).toBe(1)
    expect(fx.orders[0].status).toBe('pending_confirm')
    expect(fx.masters[0].stats.done).toBe(5)
  })

  test('竞态:count 检查通过后、翻转提交前投诉入场(hold 已落库)——原子条件拦住,不完成', async () => {
    const fx = {
      orders: [staleOrder()],   // 快照与 count 检查时都还没有投诉
      masters: master(),
      complaints: []
    }
    // 用注入钩子模拟 complain 抢先落库:cron 提交翻转的瞬间,行上已被打了 disputeHold
    global.__failUpdate = (col, f) => {
      if (col === 'orders' && f.status === 'pending_confirm') fx.orders[0].disputeHold = true
      return false   // 不抛错,只在条件求值前改行,考验 where 条件本身
    }
    const { res } = await runCron(fx)
    delete global.__failUpdate

    expect(res.autoConfirmed).toBe(0)          // where 带 disputeHold: _.neq(true),没翻成
    expect(fx.orders[0].status).toBe('pending_confirm')
    expect(fx.masters[0].stats.done).toBe(5)
  })

  test('投诉关闭后:残留 hold 先清一轮,再下一轮恢复自动确认并记账', async () => {
    const fx = {
      orders: [staleOrder({ disputeHold: true })],
      masters: master(),
      complaints: [{ _id: 'c1', orderId: 'o1', status: 'open' }]
    }
    await runCron(fx)
    expect(fx.orders[0].status).toBe('pending_confirm')

    fx.complaints[0].status = 'closed'  // 管理员关闭投诉(未走 admin 清 hold 的兜底路径)
    const second = await runCron(fx)
    expect(second.res.autoConfirmHeld).toBe(1)
    expect(fx.orders[0].disputeHold).toBe(false)
    expect(fx.orders[0].status).toBe('pending_confirm')

    const third = await runCron(fx)
    expect(third.res.autoConfirmed).toBe(1)
    expect(fx.orders[0].status).toBe('completed')
    expect(fx.masters[0].stats.done).toBe(6)
  })
})

describe('窗口2:单单隔离与统计补账', () => {
  const twoStale = () => [
    { _id: 'bad', status: 'pending_confirm', finishedAt: hoursAgo(73), masterOpenid: 'm-1', publishedAt: hoursAgo(80) },
    { _id: 'good', status: 'pending_confirm', finishedAt: hoursAgo(73), masterOpenid: 'm-1', publishedAt: hoursAgo(80) }
  ]
  const master = () => [{ _id: 'm-1', openid: 'm-1', stats: { done: 5 } }]

  afterEach(() => { delete global.__failUpdate })

  test('一单翻转抛错:其他订单照常处理,后续阶段(cron_logs)照常执行', async () => {
    const fx = { orders: twoStale(), masters: master(), complaints: [] }
    global.__failUpdate = (col, f) => col === 'orders' && f._id === 'bad' && f.status === 'pending_confirm'
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const { res } = await runCron(fx)
    errSpy.mockRestore()

    expect(res.autoConfirmFailed).toBe(1)
    expect(res.autoConfirmed).toBe(1)          // good 单不受影响
    const byId = Object.fromEntries(fx.orders.map(o => [o._id, o]))
    expect(byId.bad.status).toBe('pending_confirm')
    expect(byId.good.status).toBe('completed')
    expect(fx.masters[0].stats.done).toBe(6)
    expect(fx.cron_logs).toHaveLength(1)       // 尾部阶段没有被中断
  })

  test('统计更新失败:状态已完成的单不漏计——认领回滚,下一轮补账,且不重复加', async () => {
    const fx = { orders: twoStale().slice(0, 1), masters: master(), complaints: [] }
    global.__failUpdate = (col) => col === 'masters'
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const first = await runCron(fx)
    errSpy.mockRestore()
    delete global.__failUpdate

    // 状态已翻转但没记上账:认领标记回滚,failedIds 留摘要
    expect(first.res.autoConfirmed).toBe(1)
    expect(first.res.statsFailed).toBe(1)
    expect(first.res.statsFailedIds).toEqual(['bad'])
    expect(fx.orders[0].status).toBe('completed')
    expect(fx.orders[0].statsCredited).toBe(false)
    expect(fx.masters[0].stats.done).toBe(5)

    // 下一轮:补账拾起,完成数 +1
    const second = await runCron(fx)
    expect(second.res.statsCredited).toBe(1)
    expect(fx.orders[0].statsCredited).toBe(true)
    expect(fx.masters[0].stats.done).toBe(6)

    // 再跑一轮:不会重复加
    const third = await runCron(fx)
    expect(third.res.statsCredited).toBe(0)
    expect(fx.masters[0].stats.done).toBe(6)
  })

  test('师傅档案不存在:记账落空但标记已认领,不无限重试', async () => {
    const fx = {
      orders: [{ _id: 'o1', status: 'pending_confirm', finishedAt: hoursAgo(73), masterOpenid: 'gone', publishedAt: hoursAgo(80) }],
      masters: [], complaints: []
    }
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const { res } = await runCron(fx)
    warnSpy.mockRestore()
    expect(res.autoConfirmed).toBe(1)
    expect(res.statsCredited).toBe(1)
    expect(res.statsFailed).toBe(0)
    expect(fx.orders[0].statsCredited).toBe(true)
  })

  test('历史手动确认的完成单没有 statsCredited 字段:不误补(confirmOrder 已当场加过)', async () => {
    const fx = {
      orders: [{ _id: 'o1', status: 'completed', masterOpenid: 'm-1', publishedAt: hoursAgo(80), confirmedAt: hoursAgo(1) }],
      masters: [{ _id: 'm-1', openid: 'm-1', stats: { done: 5 } }],
      complaints: []
    }
    const { res } = await runCron(fx)
    expect(res.statsCredited).toBe(0)
    expect(fx.masters[0].stats.done).toBe(5)   // 缺字段不命中等值查询,cron 不重复加
  })

  test('手动确认漏账的单(statsCredited:false,无 autoConfirmed):同样被补账', async () => {
    const fx = {
      orders: [{ _id: 'o1', status: 'completed', statsCredited: false, masterOpenid: 'm-1', publishedAt: hoursAgo(80), confirmedAt: hoursAgo(1) }],
      masters: [{ _id: 'm-1', openid: 'm-1', stats: { done: 5 } }],
      complaints: []
    }
    const { res } = await runCron(fx)
    expect(res.statsCredited).toBe(1)
    expect(fx.orders[0].statsCredited).toBe(true)
    expect(fx.masters[0].stats.done).toBe(6)
  })
})

describe('窗口2c:评价统计补账', () => {
  test('statsApplied:false 的评价按存档星级补记,补过不重复加', async () => {
    const fx = {
      orders: [], complaints: [],
      reviews: [{ _id: 'r1', orderId: 'o1', masterOpenid: 'm-1', stars: 4, statsApplied: false }],
      masters: [{ _id: 'm-1', openid: 'm-1', stats: { reviewCount: 1, totalStars: 5 } }]
    }
    const first = await runCron(fx)
    expect(first.res.reviewStatsCredited).toBe(1)
    expect(fx.reviews[0].statsApplied).toBe(true)
    expect(fx.masters[0].stats.reviewCount).toBe(2)
    expect(fx.masters[0].stats.totalStars).toBe(9)

    const second = await runCron(fx)
    expect(second.res.reviewStatsCredited).toBe(0)
    expect(fx.masters[0].stats.reviewCount).toBe(2)
  })

  test('历史评价缺 statsApplied 字段:不误补', async () => {
    const fx = {
      orders: [], complaints: [],
      reviews: [{ _id: 'r1', orderId: 'o1', masterOpenid: 'm-1', stars: 4 }],
      masters: [{ _id: 'm-1', openid: 'm-1', stats: { reviewCount: 1, totalStars: 5 } }]
    }
    const { res } = await runCron(fx)
    expect(res.reviewStatsCredited).toBe(0)
    expect(fx.masters[0].stats.reviewCount).toBe(1)
  })
})

describe('窗口3:完结满180天隐私脱敏', () => {
  const oldOrder = (over = {}) => Object.assign({
    _id: 'p1', status: 'completed', publishedAt: daysAgo(181),
    userPhone: '13800138000', userName: '王先生', addressDetail: '3栋502',
    address: '阳光花园', location: { type: 'Point', coordinates: [120.38, 36.07] },
    masterPhone: '13911112222', photos: ['cloud://a.jpg', 'cloud://b.jpg']
  }, over)

  test('180天以上完结单:清联系方式/门牌,删照片,打标记', async () => {
    const fx = { orders: [oldOrder()], complaints: [] }
    const { res, deleted } = await runCron(fx)
    expect(res.privacyCleaned).toBe(1)
    const o = fx.orders[0]
    expect(o.userPhone).toBe('')
    expect(o.userName).toBe('')
    expect(o.addressDetail).toBe('')
    expect(o.address).toBe('')              // 小区级地址与坐标同口径清除
    expect(o.location).toBe(null)
    expect(o.masterPhone).toBe('')
    expect(o.photos).toEqual([])
    expect(o.privacyCleaned).toBe(true)
    expect(deleted).toEqual(['cloud://a.jpg', 'cloud://b.jpg'])
  })

  test('未满180天 / 进行中订单:不清理', async () => {
    const fx = {
      orders: [
        oldOrder({ _id: 'young', publishedAt: daysAgo(179) }),
        oldOrder({ _id: 'active', status: 'accepted', publishedAt: daysAgo(200) })
      ],
      complaints: []
    }
    const { res } = await runCron(fx)
    expect(res.privacyCleaned).toBe(0)
    expect(fx.orders[0].userPhone).toBe('13800138000')
    expect(fx.orders[0].address).toBe('阳光花园')   // 未到期不清理
    expect(fx.orders[1].userPhone).toBe('13800138000')
  })

  test('有未结投诉的订单跳过,投诉关闭后可清', async () => {
    const fx = {
      orders: [oldOrder()],
      complaints: [{ _id: 'c1', orderId: 'p1', status: 'open' }]
    }
    const first = await runCron(fx)
    expect(first.res.privacyCleaned).toBe(0)
    expect(fx.orders[0].userPhone).toBe('13800138000')

    fx.complaints[0].status = 'closed'
    const second = await runCron(fx)
    expect(second.res.privacyCleaned).toBe(1)
    expect(fx.orders[0].userPhone).toBe('')
  })

  test('发布超180天但刚完结的订单:不清理(保留期从完结时刻起算,)', async () => {
    const fx = {
      orders: [
        oldOrder({ _id: 'fresh-done', publishedAt: daysAgo(200), confirmedAt: daysAgo(10) }),
        oldOrder({ _id: 'old-cancel', status: 'cancelled', publishedAt: daysAgo(400), cancelledAt: daysAgo(181) })
      ],
      complaints: []
    }
    const { res } = await runCron(fx)
    expect(res.privacyCleaned).toBe(1)
    const byId = Object.fromEntries(fx.orders.map(o => [o._id, o]))
    expect(byId['fresh-done'].userPhone).toBe('13800138000') // 完结才10天,保留
    expect(byId['old-cancel'].userPhone).toBe('')            // 取消满181天,清理
  })

  test('照片删除失败:不打清理标记,下一轮删除成功后再清', async () => {
    const fx = { orders: [oldOrder()], complaints: [] }
    // 第一轮:注入逐文件失败
    global.__mockDeleteFile = (fileList) => ({
      fileList: fileList.map(f => ({ fileID: f, status: -1, errMsg: 'STORAGE_EXCEED_AUTHORITY' }))
    })
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const first = await runCron(fx)
    expect(first.res.privacyCleaned).toBe(0)
    expect(fx.orders[0].privacyCleaned).toBeUndefined()
    expect(fx.orders[0].photos).toHaveLength(2) // 文件线索保留
    // 第二轮:删除恢复正常
    delete global.__mockDeleteFile
    const second = await runCron(fx)
    errSpy.mockRestore()
    expect(second.res.privacyCleaned).toBe(1)
    expect(fx.orders[0].privacyCleaned).toBe(true)
  })

  test('"文件不存在"视为删除成功,不会卡死清理', async () => {
    const fx = { orders: [oldOrder()], complaints: [] }
    global.__mockDeleteFile = (fileList) => ({
      fileList: fileList.map(f => ({ fileID: f, status: -503003, errMsg: 'file not exist' }))
    })
    const { res } = await runCron(fx)
    delete global.__mockDeleteFile
    expect(res.privacyCleaned).toBe(1)
  })

  test('已清理过的订单不再重复处理(privacyCleaned 标记)', async () => {
    const fx = { orders: [oldOrder({ privacyCleaned: true, userPhone: '' })], complaints: [] }
    const { res, deleted } = await runCron(fx)
    expect(res.privacyCleaned).toBe(0)
    expect(deleted).toEqual([])
  })
})

describe('窗口4:违规图删除失败的补偿重试', () => {
  test('cleanupPending 的检测记录:重试删除成功后清标记', async () => {
    const fx = {
      orders: [], complaints: [],
      media_checks: [
        { _id: 'c1', fileID: 'cloud://risky.jpg', cleanupPending: true, status: 'risky' },
        { _id: 'c2', fileID: 'cloud://ok.jpg', cleanupPending: false, status: 'pass' }
      ]
    }
    const { res, deleted } = await runCron(fx)
    expect(res.mediaCleanupRetried).toBe(1)
    expect(deleted).toContain('cloud://risky.jpg')
    expect(fx.media_checks[0].cleanupPending).toBe(false)
    expect(fx.media_checks[1].cleanupPending).toBe(false)
  })

  test('重试仍失败:标记保留,下轮继续', async () => {
    const fx = {
      orders: [], complaints: [],
      media_checks: [{ _id: 'c1', fileID: 'cloud://risky.jpg', cleanupPending: true }]
    }
    global.__mockDeleteFile = (fileList) => ({
      fileList: fileList.map(f => ({ fileID: f, status: -1, errMsg: 'timeout' }))
    })
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const { res } = await runCron(fx)
    delete global.__mockDeleteFile
    errSpy.mockRestore()
    expect(res.mediaCleanupRetried).toBe(0)
    expect(fx.media_checks[0].cleanupPending).toBe(true)
  })
})

describe('窗口5:上传登记满24h未被引用的孤儿文件清理', () => {
  const OID = 'u-1'
  const fid = (n) => `cloud://env.x/orders/${OID}/${n}.jpg`
  const pendingLog = (over = {}) => Object.assign({
    _id: 'log1', openid: OID, scene: 'order', status: 'pending',
    fileIDs: [fid(1), fid(2)], createdAt: hoursAgo(25)
  }, over)

  test('order 场景:被订单引用的保留,未引用的删除,日志标记 resolved', async () => {
    const fx = {
      orders: [{ _id: 'o1', userOpenid: OID, status: 'published', publishedAt: hoursAgo(25), photos: [fid(1)] }],
      complaints: [],
      upload_logs: [pendingLog()]
    }
    const { res, deleted } = await runCron(fx)
    expect(res.uploadLogsResolved).toBe(1)
    expect(res.uploadOrphansCleaned).toBe(1)
    expect(deleted).toEqual([fid(2)])
    expect(fx.upload_logs[0].status).toBe('resolved')
    expect(fx.upload_logs[0].orphanCount).toBe(1)
  })

  test('全部被引用(正常提交):零删除,仅标记 resolved', async () => {
    const fx = {
      orders: [{ _id: 'o1', userOpenid: OID, status: 'published', publishedAt: hoursAgo(25), photos: [fid(1), fid(2)] }],
      complaints: [],
      upload_logs: [pendingLog()]
    }
    const { res, deleted } = await runCron(fx)
    expect(res.uploadLogsResolved).toBe(1)
    expect(res.uploadOrphansCleaned).toBe(0)
    expect(deleted).toEqual([])
    expect(fx.upload_logs[0].status).toBe('resolved')
  })

  test('登记不满24h:不处理(给慢提交留足窗口)', async () => {
    const fx = { orders: [], complaints: [], upload_logs: [pendingLog({ createdAt: hoursAgo(23) })] }
    const { res, deleted } = await runCron(fx)
    expect(res.uploadLogsResolved).toBe(0)
    expect(deleted).toEqual([])
    expect(fx.upload_logs[0].status).toBe('pending')
  })

  test('qual 场景:qualPhotos/orphanQualPhotos 里的都视为已引用', async () => {
    const q = (n) => `cloud://env.x/quals/${OID}/${n}.jpg`
    const fx = {
      masters: [{ _id: OID, openid: OID, qualPhotos: [q(1)], orphanQualPhotos: [q(2)] }],
      orders: [], complaints: [],
      upload_logs: [pendingLog({ scene: 'qual', fileIDs: [q(1), q(2), q(3)] })]
    }
    const { res, deleted } = await runCron(fx)
    expect(res.uploadLogsResolved).toBe(1)
    expect(res.uploadOrphansCleaned).toBe(1)
    expect(deleted).toEqual([q(3)]) // q1 在用、q2 有独立清理线索,只删 q3
  })

  test('删除失败:日志保持 pending,下一轮重试成功后 resolved', async () => {
    const fx = { orders: [], complaints: [], upload_logs: [pendingLog()] }
    global.__mockDeleteFile = (fileList) => ({
      fileList: fileList.map(f => ({ fileID: f, status: -1, errMsg: 'timeout' }))
    })
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const first = await runCron(fx)
    delete global.__mockDeleteFile
    expect(first.res.uploadLogsResolved).toBe(0)
    expect(fx.upload_logs[0].status).toBe('pending')

    const second = await runCron(fx)
    errSpy.mockRestore()
    expect(second.res.uploadLogsResolved).toBe(1)
    expect(second.res.uploadOrphansCleaned).toBe(2)
    expect(fx.upload_logs[0].status).toBe('resolved')
  })

  test('业务函数已删过的文件(badAndClean):"不存在"视为成功,日志正常收敛', async () => {
    const fx = { orders: [], complaints: [], upload_logs: [pendingLog()] }
    global.__mockDeleteFile = (fileList) => ({
      fileList: fileList.map(f => ({ fileID: f, status: -503003, errMsg: 'file not exist' }))
    })
    const { res } = await runCron(fx)
    delete global.__mockDeleteFile
    expect(res.uploadLogsResolved).toBe(1)
    expect(fx.upload_logs[0].status).toBe('resolved')
  })

  test('已 resolved 的日志不再处理', async () => {
    const fx = { orders: [], complaints: [], upload_logs: [pendingLog({ status: 'resolved' })] }
    const { res, deleted } = await runCron(fx)
    expect(res.uploadLogsResolved).toBe(0)
    expect(deleted).toEqual([])
  })
})

describe('窗口5b:listing 场景的上传核销(买空调频道)', () => {
  const OID = 'm-1'
  const lfid = (n) => `cloud://env.x/listings/${OID}/${n}.jpg`
  const listingLog = (over = {}) => Object.assign({
    _id: 'log1', openid: OID, scene: 'listing', status: 'pending',
    fileIDs: [lfid(1), lfid(2)], createdAt: hoursAgo(25)
  }, over)

  test('被商品引用的保留,未引用的删除', async () => {
    const fx = {
      listings: [{ _id: 'l1', sellerOpenid: OID, createdAt: hoursAgo(25), photos: [lfid(1)] }],
      orders: [], complaints: [],
      upload_logs: [listingLog()]
    }
    const { res, deleted } = await runCron(fx)
    expect(res.uploadLogsResolved).toBe(1)
    expect(res.uploadOrphansCleaned).toBe(1)
    expect(deleted).toEqual([lfid(2)])
    expect(fx.upload_logs[0].status).toBe('resolved')
  })

  test('关键回归:listing 场景绝不走资质分支(否则商品图全被当孤儿误删)', async () => {
    // 陷阱布置:masters 里放着同 openid 的档案,qualPhotos 恰好"引用"了这两个文件——
    // 若 listing 掉进旧 else(查 masters),两文件会被误判为已引用而零删除;
    // 正确行为是按 listings 集合核销,商品不存在 -> 两文件都是孤儿
    const fx = {
      masters: [{ _id: OID, openid: OID, qualPhotos: [lfid(1), lfid(2)] }],
      listings: [], orders: [], complaints: [],
      upload_logs: [listingLog()]
    }
    const { res, deleted } = await runCron(fx)
    expect(res.uploadOrphansCleaned).toBe(2)
    expect(deleted).toEqual([lfid(1), lfid(2)])
  })
})

describe('窗口5c:avatar 场景的上传核销(展示头像)', () => {
  const OID = 'm-av'
  const afid = (n) => `cloud://env.x/avatars/${OID}/${n}.jpg`
  const avatarLog = (over = {}) => Object.assign({
    _id: 'log1', openid: OID, scene: 'avatar', status: 'pending',
    fileIDs: [afid(1)], createdAt: hoursAgo(25)
  }, over)

  test('头像在用( masters.avatarPhoto 引用):保留,日志标记 resolved——qualPhotos 为空也不能误判(绝不走资质分支)', async () => {
    const fx = {
      masters: [{ _id: OID, openid: OID, qualPhotos: [], avatarPhoto: afid(1) }],
      orders: [], complaints: [],
      upload_logs: [avatarLog()]
    }
    const { res, deleted } = await runCron(fx)
    expect(res.uploadLogsResolved).toBe(1)
    expect(res.uploadOrphansCleaned).toBe(0)
    expect(deleted).toEqual([])
    expect(fx.upload_logs[0].status).toBe('resolved')
  })

  test('已更换头像(档案引用新 fileID):旧文件按孤儿删除', async () => {
    const fx = {
      masters: [{ _id: OID, openid: OID, avatarPhoto: afid(2) }],
      orders: [], complaints: [],
      upload_logs: [avatarLog()]
    }
    const { res, deleted } = await runCron(fx)
    expect(res.uploadOrphansCleaned).toBe(1)
    expect(deleted).toEqual([afid(1)])
  })
})

describe('窗口4b:违规处置落库失败的补偿重放(评审:applyPending / 卡死 processing)', () => {
  const f = 'cloud://env.x/listings/m1/a.jpg'
  const stuck = (over = {}) => Object.assign({
    _id: 'c1', traceId: 't1', type: 'listing', targetId: 'l1', fileID: f,
    status: 'processing', suggest: 'risky', applyPending: true, claimedAt: hoursAgo(2)
  }, over)

  test('按认领时存下的 suggest 重放:摘图+删文件+落终态', async () => {
    const fx = {
      media_checks: [stuck()],
      listings: [{ _id: 'l1', status: 'on_sale', photos: [f, 'keep.jpg'] }],
      orders: [], complaints: []
    }
    const { res, deleted } = await runCron(fx)
    expect(res.mediaApplyRetried).toBe(1)
    expect(fx.listings[0].photos).toEqual(['keep.jpg'])
    expect(fx.listings[0].photosRisk).toBe(true)
    expect(deleted).toContain(f)
    expect(fx.media_checks[0]).toMatchObject({ status: 'risky', applyPending: false })
  })

  test('目标商品已删除:置 superseded 终态,不永久挂起', async () => {
    const fx = { media_checks: [stuck()], listings: [], orders: [], complaints: [] }
    const { res, deleted } = await runCron(fx)
    expect(res.mediaApplyRetried).toBe(1)
    expect(fx.media_checks[0].status).toBe('superseded')
    expect(deleted).toEqual([])
  })

  test('认领不满1小时的 processing 不动(给实时回调留处理窗口)', async () => {
    const fx = {
      media_checks: [stuck({ claimedAt: hoursAgo(0.5) })],
      listings: [{ _id: 'l1', status: 'on_sale', photos: [f] }],
      orders: [], complaints: []
    }
    const { res } = await runCron(fx)
    expect(res.mediaApplyRetried).toBe(0)
    expect(fx.media_checks[0].status).toBe('processing')
  })
})

describe('批处理上限(fakeDb 查询语义修复后可测,)', () => {
  test('自动确认单轮上限 100:101 条过期单只翻转 100 条,剩余下一轮', async () => {
    const fx = {
      orders: Array.from({ length: 101 }, (_, i) => ({
        _id: 'o' + i, status: 'pending_confirm', finishedAt: hoursAgo(73),
        masterOpenid: 'm-1', publishedAt: hoursAgo(80)
      })),
      masters: [{ _id: 'm-1', openid: 'm-1', stats: { done: 0 } }],
      complaints: []
    }
    const { res } = await runCron(fx)
    expect(res.autoConfirmed).toBe(100)
    expect(fx.orders.filter(o => o.status === 'completed')).toHaveLength(100)
    expect(fx.orders.filter(o => o.status === 'pending_confirm')).toHaveLength(1)
    expect(fx.masters[0].stats.done).toBe(100)   // 补账阶段同上限,本轮翻转的单全部记上
  })
})

describe('窗口2d:接单费对账补退', () => {
  // 卡死扣款的标准形状:grab 流水在、退款流水不在、订单最终被别人接走(扣款-抢单-退回之间被杀)
  const stuckFx = () => ({
    orders: [{ _id: 'o1', status: 'accepted', masterOpenid: 'm-winner', publishedAt: daysAgo(1) }],
    wallets: [{ _id: 'm-loser', balance: 48000 }],
    wallet_logs: [{ _id: 'grab:o1:m-loser', openid: 'm-loser', type: 'grab', amount: -2000, orderId: 'o1', scene: 'home', createdAt: hoursAgo(1) }],
    complaints: []
  })

  test('无退款的孤儿扣款:落待补流水并当轮补退,余额复原', async () => {
    const fx = stuckFx()
    const { res } = await runCron(fx)
    expect(res.walletStuckFound).toBe(1)
    expect(res.walletRefunded).toBe(1)
    expect(fx.wallets[0].balance).toBe(50000)
    expect(fx.wallet_logs.find(l => l._id === 'refund:grab:o1:m-loser'))
      .toMatchObject({ type: 'refund', amount: 2000, status: 'done' })
  })

  test('重复运行幂等:只补退一次,不双退', async () => {
    const fx = stuckFx()
    await runCron(fx)
    const { res } = await runCron(fx)
    expect(res.walletStuckFound).toBe(0)   // 退款流水已存在,检测步跳过
    expect(res.walletRefunded).toBe(0)     // 无 need_manual 待结算
    expect(fx.wallets[0].balance).toBe(50000)
  })

  test('订单最终由本人接成(合法扣费):不退', async () => {
    const fx = stuckFx()
    fx.orders[0].masterOpenid = 'm-loser'
    const { res } = await runCron(fx)
    expect(res.walletStuckFound).toBe(0)
    expect(fx.wallets[0].balance).toBe(48000)
    expect(fx.wallet_logs).toHaveLength(1)
  })

  test('10分钟内的扣款不处理(给进行中的 grabOrder 留窗口)', async () => {
    const fx = stuckFx()
    fx.wallet_logs[0].createdAt = hoursAgo(1 / 60)   // 1 分钟前
    const { res } = await runCron(fx)
    expect(res.walletStuckFound).toBe(0)
    expect(fx.wallets[0].balance).toBe(48000)
  })

  test('已有正常退款流水(无 status)的扣款:检测步跳过', async () => {
    const fx = stuckFx()
    fx.wallet_logs.push({ _id: 'refund:grab:o1:m-loser', openid: 'm-loser', type: 'refund', amount: 2000, orderId: 'o1', scene: 'home', createdAt: hoursAgo(1) })
    const { res } = await runCron(fx)
    expect(res.walletStuckFound).toBe(0)
    expect(res.walletRefunded).toBe(0)
    expect(fx.wallets[0].balance).toBe(48000)   // 正常流水不带 status,不进结算
  })

  test('grabOrder 落的 need_manual 待补流水:无需检测步直接补退', async () => {
    const fx = stuckFx()
    fx.wallet_logs[0] = {
      _id: 'refund:grab:o2:m-loser', openid: 'm-loser', type: 'refund', amount: 30000,
      orderId: 'o2', scene: 'commercial', status: 'need_manual', createdAt: hoursAgo(2)
    }
    const { res } = await runCron(fx)
    expect(res.walletRefunded).toBe(1)
    expect(fx.wallets[0].balance).toBe(48000 + 30000)
    expect(fx.wallet_logs[0].status).toBe('done')
  })

  test('结算加钱失败:回滚认领下一轮重试,不丢钱', async () => {
    const fx = stuckFx()
    global.__failUpdate = (name) => name === 'wallets'
    try {
      const { res } = await runCron(fx)
      expect(res.walletRefundFailed).toBe(1)
      expect(res.walletRefunded).toBe(0)
      expect(fx.wallet_logs.find(l => l._id === 'refund:grab:o1:m-loser').status).toBe('need_manual')
    } finally {
      delete global.__failUpdate
    }
    const { res } = await runCron(fx)   // 故障解除:下一轮补退成功
    expect(res.walletRefunded).toBe(1)
    expect(fx.wallets[0].balance).toBe(50000)
  })

  test('钱包文档不存在:关闭流水不重试,留日志人工核对', async () => {
    const fx = stuckFx()
    fx.wallets = []
    const { res } = await runCron(fx)
    expect(res.walletRefunded).toBe(0)
    expect(fx.wallet_logs.find(l => l._id === 'refund:grab:o1:m-loser').status).toBe('done')
  })
})
