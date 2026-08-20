// 云存储批量删除(严格版)母本:任一文件删除失败即抛错,调用方据此保留重试线索
// "文件不存在"视为删除成功——否则已被删过的文件会让清理任务永远卡住
module.exports = (cloud) => async function deleteFilesStrict(fileList) {
  if (!fileList || !fileList.length) return
  const r = await cloud.deleteFile({ fileList })
  const failed = (r.fileList || []).filter(f =>
    f.status !== 0 && !/not.?exist|non.?exist/i.test(f.errMsg || ''))
  if (failed.length) {
    throw new Error('deleteFile failed: ' + failed.map(f => `${f.fileID}(${f.errMsg})`).join(';'))
  }
}
