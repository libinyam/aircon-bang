// 图片文件真实性校验母本:路径归属校验通过后,再核验字节内容与大小
// 扩展名客户端可伪造,文件头魔数不能:JPEG=FF D8 FF,PNG=89 50 4E 47
// 返回空串=通过;返回文案=拒绝原因(调用方决定是否顺带删文件)
const MAX_BYTES = 5 * 1024 * 1024

module.exports = (cloud) => async function verifyImages(fileIDs) {
  for (const fileID of fileIDs) {
    let buf
    try {
      buf = (await cloud.downloadFile({ fileID })).fileContent
    } catch (e) {
      return '照片已失效,请重新上传'
    }
    if (!buf || !buf.length) return '照片已失效,请重新上传'
    if (buf.length > MAX_BYTES) return '单张照片不能超过5MB,请压缩后上传'
    const jpg = buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF
    const png = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47
    if (!jpg && !png) return '仅支持 jpg/png 格式的照片'
  }
  return ''
}
