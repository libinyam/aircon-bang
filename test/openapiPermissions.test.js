// OpenAPI 权限声明守护:云函数代码里调用了 cloud.openapi.X.Y,
// 该函数目录的 config.json 就必须声明对应权限,否则部署后调用静默失败——
// 业务侧因"尽力发送"catch 掉异常,表现为订阅消息永远发不出去,很难排查。
// 扫描函数目录下所有 .js(含 _shared 分发副本,textSafe/mediaCheck 的调用也在内)
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', 'cloudfunctions')

function listJs(dir, acc = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules') continue
    const p = path.join(dir, name)
    if (fs.statSync(p).isDirectory()) listJs(p, acc)
    else if (name.endsWith('.js')) acc.push(p)
  }
  return acc
}

test('每个调用 cloud.openapi 的云函数都在 config.json 声明了对应权限', () => {
  const fnDirs = fs.readdirSync(ROOT).filter(d =>
    d !== '_shared' && fs.existsSync(path.join(ROOT, d, 'index.js')))
  expect(fnDirs.length).toBeGreaterThan(0)

  const problems = []
  for (const dir of fnDirs) {
    const used = new Set()
    for (const file of listJs(path.join(ROOT, dir))) {
      const src = fs.readFileSync(file, 'utf8')
      // cloud.openapi.subscribeMessage.send / cloud.openapi.security.mediaCheckAsync ...
      for (const m of src.matchAll(/cloud\.openapi\.((?:\w+\.)+\w+)\(/g)) used.add(m[1])
    }
    if (!used.size) continue
    const cfgPath = path.join(ROOT, dir, 'config.json')
    if (!fs.existsSync(cfgPath)) {
      problems.push(`${dir}: 调用了 ${[...used].join(', ')} 但没有 config.json`)
      continue
    }
    const declared = (JSON.parse(fs.readFileSync(cfgPath, 'utf8')).permissions || {}).openapi || []
    for (const api of used) {
      if (!declared.includes(api)) problems.push(`${dir}: 调用了 ${api} 但 config.json 未声明`)
    }
  }
  expect(problems).toEqual([])
})
