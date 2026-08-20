// _shared/bizNo 业务编号生成:格式、时区、crypto 随机、查重重试
const { makeBizNo, nextBizNo, MAX_ATTEMPTS } = require('../cloudfunctions/_shared/bizNo')

// 2026-08-08 06:00 UTC = 北京 2026-08-08 14:00
const NOW_UTC = Date.UTC(2026, 7, 8, 6, 0)

describe('makeBizNo 格式与随机空间', () => {
  test('前缀+北京时间年月日时分+8位数字后缀;注入 rand 可复现', () => {
    expect(makeBizNo('AC', NOW_UTC, () => 42)).toBe('AC2608081400-00000042')
    expect(makeBizNo('GD', NOW_UTC, () => 42)).toBe('GD2608081400-00000042')
  })

  test('默认 crypto 随机:后缀落在 8 位数字空间内', () => {
    for (let i = 0; i < 200; i++) {
      const m = makeBizNo('AC', NOW_UTC).match(/^AC2608081400-(\d{8})$/)
      expect(m).not.toBeNull()
      expect(Number(m[1])).toBeLessThan(1e8)
    }
  })

  test('randomBytes 兜底:randomInt 不可用的旧运行时仍生成合法编号', () => {
    const crypto = require('crypto')
    const orig = crypto.randomInt
    crypto.randomInt = undefined
    try {
      for (let i = 0; i < 50; i++) {
        const m = makeBizNo('AC', NOW_UTC).match(/^AC2608081400-(\d{8})$/)
        expect(m).not.toBeNull()
        expect(Number(m[1])).toBeLessThan(1e8)
      }
    } finally {
      crypto.randomInt = orig
    }
  })
})

describe('nextBizNo 落库前查重重试', () => {
  test('首候选撞库:换新候选返回,不静默落入重复编号', async () => {
    const existing = new Set(['AC2608081400-00000001'])
    const seq = [1, 2] // 第一次强制撞已存在候选,第二次换新
    let n = 0
    const no = await nextBizNo('AC', async x => existing.has(x), NOW_UTC, () => seq[n++])
    expect(no).toBe('AC2608081400-00000002')
  })

  test('连续撞满 MAX_ATTEMPTS:返回 null 让调用方明确失败', async () => {
    let calls = 0
    const no = await nextBizNo('AC', async () => { calls++; return true }, NOW_UTC, () => 1)
    expect(no).toBeNull()
    expect(calls).toBe(MAX_ATTEMPTS)
  })
})

describe('publishOrder/publishListing 共用同一套编号规则', () => {
  test('_internals 包装与共享实现逐字节一致', () => {
    const { makeOrderNo } = require('../cloudfunctions/publishOrder/index')._internals
    const { makeListingNo } = require('../cloudfunctions/publishListing/index')._internals
    expect(makeOrderNo(NOW_UTC, () => 7)).toBe(makeBizNo('AC', NOW_UTC, () => 7))
    expect(makeListingNo(NOW_UTC, () => 7)).toBe(makeBizNo('GD', NOW_UTC, () => 7))
  })
})
