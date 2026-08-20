// WXML 插值表达式守护:模板 {{}} 只支持三元/算术/逻辑/数据路径运算,不支持函数调用
// 开发者工具模拟器对方法调用较宽容,真机直接渲染失败且无报错(入驻页品类选中态曾因 indexOf 失效,
// 表现为"点击没反应")。选中态一律用「字典 + 数据路径取值」写法,如 catOn[item.key]
const fs = require('fs')
const path = require('path')

function walkWxml(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => {
    const p = path.join(dir, d.name)
    if (d.isDirectory()) return walkWxml(p)
    return p.endsWith('.wxml') ? [p] : []
  })
}

test('WXML 插值表达式不调用数组/对象方法(真机不渲染,选中态用数据路径映射)', () => {
  const root = path.join(__dirname, '..', 'miniprogram')
  const offenders = []
  for (const file of walkWxml(root)) {
    const src = fs.readFileSync(file, 'utf8')
    const hits = src.match(/\{\{[^}]*\.(indexOf|includes|find|filter|map|some|every|join|slice|keys|values)\([^}]*\}\}/g)
    if (hits) offenders.push(path.relative(root, file) + ' -> ' + hits.join(' | '))
  }
  expect(offenders).toEqual([])
})
