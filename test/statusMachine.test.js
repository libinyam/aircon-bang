// 订单状态机守护(,并覆盖 的字面量漂移防线)
// 三层防护:前后端定义同源 → 流转表与文档一致 → 源码不再出现裸状态字面量
const fs = require('fs')
const path = require('path')

const biz = require('../cloudfunctions/_shared/biz')
const constants = require('../miniprogram/utils/constants')

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8')
const ORDER_LITERALS = ['published', 'accepted', 'pending_confirm', 'completed', 'cancelled']
const LISTING_LITERALS = ['on_sale', 'off_shelf', 'sold', 'removed']

describe('前后端状态定义同源', () => {
  test('biz.STATUS 的值 == 前端 constants.STATUS 的值', () => {
    expect(Object.values(constants.STATUS).sort()).toEqual(Object.values(biz.STATUS).sort())
  })
  test('biz.STATUS 的值 == 前端 ORDER_STATUS 展示表的键', () => {
    expect(Object.keys(constants.ORDER_STATUS).sort()).toEqual(Object.values(biz.STATUS).sort())
  })
  test('ACTIVE_STATUSES 是文档口径的进行中三态', () => {
    expect(biz.ACTIVE_STATUSES.sort()).toEqual(['accepted', 'pending_confirm', 'published'])
  })
})

describe('流转表与状态机设计一致', () => {
  // published → accepted → pending_confirm → completed;前置态可 cancelled;pending_confirm 可驳回退 accepted
  test.each([
    ['published', ['accepted', 'cancelled']],
    ['accepted', ['pending_confirm', 'cancelled']],
    ['pending_confirm', ['completed', 'accepted']],
    ['completed', []],
    ['cancelled', []]
  ])('%s -> %j', (from, tos) => {
    expect(biz.STATUS_FLOW[from].sort()).toEqual(tos.sort())
  })
})

describe('商品状态机同源与流转(买空调频道)', () => {
  test('biz.LISTING_STATUS 的值 == 前端 constants.LISTING_STATUS 的值', () => {
    expect(Object.values(constants.LISTING_STATUS).sort()).toEqual(Object.values(biz.LISTING_STATUS).sort())
  })
  test('biz.LISTING_STATUS 的值 == 前端 LISTING_STATUS_MAP 展示表的键', () => {
    expect(Object.keys(constants.LISTING_STATUS_MAP).sort()).toEqual(Object.values(biz.LISTING_STATUS).sort())
  })
  test('商品状态值与订单状态字面量禁令互不冲突(命名刻意避开)', () => {
    for (const v of Object.values(biz.LISTING_STATUS)) expect(ORDER_LITERALS).not.toContain(v)
    expect(Object.values(biz.LISTING_STATUS).sort()).toEqual([...LISTING_LITERALS].sort())
  })
  // on_sale → off_shelf/sold/removed;off_shelf 可重挂或补标已售;sold/removed 终态
  test.each([
    ['on_sale', ['off_shelf', 'sold', 'removed']],
    ['off_shelf', ['on_sale', 'sold', 'removed']],
    ['sold', []],
    ['removed', []]
  ])('listing %s -> %j', (from, tos) => {
    expect(biz.LISTING_STATUS_FLOW[from].sort()).toEqual(tos.sort())
  })
  test('商品参数枚举 key 双端同源(condition/机型/匹数/成色/年限)', () => {
    expect(constants.CONDITIONS.map(c => c.key)).toEqual(biz.LISTING_ENUMS.CONDITIONS)
    expect(constants.UNIT_TYPES.map(c => c.key)).toEqual(biz.LISTING_ENUMS.UNIT_TYPES)
    expect(constants.HP_OPTIONS.map(c => c.key)).toEqual(biz.LISTING_ENUMS.HP_KEYS)
    expect(constants.USED_GRADES.map(c => c.key)).toEqual(biz.LISTING_ENUMS.USED_GRADES)
    expect(constants.USED_YEARS.map(c => c.key)).toEqual(biz.LISTING_ENUMS.USED_YEARS)
  })
})

describe('云函数源码不再出现裸状态字面量(改状态机只改 biz.js)', () => {
  const FNS = ['publishOrder', 'grabOrder', 'finishOrder', 'confirmOrder', 'cancelOrder',
    'cronTimeout', 'getOrders', 'submitReview', 'admin',
    'publishListing', 'getListings', 'updateListing']
  const bare = new RegExp(`'(${ORDER_LITERALS.join('|')})'`)
  test.each(FNS)('cloudfunctions/%s/index.js', (fn) => {
    expect(read(`cloudfunctions/${fn}/index.js`)).not.toMatch(bare)
  })

  // 商品状态字面量禁令:覆盖商品链路函数(mediaCheckCallback 走 _shared/mediaApply 消费常量)
  const LISTING_FNS = ['publishListing', 'getListings', 'updateListing', 'admin', 'cronTimeout', 'mediaCheckCallback']
  const bareListing = new RegExp(`'(${LISTING_LITERALS.join('|')})'`)
  test.each(LISTING_FNS)('cloudfunctions/%s/index.js 无裸商品状态', (fn) => {
    expect(read(`cloudfunctions/${fn}/index.js`)).not.toMatch(bareListing)
  })
})

describe('前端页面 JS 不出现裸状态字面量(用 constants.STATUS / LISTING_STATUS)', () => {
  const pages = fs.readdirSync(path.join(__dirname, '..', 'miniprogram', 'pages'))
  const bare = new RegExp(`'(${ORDER_LITERALS.join('|')})'`)
  const bareListing = new RegExp(`'(${LISTING_LITERALS.join('|')})'`)
  test.each(pages)('pages/%s', (pg) => {
    const jsPath = `miniprogram/pages/${pg}/${pg}.js`
    if (!fs.existsSync(path.join(__dirname, '..', jsPath))) return
    expect(read(jsPath)).not.toMatch(bare)
    expect(read(jsPath)).not.toMatch(bareListing)
  })
})

describe('WXML 状态字面量必须是合法状态(挡拼写错误)', () => {
  // WXML 无法 require 常量,字面量保留,但比较表达式里的值必须属于五个状态机的全集:
  // 订单(5态)/ 商品(4态,买空调频道)/ 师傅审核(pending/approved/rejected)/ 投诉(open/closed)/
  // 删除工单 open→executed→closed + pending_retry
  const KNOWN = new Set([...ORDER_LITERALS, ...LISTING_LITERALS, 'pending', 'approved', 'rejected', 'open', 'closed',
    'pending_retry', 'executed'])
  const pagesDir = path.join(__dirname, '..', 'miniprogram', 'pages')
  const files = fs.readdirSync(pagesDir)
    .map(pg => `miniprogram/pages/${pg}/${pg}.wxml`)
    .filter(p => fs.existsSync(path.join(__dirname, '..', p)))

  test.each(files)('%s', (file) => {
    const src = read(file)
    const found = []
    for (const re of [/status\s*===?\s*'([^']+)'/g, /'([^']+)'\s*===?\s*[\w.]*[Ss]tatus/g]) {
      let m
      while ((m = re.exec(src))) found.push(m[1])
    }
    for (const lit of found) expect(KNOWN).toContain(lit)
  })
})
