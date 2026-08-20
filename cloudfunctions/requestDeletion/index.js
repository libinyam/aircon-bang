// 用户申请删除账号数据:openid 作文档 _id,重复提交幂等
// 平台人工核实处理(单人运营,无自动删除),处理留痕在 admin 的 handleDeletionRequest
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async () => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { ok: false, msg: '登录态异常,请重试' }

  const existing = (await db.collection('deletion_requests').doc(OPENID).get()
    .catch(() => ({ data: null }))).data

  // open/pending_retry/executed 都是处理中,不能重置工单状态;
  // 只有 closed(已办结)后再次申请才重开新一轮
  if (existing && existing.status !== 'closed') {
    return { ok: true, already: true, msg: '你的删除申请已在处理中' }
  }

  const isMaster = !!(await db.collection('masters').where({ openid: OPENID }).count()).total

  if (existing) {
    // 之前处理完结过,重新发起:重开并保留上次处理记录
    await db.collection('deletion_requests').doc(OPENID).update({
      data: { status: 'open', reopenedAt: db.serverDate(), isMaster }
    })
  } else {
    await db.collection('deletion_requests').add({
      data: { _id: OPENID, openid: OPENID, isMaster, status: 'open', createdAt: db.serverDate() }
    })
  }
  return { ok: true, already: false }
}
