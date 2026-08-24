// callFn 四分支单测:业务失败弹msg、成功透传、网络异常弹提示、业务失败不重复弹
describe('callFn', () => {
  let toasts, callFunctionImpl, callFn

  beforeEach(() => {
    jest.resetModules()
    toasts = []
    global.wx = {
      cloud: { callFunction: (...args) => callFunctionImpl(...args) },
      showToast: (opt) => toasts.push(opt.title)
    }
    callFn = require('../miniprogram/utils/util').callFn
  })
  afterEach(() => { delete global.wx })

  test('业务失败(ok:false):toast 展示 msg 且 reject', async () => {
    callFunctionImpl = async () => ({ result: { ok: false, msg: '手慢了' } })
    await expect(callFn('grabOrder', {})).rejects.toEqual({ ok: false, msg: '手慢了' })
    expect(toasts).toEqual(['手慢了'])
  })

  test('业务失败无 msg:toast 兜底文案', async () => {
    callFunctionImpl = async () => ({ result: { ok: false } })
    await expect(callFn('x', {})).rejects.toEqual({ ok: false })
    expect(toasts).toEqual(['操作失败'])
  })

  test('成功:透传 result,不弹 toast', async () => {
    callFunctionImpl = async () => ({ result: { ok: true, data: [1, 2] } })
    await expect(callFn('getOrders', {})).resolves.toEqual({ ok: true, data: [1, 2] })
    expect(toasts).toEqual([])
  })

  test('网络异常:toast 网络提示且 reject 原错误', async () => {
    const err = new Error('cloud function timeout')
    callFunctionImpl = async () => { throw err }
    await expect(callFn('publishOrder', {})).rejects.toBe(err)
    expect(toasts).toEqual(['网络异常,请重试'])
  })

  test('业务失败只弹一次:catch 分支不对 ok:false 二次弹 toast', async () => {
    callFunctionImpl = async () => ({ result: { ok: false, msg: '无权查看该订单' } })
    await callFn('getOrders', {}).catch(() => {})
    expect(toasts).toHaveLength(1)
  })

  // silent:后台预热/静默刷新场景——用户没主动发起这次调用,弹错只会打扰
  test('silent 网络异常:不弹 toast 仍 reject 原错误', async () => {
    const err = new Error('cloud function timeout')
    callFunctionImpl = async () => { throw err }
    await expect(callFn('getListings', {}, { silent: true })).rejects.toBe(err)
    expect(toasts).toEqual([])
  })

  test('silent 业务失败:不弹 toast 仍 reject', async () => {
    callFunctionImpl = async () => ({ result: { ok: false, msg: '参数错误' } })
    await expect(callFn('getListings', {}, { silent: true })).rejects.toEqual({ ok: false, msg: '参数错误' })
    expect(toasts).toEqual([])
  })
})
