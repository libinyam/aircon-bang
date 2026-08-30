// 转发分享守护(2026-07 修复"推荐给朋友不好使"后补的回归闸)
// 三类真实故障,静态可查:
// 1) onShareAppMessage 不给 imageUrl:微信自动截取当前页面当封面。
//    "我的"页截出师傅头像+真名+评分+接单数,"接单大厅"截出他人订单地址 —— 隐私外泄。
// 2) open-type="share" 的 button 没有 hover-class:微信的 hover-class 只作用于被按下的
//    组件自身,子元素被按下不会让父 view 进 hover 态。曾把透明 button 覆盖在带 hover-class
//    的 view 上,结果整行零按压反馈,被当成"功能坏了"(mine 页分享行)。
// 3) 分享文案散落各页:改一次文案要动 5 个文件。唯一源 = utils/config.js 的 SHARE/SHARE_COVER。
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', 'miniprogram')
const config = require(path.join(ROOT, 'utils', 'config.js'))
const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'))

function listPages(dir = path.join(ROOT, 'pages'), acc = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    if (fs.statSync(p).isDirectory()) listPages(p, acc)
    else if (name.endsWith('.js')) acc.push(p)
  }
  return acc
}

// 取 onShareAppMessage 的函数体(大括号配平,避免正则跨方法误伤)
function shareBody(src) {
  const at = src.indexOf('onShareAppMessage')
  if (at < 0) return null
  const open = src.indexOf('{', at)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1)
  }
  return null
}

// 包内图片尺寸(不引三方库:JPEG 读 SOF 段,PNG 读 IHDR)
function imageSize(file) {
  const b = fs.readFileSync(file)
  if (b[0] === 0x89 && b[1] === 0x50) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
  let i = 2
  while (i < b.length - 9) {
    if (b[i] !== 0xFF) { i++; continue }
    const m = b[i + 1]
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
      return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) }
    }
    i += 2 + b.readUInt16BE(i + 2)
  }
  return null
}

const sharePages = listPages().filter(f => shareBody(fs.readFileSync(f, 'utf8')))

test('分享页基线:五个分享入口都在(新增分享入口须在此登记)', () => {
  const names = sharePages.map(f => path.basename(f)).sort()
  expect(names).toEqual(['index.js', 'listingDetail.js', 'market.js', 'mine.js', 'pool.js'])
})

test('onShareAppMessage 必须显式给 imageUrl(留空=微信截当前页面,泄露真名/他人订单)', () => {
  const offenders = sharePages
    .filter(f => !/imageUrl\s*:/.test(shareBody(fs.readFileSync(f, 'utf8'))))
    .map(f => path.relative(ROOT, f))
  expect(offenders).toEqual([])
})

test('分享标题走 config.SHARE 唯一源,页面里不写裸文案', () => {
  const offenders = sharePages
    .filter(f => !/config\.SHARE/.test(shareBody(fs.readFileSync(f, 'utf8'))))
    .map(f => path.relative(ROOT, f))
  expect(offenders).toEqual([])
})

