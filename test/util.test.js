// utils/util.js 纯函数表驱动单测
const { formatTime, formatDate, relTime, distanceKm, parseCity, isValidPhone, mergeById, imageExt } = require('../miniprogram/utils/util')

describe('parseCity', () => {
  test.each([
    ['广东省广州市天河区体育西路', '广州市'],
    ['广州市天河区体育西路', '广州市'],
    ['新疆维吾尔自治区乌鲁木齐市天山区', '乌鲁木齐市'],
    ['湖南省湘西土家族苗族自治州吉首市', '湘西土家族苗族自治州'],
    ['内蒙古自治区锡林郭勒盟锡林浩特市', '锡林郭勒盟'],
    ['某地某村委会1号', ''],
    ['', ''],
    [null, '']
  ])('%s -> %s', (input, expected) => {
    expect(parseCity(input)).toBe(expected)
  })
})

describe('isValidPhone', () => {
  test.each([
    ['13800138000', true],
    ['19912345678', true],
    ['12345678901', false],  // 12开头不是手机段
    ['1380013800', false],   // 10位
    ['138001380000', false], // 12位
    ['a3800138000', false],
    ['', false]
  ])('%s -> %s', (input, expected) => {
    expect(isValidPhone(input)).toBe(expected)
  })
})

describe('distanceKm', () => {
  test('同一点距离为0', () => {
    expect(distanceKm(23.13, 113.26, 23.13, 113.26)).toBeCloseTo(0)
  })
  test('广州塔到北京天安门约1890km(误差<2%)', () => {
    const d = distanceKm(23.1066, 113.3245, 39.9042, 116.4074)
    expect(d).toBeGreaterThan(1850)
    expect(d).toBeLessThan(1930)
  })
  test('纬度差0.01度约1.1km', () => {
    expect(distanceKm(23.13, 113.26, 23.14, 113.26)).toBeCloseTo(1.11, 1)
  })
})

describe('formatTime / formatDate', () => {
  const t = new Date(2026, 6, 26, 14, 30) // 2026-07-26 14:30 本地时区
  test('formatTime 输出 MM-DD HH:mm', () => expect(formatTime(t)).toBe('07-26 14:30'))
  test('formatDate 输出 YYYY-MM-DD', () => expect(formatDate(t)).toBe('2026-07-26'))
  test.each([[null], [''], ['not-a-date']])('非法输入 %s 返回空串', (input) => {
    expect(formatTime(input)).toBe('')
    expect(formatDate(input)).toBe('')
  })
})

describe('mergeById 分页去重', () => {
  const a = { _id: 'a' }, b = { _id: 'b' }, c = { _id: 'c' }
  test('追加去重:新页里已存在的 _id 被丢弃,顺序保持', () => {
    expect(mergeById([a, b], [{ _id: 'b', changed: true }, c])).toEqual([a, b, c])
  })
  test('空旧列表/空新页都安全', () => {
    expect(mergeById([], [a])).toEqual([a])
    expect(mergeById([a], [])).toEqual([a])
  })
})

describe('relTime', () => {
  test('30秒前 -> 刚刚', () => expect(relTime(new Date(Date.now() - 30 * 1000))).toBe('刚刚'))
  test('5分钟前', () => expect(relTime(new Date(Date.now() - 5 * 60 * 1000))).toBe('5分钟前'))
  test('3小时前', () => expect(relTime(new Date(Date.now() - 3 * 3600 * 1000))).toBe('3小时前'))
  test('超过24小时显示日期', () => {
    expect(relTime(new Date(Date.now() - 48 * 3600 * 1000))).toMatch(/^\d{2}-\d{2}$/)
  })
})

describe('imageExt 上传扩展名派生', () => {
  test.each([
    ['wxfile://tmp/abc.png', 'png'],
    ['wxfile://tmp/abc.PNG', 'png'],
    ['wxfile://tmp/abc.jpeg', 'jpeg'],
    ['wxfile://tmp/abc.jpg', 'jpg'],
    ['wxfile://tmp/abc.heic', 'jpg'],  // 白名单外回退,与后端 jpg/jpeg/png 校验口径一致
    ['wxfile://tmp/noext', 'jpg'],
    ['', 'jpg'],
    [undefined, 'jpg']
  ])('%s -> %s', (input, expected) => {
    expect(imageExt(input)).toBe(expected)
  })
})
