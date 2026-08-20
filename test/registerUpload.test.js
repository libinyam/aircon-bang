// registerUpload 上传登记:归属/场景/清单形状校验 + pending 日志落库
const { fakeDb } = require('./stubs/fakeDb')

async function callRegister(event, fx = {}, ctx) {
  jest.resetModules()
  global.__mockDb = fakeDb(fx)
  if (ctx) global.__mockCtx = ctx
  const { main } = require('../cloudfunctions/registerUpload/index')
  const res = await main(event)
  delete global.__mockDb
  delete global.__mockCtx
  return { res, fx }
}

const OID = 'test-openid' // wx-server-sdk 桩的默认 OPENID
const ownOrder = (n) => `cloud://env.x/orders/${OID}/${n}.jpg`
const ownQual = (n) => `cloud://env.x/quals/${OID}/${n}.png`
const ownListing = (n) => `cloud://env.x/listings/${OID}/${n}.jpg`
const ownAvatar = (n) => `cloud://env.x/avatars/${OID}/${n}.jpg`

test('order 场景:本人命名空间的图片清单登记为 pending', async () => {
  const { res, fx } = await callRegister({ scene: 'order', fileIDs: [ownOrder(1), ownOrder(2)] })
  expect(res.ok).toBe(true)
  expect(fx.upload_logs).toHaveLength(1)
  expect(fx.upload_logs[0]).toMatchObject({
    openid: OID, scene: 'order', status: 'pending', fileIDs: [ownOrder(1), ownOrder(2)]
  })
  expect(fx.upload_logs[0].createdAt).toBeInstanceOf(Date)
})

test('qual 场景:quals 命名空间同样可登记', async () => {
  const { res, fx } = await callRegister({ scene: 'qual', fileIDs: [ownQual(1)] })
  expect(res.ok).toBe(true)
  expect(fx.upload_logs[0].scene).toBe('qual')
})

test('listing 场景:商品图片命名空间可登记(买空调频道)', async () => {
  const { res, fx } = await callRegister({ scene: 'listing', fileIDs: [ownListing(1), ownListing(2)] })
  expect(res.ok).toBe(true)
  expect(fx.upload_logs[0]).toMatchObject({ scene: 'listing', status: 'pending' })
})

test('avatar 场景:展示头像命名空间可登记', async () => {
  const { res, fx } = await callRegister({ scene: 'avatar', fileIDs: [ownAvatar(1)] })
  expect(res.ok).toBe(true)
  expect(fx.upload_logs[0]).toMatchObject({ scene: 'avatar', status: 'pending' })
})

test('拒绝:avatar 场景配其他命名空间(场景与命名空间必须一致)', async () => {
  for (const fid of [ownOrder(1), ownQual(1), ownListing(1)]) {
    const { res, fx } = await callRegister({ scene: 'avatar', fileIDs: [fid] })
    expect(res.ok).toBe(false)
    expect(fx.upload_logs || []).toHaveLength(0)
  }
})

test('拒绝:qual/order 文件报 listing 场景(场景与命名空间必须一致)', async () => {
  for (const fid of [ownQual(1), ownOrder(1)]) {
    const { res, fx } = await callRegister({ scene: 'listing', fileIDs: [fid] })
    expect(res.ok).toBe(false)
    expect(fx.upload_logs || []).toHaveLength(0)
  }
})

test('拒绝:未知场景 / 空清单 / 超过6个 / 非数组', async () => {
  for (const event of [
    { scene: 'unknown-scene', fileIDs: [ownOrder(1)] },
    { scene: 'order', fileIDs: [] },
    { scene: 'order', fileIDs: Array.from({ length: 7 }, (_, i) => ownOrder(i)) },
    { scene: 'order', fileIDs: 'not-an-array' },
    { scene: 'order' }
  ]) {
    const { res, fx } = await callRegister(event)
    expect(res.ok).toBe(false)
    expect(fx.upload_logs || []).toHaveLength(0)
  }
})

test('拒绝:他人命名空间 / 场景与命名空间不符 / 非图片扩展名', async () => {
  for (const fid of [
    'cloud://env.x/orders/other-openid/1.jpg', // 他人文件,不能替人"预约删除"
    ownQual(1),                                // qual 文件报 order 场景
    `cloud://env.x/orders/${OID}/1.gif`,       // 扩展名白名单外
    123                                        // 非字符串
  ]) {
    const { res, fx } = await callRegister({ scene: 'order', fileIDs: [ownOrder(0), fid] })
    expect(res.ok).toBe(false)
    expect(fx.upload_logs || []).toHaveLength(0)
  }
})
