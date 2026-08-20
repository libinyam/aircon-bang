// 隐私接口声明一致性守护
// 微信把隐私接口分两类,处理方式不同:
// 1) 位置/地址类:必须写进 app.json 的 requiredPrivateInfos,且取值只能是下面的合法枚举
//    (塞进别的接口名会直接编译失败"字段需为 chooseAddress,chooseLocation,...",2026-08 实测)
// 2) 其余隐私接口(chooseMedia 等):不进 app.json,在小程序后台《用户隐私保护指引》里
//    声明对应的信息类型与用途;漏声明的表现是真机调用时报"隐私接口未声明"
// 这里静态校验第 1 类的一致性,并锁第 2 类的使用基线——新用了隐私接口必须有人显式表态
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', 'miniprogram')

// requiredPrivateInfos 的合法取值(官方枚举,新增定位类接口时同步维护)
const DECLARABLE_APIS = [
  'chooseAddress', 'chooseLocation', 'choosePoi', 'getFuzzyLocation',
  'getLocation', 'onLocationChange', 'startLocationUpdate', 'startLocationUpdateBackground'
]
// 走后台《用户隐私保护指引》声明的隐私接口(无法静态校验后台配置,只锁使用基线)
const GUIDELINE_APIS = ['chooseMedia', 'chooseImage', 'chooseVideo', 'chooseInvoice', 'chooseInvoiceTitle', 'chooseLicensePlate']

function listJs(dir, acc = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    if (fs.statSync(p).isDirectory()) listJs(p, acc)
    else if (name.endsWith('.js')) acc.push(p)
  }
  return acc
}

function usedApis(apis) {
  const used = new Set()
  for (const file of listJs(ROOT)) {
    const src = fs.readFileSync(file, 'utf8')
    for (const api of apis) {
      if (new RegExp(`wx\\.${api}\\b`).test(src)) used.add(api)
    }
  }
  return [...used].sort()
}

const declared = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'))
  .requiredPrivateInfos || []

test('requiredPrivateInfos 只含合法枚举值(塞错接口名会让整个小程序编译失败)', () => {
  const invalid = declared.filter(v => !DECLARABLE_APIS.includes(v))
  expect(invalid).toEqual([])
})

test('位置/地址类隐私接口:代码里用到的都已在 requiredPrivateInfos 声明', () => {
  const used = usedApis(DECLARABLE_APIS)
  // 当前基线:定位(发单解析城市)+ 地图选点(维修地址)
  expect(used).toEqual(['chooseLocation', 'getLocation'])
  expect(used.filter(api => !declared.includes(api))).toEqual([])
})

test('指引类隐私接口使用基线:变化时须同步小程序后台《用户隐私保护指引》', () => {
  // 当前基线:chooseMedia(订单故障照片 + 师傅身份证/资质证书/营业执照)
  // 新增其他接口(如 chooseAddress)时:先在后台指引声明信息类型与用途,再更新这里的基线
  expect(usedApis(GUIDELINE_APIS)).toEqual(['chooseMedia'])
})
