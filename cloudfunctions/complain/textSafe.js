// 文本内容安全 —— 【母本】,修改后执行 node scripts/sync-shared.js 同步副本
// fail-open 策略:仅命中违规(87014)拦截;接口自身异常放行,不因基础设施问题拦住用户
module.exports = function makeTextSafe(cloud) {
  return async function textSafe(content) {
    if (!content) return true
    try {
      await cloud.openapi.security.msgSecCheck({ content })
      return true
    } catch (e) {
      if (e.errCode === 87014 || (e.errMsg || '').includes('87014')) return false
      console.error('msgSecCheck error', e)
      return true
    }
  }
}
