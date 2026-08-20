// 集合名清单一致性守护:唯一源 _shared/collections.js
// 1) login/admin 消费共享清单,不得再各自硬编码
// 2) 全库源码里 db.collection('xxx') 引用到的集合必须都在清单里(config 手动创建除外)
//    ——将来加集合(如点数制 points_logs)只改母本一处,漏改这里会红
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', 'cloudfunctions')
const { AUTO_COLLECTIONS } = require('../cloudfunctions/_shared/collections')

// config 需手动创建并填 adminOpenids/模板ID,自动建空集合会掩盖漏配,故排除在自动清单外
const MANUAL_COLLECTIONS = ['config']

test('login 与 admin 都消费共享清单,无本地硬编码集合数组', () => {
  for (const fn of ['login', 'admin']) {
    const src = fs.readFileSync(path.join(ROOT, fn, 'index.js'), 'utf8')
    expect(src).toMatch(/require\('\.\/collections'\)/)
    // 不允许再出现"['users', 'masters', ..."式的本地清单
    expect(src).not.toMatch(/\[\s*'users',\s*'masters'/)
  }
})

test('源码引用的所有集合都在清单内(唯一源不漏项)', () => {
  const known = new Set([...AUTO_COLLECTIONS, ...MANUAL_COLLECTIONS])
  const referenced = new Set()
  for (const dir of fs.readdirSync(ROOT)) {
    const f = path.join(ROOT, dir, 'index.js')
    if (!fs.existsSync(f)) continue
    const src = fs.readFileSync(f, 'utf8')
    for (const m of src.matchAll(/\.collection\('([^']+)'\)/g)) referenced.add(m[1])
  }
  // 断言双向:引用的都登记过;清单里也没有已无人引用的僵尸项
  expect([...referenced].filter(n => !known.has(n))).toEqual([])
  expect(AUTO_COLLECTIONS.filter(n => !referenced.has(n))).toEqual([])
})
