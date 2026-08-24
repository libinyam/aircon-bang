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

// 联系方式拦截(母本, publishListing 上提):电话必须走独立字段/按次取号接口下发,
// 公开可见的自由文本(商品标题/描述、订单 desc/address)里贴手机号/微信号/网址会绕掉整个分层。
// 匹配前先归一化:全角转半角、去常见分隔符、字母 O 当 0,
// 堵住 "138 0730 6688" / "138-0730-6688" / 全角数字 / "138O7306688" 等非连续写法;
// 变体词表补 weixin/v信/同号/加我。"同型号"是合法高频词,同号(?!型) 防误伤;
// 引导型文案("联系方式见图片")正则无解,依赖图片异步审核与人工处置
module.exports.CONTACT_RE = /1[3-9]\d{9}|https?:\/\/|www\.|(?:微信|威信|薇信|wechat|weixin|vx|wx)\s*[:：号]|v信|同号(?!型)|加我/i

// 归一化只用于匹配,绝不落库:O→0 会改写普通英文词,结果不能存回文档
module.exports.normalizeContact = function normalizeContact(s) {
  return String(s || '')
    .replace(/[\uff01-\uff5e]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))  // 全角→半角(含全角数字)
    .replace(/[\s\-_.·*,、]/g, '')   // 常见分隔符
    .replace(/o/gi, '0')             // 字母 O 混写数字
}
