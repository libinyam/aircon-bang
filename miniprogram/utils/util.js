// 通用工具
function pad(n) { return n < 10 ? '0' + n : '' + n }

// serverDate/Date/字符串 -> "07-26 14:30"
function formatTime(t) {
  if (!t) return ''
  const d = t instanceof Date ? t : new Date(t)
  if (isNaN(d.getTime())) return ''
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// 带年份的日期,用于钱包流水等长周期展示 "2026-10-26"
function formatDate(t) {
  if (!t) return ''
  const d = t instanceof Date ? t : new Date(t)
  if (isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// 分 -> 元展示文本:整元不带小数(2000->"20"),有角分保留两位(2050->"20.50")
function formatFee(fen) {
  const n = Number(fen)
  if (!Number.isFinite(n)) return '0'
  return n % 100 === 0 ? String(n / 100) : (n / 100).toFixed(2)
}

// 相对时间:"5分钟前 / 3小时前 / 07-26"
function relTime(t) {
  if (!t) return ''
  const d = t instanceof Date ? t : new Date(t)
  if (isNaN(d.getTime())) return ''
  const diff = Date.now() - d.getTime()
  if (diff < 60 * 1000) return '刚刚'
  if (diff < 3600 * 1000) return Math.floor(diff / 60000) + '分钟前'
  if (diff < 24 * 3600 * 1000) return Math.floor(diff / 3600000) + '小时前'
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// 两坐标球面距离(km),用于订单池按距离展示
function distanceKm(lat1, lng1, lat2, lng2) {
  const rad = x => x * Math.PI / 180
  const R = 6371
  const dLat = rad(lat2 - lat1)
  const dLng = rad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// 从 chooseLocation 的 address 里解析城市名,解析不出返回空串
function parseCity(address) {
  if (!address) return ''
  const m = address.match(/(?:.+?(?:省|自治区))?(.+?(?:市|自治州|地区|盟))/)
  return m ? m[1] : ''
}

function isValidPhone(p) { return /^1[3-9]\d{9}$/.test(p) }

// 分页追加按 _id 去重:翻页期间订单状态变化会造成偏移漂移
function mergeById(oldList, newList) {
  const seen = new Set(oldList.map(o => o._id))
  return oldList.concat(newList.filter(o => !seen.has(o._id)))
}

// 上传 cloudPath 的扩展名:从临时文件路径派生,白名单 jpg/jpeg/png
// 与服务端归属校验 /\.(jpg|jpeg|png)$/i 口径一致;HEIC 等白名单外格式回退 jpg
// (chooseMedia sizeType:['compressed'] 下微信通常已转码 jpg,回退兜原图直传的少数机型,
//  真实格式最终由服务端魔数校验把关)
function imageExt(tempPath) {
  const m = /\.(\w+)$/.exec(tempPath || '')
  const ext = m ? m[1].toLowerCase() : ''
  return ['jpg', 'jpeg', 'png'].indexOf(ext) >= 0 ? ext : 'jpg'
}

// 云函数调用统一封装:失败弹toast并reject;silent 供后台预热/静默刷新用
// (同样 reject,只是不弹 toast——屏上已有内容或用户根本没发起这次调用时,弹错只会打扰)
function callFn(name, data, { silent = false } = {}) {
  return wx.cloud.callFunction({ name, data }).then(res => {
    const r = res.result
    if (r && r.ok === false) {
      if (!silent) wx.showToast({ title: r.msg || '操作失败', icon: 'none' })
      return Promise.reject(r)
    }
    return r
  }).catch(err => {
    if (!(err && err.ok === false)) {
      console.error(`[${name}]`, err)
      if (!silent) wx.showToast({ title: '网络异常,请重试', icon: 'none' })
    }
    return Promise.reject(err)
  })
}

module.exports = { formatTime, formatDate, relTime, distanceKm, parseCity, isValidPhone, mergeById, imageExt, formatFee, callFn }
