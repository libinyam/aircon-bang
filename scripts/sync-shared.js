// 把 cloudfunctions/_shared/ 的母本同步到各云函数目录(云函数部署时各目录必须自包含)
// 用法:node scripts/sync-shared.js          修改 _shared 下任何文件后必须执行
//      node scripts/sync-shared.js --check  只校验不写入,副本与母本不一致时退出码 1(CI / pre-push 用)
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', 'cloudfunctions')
const MAP = {
  'textSafe.js': ['publishOrder', 'applyMaster', 'submitReview', 'complain', 'publishListing',
                  'cancelOrder', 'confirmOrder'],
  'biz.js': ['publishOrder', 'applyMaster', 'grabOrder', 'finishOrder', 'confirmOrder',
             'cancelOrder', 'cronTimeout', 'getOrders', 'submitReview', 'admin',
             'publishListing', 'getListings', 'updateListing', 'mediaCheckCallback'],
  'mediaFile.js': ['publishOrder', 'applyMaster', 'publishListing'],
  // 业务编号(订单号/商品编号/钱包充值单号):共享生成与查重重试规则
  'bizNo.js': ['publishOrder', 'publishListing', 'wallet'],
  'storage.js': ['cronTimeout', 'mediaCheckCallback', 'applyMaster', 'admin', 'updateListing'],
  // 违规媒体处置:回调实时处置与 cron 补偿重放共用(评审时序重构)
  'mediaApply.js': ['mediaCheckCallback', 'cronTimeout'],
  'collections.js': ['login', 'admin'],
  // 日志同步到全部云函数:console.error 逐步迁移,新函数直接用
  'logger.js': ['login', 'publishOrder', 'getOrders', 'grabOrder', 'finishOrder', 'confirmOrder',
                'cancelOrder', 'submitReview', 'applyMaster', 'complain', 'requestDeletion',
                'admin', 'cronTimeout', 'mediaCheckCallback', 'registerUpload',
                'publishListing', 'getListings', 'updateListing', 'wallet', 'payCallback']
}

function forEachCopy(fn) {
  for (const [file, targets] of Object.entries(MAP)) {
    const master = path.join(ROOT, '_shared', file)
    for (const t of targets) fn(master, path.join(ROOT, t, file), file, t)
  }
}

function sync() {
  let count = 0
  forEachCopy((master, copy, file, t) => {
    fs.writeFileSync(copy, fs.readFileSync(master))
    console.log(`synced ${file} -> ${t}/`)
    count++
  })
  console.log(`done, ${count} copies updated. 记得在开发者工具重新上传受影响的云函数。`)
}

function check() {
  const drift = []
  forEachCopy((master, copy, file, t) => {
    const same = fs.existsSync(copy) &&
      fs.readFileSync(copy, 'utf8') === fs.readFileSync(master, 'utf8')
    if (!same) drift.push(`${t}/${file}`)
  })
  if (drift.length) {
    console.error('副本与 _shared 母本不一致(改了母本忘跑 sync,或直接改了副本):')
    drift.forEach(d => console.error('  - ' + d))
    console.error('修复:node scripts/sync-shared.js(以母本为准覆盖副本)')
    process.exit(1)
  }
  console.log('sync check ok: 所有副本与母本一致')
}

if (require.main === module) {
  process.argv.includes('--check') ? check() : sync()
}

module.exports = { MAP, ROOT }
