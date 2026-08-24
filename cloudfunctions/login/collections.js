// 数据库集合名清单 —— 【母本】,修改后执行 node scripts/sync-shared.js 同步副本
// login 首登自动建集合 与 admin.initDb 共用这一份,防两处清单漂移
// config 不在清单内:需手动创建并填 adminOpenids/订阅模板ID(见 README 部署步骤),
// 自动建一个空 config 反而会掩盖"漏配管理员白名单"的问题
const AUTO_COLLECTIONS = [
  'users', 'masters', 'orders', 'reviews', 'member_logs',
  'complaints', 'media_checks', 'deletion_requests', 'cron_logs', 'upload_logs',
  'listings', 'contact_logs', 'wallets', 'wallet_logs'
]

module.exports = { AUTO_COLLECTIONS }
