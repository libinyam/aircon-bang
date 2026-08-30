// wx-server-sdk 桩:让云函数模块能在 Node 里 require(顶层 init/database 不报错)
// 需要控制 db/身份的测试:require 前设置 global.__mockDb / global.__mockCtx(配合 jest.resetModules)
module.exports = {
  DYNAMIC_CURRENT_ENV: 'test-env',
  init() {},
  database() {
    if (global.__mockDb) return global.__mockDb
    return {
      collection() { return {} },
      command: {},
      serverDate() { return new Date() },
      Geo: { Point(lng, lat) { return { type: 'Point', coordinates: [lng, lat] } } }
    }
  },
  getWXContext() { return global.__mockCtx || { OPENID: 'test-openid' } },
  // 微信支付统一下单(钱包充值用):默认成功;__mockCloudPay(opt) 可注入异常/自定义返回
  cloudPay: {
    async unifiedOrder(opt) {
      if (global.__mockCloudPay) return global.__mockCloudPay(opt)
      return { payment: { timeStamp: '1', nonceStr: 'n', package: 'prepay_id=x', signType: 'MD5', paySign: 's' }, returnCode: 'SUCCESS' }
    },
    // 订单反查:默认已支付;__mockQueryOrder(opt) 注入异常/未支付/金额不符
    async queryOrder(opt) {
      if (global.__mockQueryOrder) return global.__mockQueryOrder(opt)
      return { returnCode: 'SUCCESS', resultCode: 'SUCCESS', tradeState: 'SUCCESS' }
    }
  },
  async getTempFileURL({ fileList }) {
    // 测试可通过 global.__mockTempFileURL(fileList) 注入失败/缺链结果
    if (global.__mockTempFileURL) return global.__mockTempFileURL(fileList)
    return { fileList: (fileList || []).map(f => ({ fileID: f, tempFileURL: 'https://tmp/' + f })) }
  },
  async downloadFile() {
    // 测试可通过 global.__mockDownload(返回 Buffer 的函数)提供文件内容,如合法 JPEG 魔数
    if (global.__mockDownload) return { fileContent: global.__mockDownload() }
    return { fileContent: Buffer.alloc(0) }
  },
  async uploadFile({ cloudPath, fileContent }) {
    // 测试可通过 global.__mockUpload(cloudPath, fileContent) 注入失败/自定义返回;
    // __uploadedPaths(数组)收集 cloudPath 做"匿名路径不含 openid"断言
    if (global.__uploadedPaths) global.__uploadedPaths.push(cloudPath)
    if (global.__mockUpload) return global.__mockUpload(cloudPath, fileContent)
    return { fileID: 'cloud://test-env/' + cloudPath }
  },
  async deleteFile({ fileList }) {
    // 测试可通过 global.__deletedFiles(数组)收集删除调用做断言;
    // __mockDeleteFile(fileList) 可注入逐文件结果(如 status!==0 模拟删除失败)
    if (global.__deletedFiles) global.__deletedFiles.push(...(fileList || []))
    if (global.__mockDeleteFile) return global.__mockDeleteFile(fileList)
    return {}
  }
}
