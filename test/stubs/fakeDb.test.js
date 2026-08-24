// fakeDb 查询链契约:orderBy/skip/limit 从空操作改为真实语义后,
// 这里钉死桩本身的行为——排序方向、缺失字段、多键、窗口截取、count 口径,
// 消费方测试(getOrders/getListings/admin 分页)建立在这些保证之上
const { fakeDb } = require('./fakeDb')

const d = (ms) => new Date(Date.UTC(2026, 7, 1, 0, 0, 0) + ms)
const fx = () => ({
  items: [
    { _id: 'a', n: 3, tag: 'x', at: d(3000) },
    { _id: 'b', n: 1, tag: 'x', at: d(1000) },
    { _id: 'c', n: 2, tag: 'y', at: d(2000) },
    { _id: 'e', n: 5, tag: 'y' }            // 缺 at:排序按最小值参与
  ]
})

describe('orderBy 真实排序', () => {
  test('数字升序/降序', async () => {
    const db = fakeDb(fx())
    const asc = (await db.collection('items').orderBy('n', 'asc').get()).data.map(r => r._id)
    expect(asc).toEqual(['b', 'c', 'a', 'e'])
    const desc = (await db.collection('items').orderBy('n', 'desc').get()).data.map(r => r._id)
    expect(desc).toEqual(['e', 'a', 'c', 'b'])
  })

  test('缺失字段按最小值:升序排最前(publishOrder 轮转"从未通知过的师傅优先"依赖此语义),降序排最后', async () => {
    const db = fakeDb(fx())
    const asc = (await db.collection('items').orderBy('at', 'asc').get()).data.map(r => r._id)
    expect(asc).toEqual(['e', 'b', 'c', 'a'])
    const desc = (await db.collection('items').orderBy('at', 'desc').get()).data.map(r => r._id)
    expect(desc).toEqual(['a', 'c', 'b', 'e'])
  })

  test('多键排序:tag 升序 + n 降序', async () => {
    const db = fakeDb(fx())
    const r = (await db.collection('items').orderBy('tag', 'asc').orderBy('n', 'desc').get()).data.map(x => x._id)
    expect(r).toEqual(['a', 'b', 'e', 'c'])
  })

  test('排序键相等时保持稳定(不重排同键文档)', async () => {
    const db = fakeDb(fx())
    const r = (await db.collection('items').orderBy('tag', 'asc').get()).data.map(x => x._id)
    expect(r).toEqual(['a', 'b', 'c', 'e'])   // 同 tag 内维持插入序
  })
})

describe('skip/limit 窗口语义', () => {
  test('排序 -> 偏移 -> 截断的应用顺序(skip 按排序后的位次计算)', async () => {
    const db = fakeDb(fx())
    const r = (await db.collection('items').orderBy('n', 'asc').skip(1).limit(2).get()).data.map(x => x._id)
    expect(r).toEqual(['c', 'a'])            // 升序 b,c,a,e 去掉 b 取两位
  })

  test('where 过滤先于排序与窗口', async () => {
    const db = fakeDb(fx())
    const r = (await db.collection('items').where({ tag: 'y' }).orderBy('n', 'desc').limit(1).get()).data
    expect(r.map(x => x._id)).toEqual(['e'])
  })

  test('limit(1) 取排序后的第一条(admin health 读最新 cron 日志的形状)', async () => {
    const db = fakeDb(fx())
    const r = (await db.collection('items').orderBy('at', 'desc').limit(1).get()).data
    expect(r).toHaveLength(1)
    expect(r[0]._id).toBe('a')
  })
})

describe('count 口径', () => {
  test('count 只受 where 与 skip/limit 影响(排序不改条数)', async () => {
    const db = fakeDb(fx())
    expect((await db.collection('items').count()).total).toBe(4)
    expect((await db.collection('items').orderBy('n', 'asc').count()).total).toBe(4)
    expect((await db.collection('items').skip(1).count()).total).toBe(3)
    expect((await db.collection('items').limit(2).count()).total).toBe(2)
    expect((await db.collection('items').where({ tag: 'x' }).count()).total).toBe(2)
  })
})

describe('快照与副作用隔离', () => {
  test('get 返回深拷贝:改结果不影响集合,后续 update 不改已取快照', async () => {
    const db = fakeDb(fx())
    const snap = (await db.collection('items').orderBy('n', 'asc').get()).data
    snap[0].n = 999                          // snap[0] 是 b 的快照
    expect((await db.collection('items').where({ _id: 'b' }).get()).data[0].n).toBe(1)

    await db.collection('items').where({ _id: 'b' }).update({ data: { n: 42 } })
    expect(snap[0].n).toBe(999)              // 取数后的 update 不会追改已返回的快照
  })

  test('update/remove 不受链上 skip/limit 影响(与真库 where().update 全量命中一致)', async () => {
    const db = fakeDb(fx())
    const r = await db.collection('items').orderBy('n', 'asc').limit(1).update({ data: { tag: 'z' } })
    expect(r.stats.updated).toBe(4)          // limit 不收窄 update 的命中面
  })
})

describe('多选品类查询语义(and/or 逻辑组合 + 数组元素匹配)', () => {
  // 订单品类多选:存量单只有单选 category,新单另有 categories 数组;池/抢单按"任一交集"匹配
  const fxOrders = () => ({
    orders: [
      { _id: 'old', status: 'published', category: 'repair' },
      { _id: 'multi', status: 'published', category: 'repair', categories: ['repair', 'clean'] },
      { _id: 'clean-only', status: 'published', category: 'clean', categories: ['clean'] }
    ]
  })

  test('数组字段等值命中任一元素(Mongo 语义);标量字段严格相等', async () => {
    const db = fakeDb(fxOrders())
    const byArray = (await db.collection('orders').where({ categories: 'clean' }).get()).data.map(r => r._id)
    expect(byArray).toEqual(['multi', 'clean-only'])
    const byScalar = (await db.collection('orders').where({ category: 'clean' }).get()).data.map(r => r._id)
    expect(byScalar).toEqual(['clean-only'])
  })

  test('in 命中数组任一元素:跨字段或可让"只会清洗"的师傅命中 [维修,清洗] 的单', async () => {
    const db = fakeDb(fxOrders())
    const _ = db.command
    const r = (await db.collection('orders').where(_.or([
      { category: _.in(['clean']) },
      { categories: _.in(['clean']) }
    ])).get()).data.map(x => x._id)
    expect(r).toEqual(['multi', 'clean-only'])   // 老单 category=clean 与新单 categories 含 clean 都命中
  })

  test('顶层 and 组合等值对象与 or 子条件(订单池查询形状);and 收窄不放行', async () => {
    const db = fakeDb(fxOrders())
    const _ = db.command
    const r = (await db.collection('orders').where(_.and([
      { status: 'published' },
      _.or([{ category: _.in(['clean']) }, { categories: _.in(['clean']) }])
    ])).get()).data.map(x => x._id)
    expect(r).toEqual(['multi', 'clean-only'])

    const r2 = (await db.collection('orders').where(_.and([
      { status: 'accepted' },
      _.or([{ category: _.in(['clean']) }, { categories: _.in(['clean']) }])
    ])).get()).data
    expect(r2).toEqual([])
  })

  test('or 的两个分支都不命中则整条不命中(能力无交集的师傅看不到单)', async () => {
    const db = fakeDb(fxOrders())
    const _ = db.command
    const r = (await db.collection('orders').where(_.or([
      { category: _.in(['move']) },
      { categories: _.in(['move']) }
    ])).get()).data
    expect(r).toEqual([])
  })
})