test('SHARE 结构完整:每个场景都有非空标题', () => {
  expect(Object.keys(config.SHARE).sort()).toEqual(['home', 'listing', 'market', 'recruit'])
  for (const [key, s] of Object.entries(config.SHARE)) {
    expect(typeof s.title).toBe('string')
    expect(s.title.trim().length).toBeGreaterThan(0)
    // listing 的路径由商品 id 动态拼,不在 config 里
    if (key !== 'listing') expect(s.path).toMatch(/^\/pages\//)
  }
})

test('SHARE 的 path 指向 app.json 已注册页面(未注册=好友点开白屏)', () => {
  const registered = appJson.pages
  const bad = Object.values(config.SHARE)
    .filter(s => s.path)
    .map(s => s.path.replace(/^\//, '').split('?')[0])
    .filter(p => !registered.includes(p))
  expect(bad).toEqual([])
})

test('SHARE_COVER 是存在的包内图片,且为微信分享卡片的 5:4', () => {
  expect(config.SHARE_COVER).toMatch(/^\/(assets|images)\/.+\.(jpg|jpeg|png)$/i)
  const file = path.join(ROOT, config.SHARE_COVER.replace(/^\//, ''))
  expect(fs.existsSync(file)).toBe(true)
  const size = imageSize(file)
  expect(size).not.toBeNull()
  // 微信按 5:4 裁切,偏差超 3% 会被裁掉主体
  expect(Math.abs(size.w / size.h - 1.25)).toBeLessThan(0.0375)
  // 分享封面进主包,超 300KB 挤占 2MB 主包预算
  expect(fs.statSync(file).size).toBeLessThan(300 * 1024)
})

test('HERO_IMAGE 若用包内路径则文件必须存在(缺失会静默回退渐变版,难以发现)', () => {
  if (config.HERO_IMAGE && config.HERO_IMAGE.startsWith('/')) {
    expect(fs.existsSync(path.join(ROOT, config.HERO_IMAGE.replace(/^\//, '')))).toBe(true)
  }
})

describe('open-type="share" 按钮', () => {
  const wxmls = []
 ;(function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name)
      if (fs.statSync(p).isDirectory()) walk(p)
      else if (name.endsWith('.wxml')) wxmls.push(p)
    }
  })(ROOT)

  const buttons = wxmls.flatMap(file => {
    const src = fs.readFileSync(file, 'utf8')
    return (src.match(/<button[^>]*open-type="share"[^>]*>/g) || []).map(tag => ({ file, tag }))
  })

  test('分享按钮存在,且只出现在有 onShareAppMessage 的页面(否则点击无反应)', () => {
    expect(buttons.length).toBeGreaterThan(0)
    const offenders = buttons
      .filter(({ file }) => !shareBody(fs.readFileSync(file.replace(/\.wxml$/, '.js'), 'utf8')))
      .map(({ file }) => path.relative(ROOT, file))
    expect(offenders).toEqual([])
  })

  test('分享按钮必须自带 hover-class(否则整行零按压反馈,用户判定为功能失效)', () => {
    const offenders = buttons
      .filter(({ tag }) => !/hover-class="/.test(tag))
      .map(({ file, tag }) => path.relative(ROOT, file) + ' -> ' + tag)
    expect(offenders).toEqual([])
  })

  test('不再用透明 button 覆盖层触发分享(该姿势下父 view 的 hover-class 不生效)', () => {
    const offenders = [...wxmls, ...wxmls.map(f => f.replace(/\.wxml$/, '.wxss'))]
      .filter(f => fs.existsSync(f) && /share-overlay/.test(fs.readFileSync(f, 'utf8')))
      .map(f => path.relative(ROOT, f))
    expect(offenders).toEqual([])
  })
})

test('mine 分享行的 hover 底色已提权(页面 wxss 后加载,单类选择器会顶掉 app.wxss 的 .hv-cell)', () => {
  const wxss = fs.readFileSync(path.join(ROOT, 'pages', 'mine', 'mine.wxss'), 'utf8')
  expect(/\.share-cell\s*\{[^}]*background:\s*transparent/.test(wxss)).toBe(true)
  expect(/\.share-cell\.hv-cell\s*\{[^}]*background:/.test(wxss)).toBe(true)
})

// button 必须是分享行的本体(见文件头第 2 条),但 button 组件自带的居中布局
// (左右内边距 + margin auto + 居中对齐)优先级高于页面的普通类选择器:行内容被收成
// 居中一坨,图标往右挪、箭头往左缩,跟上下几行差一大截(2026-08「推荐给朋友没有对齐」)。
// 这一版在浏览器里量过:普通优先级写法下图标偏 114px、箭头偏 -114px;把左右三项提到
// !important 并让里层行撑满后,两种容器类型下偏移都归零。所以下面三条缺一不可。
test('mine 分享行的左右布局已提权,且里层 .cell 撑满整行', () => {
  const wxml = fs.readFileSync(path.join(ROOT, 'pages', 'mine', 'mine.wxml'), 'utf8')
  const wxss = fs.readFileSync(path.join(ROOT, 'pages', 'mine', 'mine.wxss'), 'utf8')

  const btn = wxml.match(/<button[^>]*\bclass="[^"]*share-cell[^"]*"[\s\S]*?<\/button>/)
  expect(btn).toBeTruthy()
  // button 本体不能直接挂 .cell:那样行布局被组件样式接管,又回到错位
  expect(btn[0].match(/class="([^"]*)"/)[1].trim().split(/\s+/)).not.toContain('cell')
  expect(/<view class="cell">/.test(btn[0])).toBe(true)

  const rule = wxss.match(/\.share-cell\s*\{([^}]*)\}/)
  expect(rule).toBeTruthy()
  // 决定左右位置与行宽的五项都必须带 !important:普通优先级打不过 button 自带样式。
  // display/width 曾漏掉提权 → 按钮被收成内容宽度,箭头到不了右缘(2026-08 二次返工)
  for (const prop of ['display', 'width', 'justify-content', 'padding', 'margin']) {
    expect(new RegExp(prop + ':[^;]*!important').test(rule[1])).toBe(true)
  }
  // 里层行要在 block/flex 两种容器下都撑满,故 width 与 flex 都得给,且同样要提权
  const inner = wxss.match(/\.share-cell\s+\.cell\s*\{([^}]*)\}/)
  expect(inner).toBeTruthy()
  expect(/width:\s*100%[^;]*!important/.test(inner[1])).toBe(true)
  expect(/flex:\s*1[^;]*!important/.test(inner[1])).toBe(true)
  // 箭头必须靠 margin-left:auto 顶到右缘:button 里文字撑不开,光靠 .cell-t 的
  // flex 会让箭头紧挨文字停住(2026-08「箭头没放在最右端」)
  const chev = wxss.match(/\.share-cell\s+\.ic-chev\s*\{([^}]*)\}/)
  expect(chev).toBeTruthy()
  expect(/margin-left:\s*auto[^;]*!important/.test(chev[1])).toBe(true)
  // 里层 .cell 是 button 的独子 → 命中 .cell:last-child::after 被抹掉,须显式恢复
  expect(/\.share-cell\s+\.cell::after\s*\{[^}]*display:\s*block/.test(wxss)).toBe(true)
})

// 功能列表的图标必须来自双色调家族。
// 「我的上架」曾直接复用 tabBar 的 .ic-tab-shop(整体 #A9B1BD 灰态),在白卡上比左侧邻居
// 淡一大截,被判定为"图标太淡"(2026-08)。灰态类是 tabBar 未选中专用,不进列表行。
test('mine 功能列表不使用 tabBar 灰态图标(白卡上明显偏淡)', () => {
  const wxml = fs.readFileSync(path.join(ROOT, 'pages', 'mine', 'mine.wxml'), 'utf8')
  const offenders = (wxml.match(/class="[^"]*\bcell-ic\b[^"]*"/g) || [])
    .map(cls => cls.match(/class="([^"]*)"/)[1].trim().split(/\s+/))
    .filter(names => names.some(n => /^ic-tab-/.test(n) || /-g$/.test(n)))
    .map(names => names.join(' '))
  expect(offenders).toEqual([])
})

// 上面都是静态文本检查(正则能被绕过)。这里真的把页面模块 require 进来执行
// onShareAppMessage,断言返回的转发卡片对象本身合法 —— 这才是用户实际看到的东西。
describe('onShareAppMessage 真实执行', () => {
  const load = pageFile => {
    let captured = null
    global.Page = cfg => { captured = cfg }
    global.Component = cfg => { captured = cfg }
    global.getApp = () => ({
      globalData: { openid: 'o_test', statusBarHeight: 44 },
      getUser: async () => ({ user: {}, master: null }),
      isApprovedMaster: () => false
    })
    global.wx = {
      cloud: { getTempFileURL: async () => ({ fileList: [] }), callFunction: async () => ({ result: {} }), uploadFile: async () => ({}) },
      showToast() {}, showLoading() {}, hideLoading() {}, navigateTo() {}, switchTab() {},
      makePhoneCall() {}, setClipboardData() {}, previewImage() {}, requestSubscribeMessage() {},
      stopPullDownRefresh() {}, chooseMedia: async () => ({ tempFiles: [] }),
      getSystemInfoSync: () => ({ statusBarHeight: 44 })
    }
    delete require.cache[require.resolve(pageFile)]
    require(pageFile)
    return captured
  }

  for (const file of sharePages) {
    const name = path.relative(ROOT, file).replace(/\\/g, '/')
    test(`${name} 返回合法转发卡片`, () => {
      const page = load(file)
      const card = page.onShareAppMessage.call({ data: Object.assign({}, page.data), setData() {} })
      // 标题:微信卡片单行约 20 字,超了会截断成"..."
      expect(typeof card.title).toBe('string')
      expect(card.title.trim().length).toBeGreaterThan(0)
      expect(card.title.length).toBeLessThanOrEqual(24)
      expect(card.path).toMatch(/^\/pages\//)
      expect(card.imageUrl).toBeTruthy()
      // 包内封面必须真实存在,否则微信静默回退成页面截图(又回到隐私外泄)
      if (card.imageUrl.startsWith('/')) {
        expect(fs.existsSync(path.join(ROOT, card.imageUrl.slice(1)))).toBe(true)
      }
    })
  }
})
