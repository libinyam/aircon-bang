// 静默登录:取 openid,首次访问自动建用户档案,顺带返回师傅身份与管理员标记
// 首次部署时数据库为空,这里会自动创建基础集合,避免"先跑通登录才能配管理员"的死锁
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// 集合清单唯一源 _shared/collections.js,与 admin.initDb 共用
const { AUTO_COLLECTIONS } = require('./collections')

async function ensureCollections() {
  for (const n of AUTO_COLLECTIONS) {
    try { await db.createCollection(n) } catch (e) { /* 已存在 */ }
  }
}

async function loadIdentity(OPENID) {
  let user = (await db.collection('users').where({ openid: OPENID }).get()).data[0]
  if (!user) {
    // openid 作文档ID:并发首登两次 set 落在同一文档,天然防重复建档
    const data = { openid: OPENID, phone: '', contactName: '', createdAt: db.serverDate() }
    await db.collection('users').doc(OPENID).set({ data })
    user = Object.assign({ _id: OPENID }, data)
  }
  const master = (await db.collection('masters').where({ openid: OPENID }).get()).data[0] || null
  return { user, master }
}

exports.main = async () => {
  const { OPENID } = cloud.getWXContext()

  let identity
  try {
    identity = await loadIdentity(OPENID)
  } catch (e) {
    // 集合不存在(首次运行):建集合后重试一次
    await ensureCollections()
    identity = await loadIdentity(OPENID)
  }

  // 管理员白名单存在 config 集合 _id='app' 文档的 adminOpenids 数组里
  let isAdmin = false
  try {
    const cfg = await db.collection('config').doc('app').get()
    isAdmin = (cfg.data.adminOpenids || []).includes(OPENID)
  } catch (e) { /* config 未初始化时忽略 */ }

  return { ok: true, openid: OPENID, user: identity.user, master: identity.master, isAdmin }
}
