// 品牌名一致性守护
// 品牌名散落在三类地方,漂移过一次(导航栏已改而首页字标/协议未同步):
// 1) utils/config.js 的 BRAND_NAME —— 唯一源,JS/WXML 一律引它
// 2) app.json 与各页 .json 的 navigationBarTitleText —— 纯 JSON 读不到 JS,只能靠本测试锁
// 3) design/ 下的字标 HTML —— 渲染成 PNG 后是像素,改名后必须重新渲染(测试只管 HTML 源)
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const MP = path.join(ROOT, 'miniprogram')
const config = require(path.join(MP, 'utils', 'config.js'))
const BRAND = config.BRAND_NAME

// 历史名称(更名后不得再出现)
const STALE = [/空调快修(?!帮)/, /空调快修帮/]

function walk(dir, exts, acc = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = path.join(dir, name)
    if (fs.statSync(p).isDirectory()) walk(p, exts, acc)
    else if (exts.some(e => name.endsWith(e))) acc.push(p)
  }
  return acc
}

test('BRAND_NAME 已填写', () => {
  expect(typeof BRAND).toBe('string')
  expect(BRAND.trim().length).toBeGreaterThan(0)
})

test('navigationBarTitleText 与 BRAND_NAME 一致(纯 JSON 读不到 config.js,只能靠这条锁)', () => {
  const app = JSON.parse(fs.readFileSync(path.join(MP, 'app.json'), 'utf8'))
  expect(app.window.navigationBarTitleText).toBe(BRAND)
  // 自定义导航的首页也带标题(分享/收藏时显示)
  const index = JSON.parse(fs.readFileSync(path.join(MP, 'pages', 'index', 'index.json'), 'utf8'))
  expect(index.navigationBarTitleText).toBe(BRAND)
})

test('小程序内不残留历史品牌名(界面/协议文案一律走 config.BRAND_NAME)', () => {
  const offenders = []
  for (const file of walk(MP, ['.js', '.json', '.wxml', '.wxss'])) {
    const src = fs.readFileSync(file, 'utf8')
    for (const re of STALE) {
      if (re.test(src)) offenders.push(path.relative(ROOT, file) + ' -> ' + re)
    }
  }
  expect(offenders).toEqual([])
})

test('协议页运营主体声明引用 BRAND_NAME 而非裸字符串(协议主体名错=效力存疑)', () => {
  const src = fs.readFileSync(path.join(MP, 'pages', 'agreement', 'agreement.js'), 'utf8')
  expect(src).toMatch(/config\.BRAND_NAME/)
})

test('design/ 字标 HTML 源已同步改名(PNG 是像素,需另行重新渲染)', () => {
  const dir = path.join(ROOT, 'design')
  if (!fs.existsSync(dir)) return
  const offenders = walk(dir, ['.html'])
    .filter(f => STALE.some(re => re.test(fs.readFileSync(f, 'utf8'))))
    .map(f => path.relative(ROOT, f))
  expect(offenders).toEqual([])
})
