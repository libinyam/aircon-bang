// 匿名副本换链:TCB 临时链原样保留对象键,getTempFileURL 只去掉
// cloud:// 前缀,URL 路径里的 openid 一字不差地下发——上一轮换链防护因此未达目的。
// 本模块在签发临时链前把文件复制到匿名路径(alias/<随机名>)再对副本换链:
// 含 openid 的 URL 一律不出云函数;复制失败该文件空链,严格/回退口径由调用方定。
// 映射落 file_aliases 集合(_id=源 fileID,仅服务端可读),同一文件全生命周期只复制一次。
// 已知遗留:副本不随源文件联动删除(删号/下架清理暂不动别名),孤儿副本清理待专项。
const crypto = require('crypto')

module.exports = (cloud, db) => {
  const log = require('./logger')('anonFile')
  const _ = db.command

  // 匿名路径:保留扩展名(影响 COS 内容类型),随机名不含任何用户标识
  function aliasPath() {
    return `alias/${crypto.randomBytes(16).toString('hex')}`
  }

  // 单文件复制+登记;并发冲突回读现成映射。任何失败返回 null,绝不回退源路径
  async function ensureAlias(src) {
    try {
      const hit = await db.collection('file_aliases').doc(src).get().catch(() => null)
      if (hit && hit.data && hit.data.alias) return hit.data.alias
      const ext = (src.match(/\.[a-z0-9]+$/i) || [''])[0]
      const dl = await cloud.downloadFile({ fileID: src })
      const up = await cloud.uploadFile({ cloudPath: aliasPath() + ext, fileContent: dl.fileContent })
      try {
        await db.collection('file_aliases').add({ data: { _id: src, alias: up.fileID, createdAt: new Date() } })
      } catch (e) {
        // _id 冲突=并发调用已登记:回读以库为准(多出的副本留待清理,不影响正确性)
        const again = await db.collection('file_aliases').doc(src).get().catch(() => null)
        if (again && again.data && again.data.alias) return again.data.alias
      }
      return up.fileID
    } catch (e) {
      // 日志不带 src:路径本身含 openid,不落日志
      log.error('alias copy failed', {}, e)
      return null
    }
  }

  // 形状与 cloud.getTempFileURL 对齐:按输入顺序返回 {fileID: 源 fileID, tempFileURL},
  // 调用方现有映射/回退逻辑不用改。本函数不抛出:任何环节失败该文件 tempFileURL 为空串
  return async function getAnonTempURLs(fileIDs) {
    const list = (fileIDs || []).filter(Boolean)
    if (!list.length) return { fileList: [] }

    // 先批量查已有映射(_.in 上限 100 分批),未命中才复制
    const aliasMap = {}
    for (let i = 0; i < list.length; i += 100) {
      try {
        const r = await db.collection('file_aliases').where({ _id: _.in(list.slice(i, i + 100)) }).get()
        for (const d of r.data || []) aliasMap[d._id] = d.alias
      } catch (e) { /* 查映射失败按全未命中处理,复制路径同样兜得住 */ }
    }
    // 复制是存储 I/O,5 路并发防池列表首屏串行 60 次下载上传
    const missing = list.filter(s => !aliasMap[s])
    for (let i = 0; i < missing.length; i += 5) {
      await Promise.all(missing.slice(i, i + 5).map(async src => {
        const a = await ensureAlias(src)
        if (a) aliasMap[src] = a
      }))
    }

    // 对匿名副本换链(单次上限 50 分批);整批失败对应文件空链
    const aliases = list.map(s => aliasMap[s]).filter(Boolean)
    const urlByAlias = {}
    for (let i = 0; i < aliases.length; i += 50) {
      try {
        const r = await cloud.getTempFileURL({ fileList: aliases.slice(i, i + 50) })
        for (const f of r.fileList || []) if (f.tempFileURL) urlByAlias[f.fileID] = f.tempFileURL
      } catch (e) { /* 空链,strict 丢弃/非 strict 回退由调用方定 */ }
    }
    return { fileList: list.map(src => ({ fileID: src, tempFileURL: urlByAlias[aliasMap[src]] || '' })) }
  }
}
