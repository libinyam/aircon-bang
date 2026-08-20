// 结构化日志母本:单行 JSON 输出,云开发控制台高级检索可按 orderId/openid 过滤
// 用法:const log = require('./logger')('grabOrder')
//       log.info('grab success', { orderId, openid: OPENID, ms: Date.now() - start })
//       log.error('notify failed', { orderId }, e)
// 约定:level/fn/msg/ts 为固定字段;订单相关操作必须带 orderId 作全链路关联键
//      (publishOrder → mediaCheck → grabOrder → finishOrder 靠它串起来)
function serializeErr(e) {
  if (!e) return undefined
  // 兼容微信云开发错误对象({errCode, errMsg})与原生 Error
  return { errCode: e.errCode, errMsg: e.errMsg || e.message || String(e) }
}

module.exports = (fn) => {
  const emit = (level, msg, fields, err) => {
    const line = Object.assign({ level, fn, msg }, fields)
    if (err) line.err = serializeErr(err)
    line.ts = new Date().toISOString()
    const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
    try {
      out(JSON.stringify(line))
    } catch (e2) {
      // fields 混进循环引用等不可序列化对象时降级输出,日志不能把业务打挂
      out(JSON.stringify({ level, fn, msg: String(msg), ts: line.ts, logError: String(e2) }))
    }
  }
  return {
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields, err) => emit('warn', msg, fields, err),
    error: (msg, fields, err) => emit('error', msg, fields, err)
  }
}
