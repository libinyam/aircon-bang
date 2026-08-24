// 接收微信 wxa_media_check 异步检测结果(云开发控制台"消息推送"需配置该事件路由到本函数)
// 违规处理:订单/商品照片(公开可见)摘除并删文件;师傅资质照片(仅管理员可见)只打标留审核判断
// 处置时序(评审重构):pending -原子认领-> processing(存 suggest/label,补偿重放不依赖回调 event)
// -> 业务文档摘图/打标 -> 成功才删文件 -> 落终态;文档更新失败打 applyPending 由 cronTimeout 重放
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const applyMediaRisk = require('./mediaApply')(cloud)

exports.main = async (event) => {
  // 来源校验:本函数只接受微信消息推送(wxa_media_check)。
  // 云函数对任何登录用户开放直调,消息推送上下文无 OPENID 而客户端直调必然带——
  // 拒绝客户端来源,堵死伪造 pass/risky 回调(摘图删文件不可逆)
  const { OPENID } = cloud.getWXContext()
  if (OPENID) return 'ignored: not from message push'

  const traceId = event.trace_id || event.traceId
  if (!traceId) return 'ignored: no trace_id'
  const suggest = (event.result && event.result.suggest) || ''   // pass / review / risky

  const check = (await db.collection('media_checks').where({ traceId }).get()).data[0]
  if (!check) return 'ignored: unknown trace'

  // 状态闸:仅 pending 的检测记录能被认领一次。
  // trace_id 从不下发客户端,伪造需先知道 traceId;即便知道,已认领的记录也无法重放破坏性操作
  const gate = await db.collection('media_checks').where({
    _id: check._id,
    status: 'pending'
  }).update({
    data: {
      status: 'processing',
      suggest: suggest || 'unknown',
      label: (event.result && event.result.label) || 0,
      claimedAt: db.serverDate()
    }
  })
  if (gate.stats.updated === 0) return 'ignored: already handled'

  if (!suggest || suggest === 'pass') {
    await db.collection('media_checks').doc(check._id).update({
      data: { status: suggest || 'unknown', checkedAt: db.serverDate() }
    })
    return 'ok'
  }

  await applyMediaRisk(Object.assign({}, check, { suggest }))
  return 'ok'
}
