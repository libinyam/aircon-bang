// 前后端分页契约守护:前端"是否还有下一页"的判断值必须等于后端 limit
// 两边都是魔法数字 20(收敛为常量是 /#52 的活),先用源码断言防止单边改动悄悄破坏翻页
const fs = require('fs')
const path = require('path')

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8')

test('分页契约:后端统一 PAGE_SIZE + 响应带 hasMore,前端不再对比魔法数字', () => {
  const backend = read('cloudfunctions/getOrders/index.js')
  // 后端:分页统一走 PAGE_SIZE 常量,三个列表 action 均返回 hasMore
  expect(backend).toMatch(/const PAGE_SIZE = 20/)
  expect(backend.match(/skip\(page \* PAGE_SIZE\)/g).length).toBeGreaterThanOrEqual(3)
  expect(backend.match(/hasMore: /g).length).toBeGreaterThanOrEqual(3)
  expect(backend).not.toMatch(/skip\(page \* 20\)/)

  // 前端:用服务端 hasMore 判断,禁止 length < 20 式隐性耦合
  for (const page of ['miniprogram/pages/orders/orders.js', 'miniprogram/pages/pool/pool.js']) {
    const src = read(page)
    expect(src).toMatch(/noMore: !res\.hasMore/)
    expect(src).not.toMatch(/length < 20/)
  }
})

test('admin smokePool 的查询条件形状与 getOrders.pool 保持一致', () => {
  const pool = read('cloudfunctions/getOrders/index.js')
  const smoke = read('cloudfunctions/admin/index.js')
  // 两边必须同时具备的过滤维度;改 pool 查询而没同步 smokePool,自检就失去意义
  // 城市维度按归一化匹配键 cityKey,不再按 cityName 字符串严格相等
  for (const cond of ['status: STATUS.PUBLISHED', 'cityKey', '_.neq(', '_.in(', 'publishedAt: _.gt(', 'expectEnd: _.gt(']) {
    expect(pool).toContain(cond)
    expect(smoke).toContain(cond)
  }
  for (const src of [pool, smoke]) {
    expect(src).toMatch(/orderBy\('publishedAt', 'desc'\)/)
    expect(src).toMatch(/48 \* 3600 \* 1000/)
  }
})

test('分页契约:getListings 同口径(买空调频道)', () => {
  const backend = read('cloudfunctions/getListings/index.js')
  expect(backend).toMatch(/const PAGE_SIZE = 20/)
  expect(backend.match(/skip\(page \* PAGE_SIZE\)/g).length).toBeGreaterThanOrEqual(2)
  expect(backend.match(/hasMore: /g).length).toBeGreaterThanOrEqual(2)
  expect(backend).not.toMatch(/skip\(page \* 20\)/)

  // 前端市场/我的上架:用服务端 hasMore 判断,禁止 length < 20 式隐性耦合
  for (const page of ['miniprogram/pages/market/market.js', 'miniprogram/pages/myListings/myListings.js']) {
    const src = read(page)
    expect(src).toMatch(/noMore: !res\.hasMore/)
    expect(src).not.toMatch(/length < 20/)
  }
})
