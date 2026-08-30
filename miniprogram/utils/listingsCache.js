// 「我的上架」打开体验缓存:进「我的」tab 时后台预取 getListings mine,
// 管理页 onLoad 在新鲜期内先整页渲染缓存,再静默刷新收敛——首屏不等
// 云函数往返(getListings 冷启动+换链约 1s,是打开卡顿的主因)。
// 只保内存不落 storage:封面是 getTempFileURL 临时链接会过期,跨启动缓存必然出破图
const { callFn } = require('./util')
const { LISTING_STATUS, LISTING_STATUS_MAP, unitTypeName, hpName, gradeName } = require('./constants')

// 新鲜期:期内打开页面直接用缓存首屏;页面随后总会静默刷新,
// 旧缓存只影响首屏一瞬间,不是数据源
const FRESH_MS = 5 * 60 * 1000

let cache = null // { at, rows, noMore }

// mine 列表行 → 渲染视图模型:预取与页面刷新共用同一份映射,防两处口径漂移
function mapRows(rows) {
  return rows.map(l => {
    const st = LISTING_STATUS_MAP[l.status] || { label: l.status, color: '#667180' }
    return Object.assign(l, {
      statusLabel: st.label,
      statusColor: st.color,
      condText: l.condition === 'new' ? '新机' : (gradeName(l.usedGrade) || '二手机'),
      specText: [unitTypeName(l.unitType), hpName(l.hp)].filter(Boolean).join(' · '),
      // 操作按钮可用性预计算(WXML 不写裸状态字面量)
      canOffShelf: l.status === LISTING_STATUS.ON_SALE,
      canOnShelf: l.status === LISTING_STATUS.OFF_SHELF,
      canSold: l.status === LISTING_STATUS.ON_SALE || l.status === LISTING_STATUS.OFF_SHELF,
      canEdit: l.status === LISTING_STATUS.ON_SALE || l.status === LISTING_STATUS.OFF_SHELF,
      canDelete: l.status === LISTING_STATUS.OFF_SHELF,
      reasonText: l.removedReason || l.offShelfReason || ''
    })
  })
}

// 读缓存:新鲜期内返回 { rows, noMore },否则 null(调用方走正常 loading 流程)
function peekMine() {
  if (!cache || Date.now() - cache.at > FRESH_MS) return null
  return { rows: cache.rows, noMore: cache.noMore }
}

// 页面第 0 页刷新成功后回写,下次打开即秒出
function putMine(rows, noMore) {
  cache = { at: Date.now(), rows, noMore }
}

// 弃缓存:第 0 页刷新失败时由页面调用——"旧缓存只影响首屏一瞬间"的前提是刷新必然
// 收敛;刷新失败还留新鲜缓存,下次进入会整屏渲染已不成立的状态(下架后再进还显示
// 在售、按钮照常可点),弃掉后走全量 loading
function dropMine() {
  cache = null
}

// 后台预取(进「我的」tab 触发):静默失败——预热只是体验优化,不该在
// 「我的」tab 弹网络 toast;新鲜期内跳过,防快速切 tab 时重复打
function prefetchMine() {
  if (peekMine()) return Promise.resolve(false)
  return callFn('getListings', { action: 'mine', page: 0 }, { silent: true })
    .then(r => { putMine(mapRows(r.data), !r.hasMore); return true })
    .catch(() => false)
}

module.exports = { mapRows, peekMine, putMine, dropMine, prefetchMine }
