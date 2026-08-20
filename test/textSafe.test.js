// textSafe fail-open 三分支单测 + _shared 母本/副本一致性守护
const fs = require('fs')
const path = require('path')
const makeTextSafe = require('../cloudfunctions/_shared/textSafe')
const { MAP, ROOT } = require('../scripts/sync-shared')

function cloudWithCheck(impl) {
  return { openapi: { security: { msgSecCheck: impl } } }
}

describe('textSafe fail-open 策略', () => {
  test('空内容直接放行,不调接口', async () => {
    const spy = jest.fn()
    expect(await makeTextSafe(cloudWithCheck(spy))('')).toBe(true)
    expect(spy).not.toHaveBeenCalled()
  })

  test('检测通过 -> 放行', async () => {
    const ts = makeTextSafe(cloudWithCheck(async () => ({ errCode: 0 })))
    expect(await ts('正常的维修描述')).toBe(true)
  })

  test('命中违规(errCode 87014)-> 拦截', async () => {
    const ts = makeTextSafe(cloudWithCheck(async () => { throw { errCode: 87014 } }))
    expect(await ts('违规内容')).toBe(false)
  })

  test('errMsg 含 87014(SDK 有时只给文本)-> 拦截', async () => {
    const ts = makeTextSafe(cloudWithCheck(async () => {
      throw { errMsg: 'openapi.security.msgSecCheck:fail 87014 risky content' }
    }))
    expect(await ts('违规内容')).toBe(false)
  })

  test('接口自身异常(超时/未配置)-> 放行,不拦用户', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const ts = makeTextSafe(cloudWithCheck(async () => { throw { errCode: -1, errMsg: 'timeout' } }))
    expect(await ts('正常内容')).toBe(true)
    expect(errSpy).toHaveBeenCalled() // 放行但要留错误日志
    errSpy.mockRestore()
  })
})

describe('_shared 母本与云函数目录副本一致(验收:单独改任一副本即失败)', () => {
  const cases = []
  for (const [file, targets] of Object.entries(MAP)) {
    for (const t of targets) cases.push([`${t}/${file}`, file, t])
  }
  test.each(cases)('%s == _shared 母本', (_label, file, t) => {
    const master = fs.readFileSync(path.join(ROOT, '_shared', file), 'utf8')
    const copy = fs.readFileSync(path.join(ROOT, t, file), 'utf8')
    expect(copy).toBe(master)
  })
})
