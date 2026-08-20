// 结构化日志:输出格式契约 + 关键函数采用守护
const fs = require('fs')
const path = require('path')

const makeLogger = require('../cloudfunctions/_shared/logger')

function capture(method, fn) {
  const lines = []
  const spy = jest.spyOn(console, method).mockImplementation((s) => lines.push(s))
  try { fn() } finally { spy.mockRestore() }
  return lines.map(l => JSON.parse(l))
}

describe('输出格式', () => {
  const log = makeLogger('testFn')

  test('info:单行 JSON,含 level/fn/msg/ts 与业务字段', () => {
    const [line] = capture('log', () => log.info('grab success', { orderId: 'o1', openid: 'u1', ms: 42 }))
    expect(line).toMatchObject({ level: 'info', fn: 'testFn', msg: 'grab success', orderId: 'o1', openid: 'u1', ms: 42 })
    expect(new Date(line.ts).getTime()).not.toBeNaN()
  })

  test('error:原生 Error 与微信云开发错误对象都能序列化', () => {
    const [a] = capture('error', () => log.error('boom', { orderId: 'o1' }, new Error('native fail')))
    expect(a.err).toEqual({ errMsg: 'native fail' })
    const [b] = capture('error', () => log.error('boom', {}, { errCode: 87014, errMsg: 'risky content' }))
    expect(b.err).toEqual({ errCode: 87014, errMsg: 'risky content' })
  })

  test('warn 走 console.warn;省略 fields/err 不报错', () => {
    const [line] = capture('warn', () => log.warn('heads up'))
    expect(line).toMatchObject({ level: 'warn', fn: 'testFn', msg: 'heads up' })
    expect(line.err).toBeUndefined()
  })

  test('不可序列化字段(循环引用)降级输出,不抛错', () => {
    const cyc = {}; cyc.self = cyc
    const [line] = capture('log', () => log.info('weird', { cyc }))
    expect(line).toMatchObject({ level: 'info', fn: 'testFn', msg: 'weird' })
    expect(line.logError).toBeTruthy()
  })
})

describe('采用守护:关键函数已迁移( 验收)', () => {
  const read = (fn) => fs.readFileSync(path.join(__dirname, '..', 'cloudfunctions', fn, 'index.js'), 'utf8')

  test.each(['grabOrder', 'publishOrder', 'cronTimeout', 'publishListing', 'getListings', 'updateListing'])('%s 使用 logger 且无裸 console.*', (fn) => {
    const src = read(fn)
    expect(src).toMatch(/require\('\.\/logger'\)/)
    expect(src).not.toMatch(/console\.(log|warn|error)/)
  })

  test('订单相关日志带 orderId 关联键(全链路检索的前提)', () => {
    for (const fn of ['grabOrder', 'publishOrder']) {
      expect(read(fn)).toMatch(/log\.(info|warn|error)\('[^']+',\s*\{[^}]*orderId/)
    }
  })

  test('商品相关日志带 listingId 关联键(买空调频道同口径)', () => {
    for (const fn of ['publishListing', 'getListings', 'updateListing']) {
      expect(read(fn)).toMatch(/log\.(info|warn|error)\('[^']+',\s*\{[^}]*listingId/)
    }
  })
})
