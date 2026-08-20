// 业务编号生成 —— 【母本】,修改后执行 node scripts/sync-shared.js 同步副本
// 格式:前缀 + 北京时间 yymmddHHMM + '-' + 8 位数字随机(publishOrder 的 AC / publishListing 的 GD 共用)
// - 时间部分显式按北京时间(UTC+8)生成:云函数跑在 UTC,本地 getter 会差 8 小时
// - 随机改用 crypto,同分钟 1e8 空间:高并发下碰撞可忽略,不再用 Math.random() 的 4 位
// - nextBizNo 落库前查重:候选撞库换新候选,连续撞满仍返回 null,由调用方明确失败而不是静默重复
const crypto = require('crypto')

const SUFFIX_SPACE = 1e8
const MAX_ATTEMPTS = 5

function bjMinute(nowMs) {
  const bj = new Date(nowMs + 8 * 3600 * 1000)
  return bj.getUTCFullYear().toString().slice(2) +
    String(bj.getUTCMonth() + 1).padStart(2, '0') + String(bj.getUTCDate()).padStart(2, '0') +
    String(bj.getUTCHours()).padStart(2, '0') + String(bj.getUTCMinutes()).padStart(2, '0')
}

// crypto.randomInt 需 Node ≥14.10(仅回移植到 12.19):云开发仍可创建 Nodejs 12.13 函数,
// 缺 API 时退回 randomBytes 取模,避免发单/上架全量 500
const randInt = (n) => (crypto.randomInt ? crypto.randomInt(n) : crypto.randomBytes(4).readUInt32BE(0) % n)

// rand 可注入(测试强制撞候选);默认 crypto 随机,须返回 [0, SUFFIX_SPACE) 的整数
function makeBizNo(prefix, nowMs, rand = () => randInt(SUFFIX_SPACE)) {
  return prefix + bjMinute(nowMs) + '-' + String(rand()).padStart(8, '0')
}

// exists(no) -> Promise<boolean>:候选编号已落库时返回 true。撞候选重试,耗尽返回 null
async function nextBizNo(prefix, exists, nowMs = Date.now(), rand) {
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const no = makeBizNo(prefix, nowMs, rand)
    if (!(await exists(no))) return no
  }
  return null
}

module.exports = { makeBizNo, nextBizNo, SUFFIX_SPACE, MAX_ATTEMPTS }
