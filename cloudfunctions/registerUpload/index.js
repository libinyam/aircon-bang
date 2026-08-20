// 上传登记:客户端把本次上传的 fileID 清单登记到 upload_logs,
// cronTimeout 据此清理"上传成功但业务提交未完成"留下的孤儿文件。
// 登记是尽力而为:前端调用失败不阻断发单/入驻(那种情况退回现状——文件可能残留,不会更糟)
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// scene -> 云存储命名空间前缀,与 publishOrder/applyMaster/publishListing 的归属校验同口径
const SCENE_PREFIX = { order: 'orders', qual: 'quals', listing: 'listings', avatar: 'avatars' }

function bad(msg) { return { ok: false, msg } }

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const { scene, fileIDs } = event

  const prefix = SCENE_PREFIX[scene]
  if (!prefix) return bad('登记场景不合法')
  if (!Array.isArray(fileIDs) || !fileIDs.length || fileIDs.length > 6) return bad('文件清单不合法')
  // 只接受本人命名空间下的图片 fileID:登记接口不能成为替他人"预约删除"的口子
  for (const fid of fileIDs) {
    if (typeof fid !== 'string' || !fid.includes(`/${prefix}/${OPENID}/`) || !/\.(jpg|jpeg|png)$/i.test(fid)) {
      return bad('文件校验失败')
    }
  }

  await db.collection('upload_logs').add({
    data: { openid: OPENID, scene, fileIDs, status: 'pending', createdAt: db.serverDate() }
  })
  return { ok: true }
}
