// 全局配置:部署时只需要改这个文件
module.exports = {
  // ★品牌名唯一源★ 界面与协议里出现的小程序名称,须与微信后台注册名称一致。
  // app.json 与各页 .json 的 navigationBarTitleText 是纯 JSON,读不到这里,
  // 由 test/brandName.test.js 守护三处不漂移(导航标题 / 首页字标 / 协议主体声明)
  BRAND_NAME: '空调帮',

  // 云开发环境ID:微信开发者工具 -> 云开发控制台 -> 设置 中查看
  CLOUD_ENV: 'YOUR_CLOUD_ENV_ID',

  // ★必改★ 运营主体:公司营业执照全称(协议与隐私说明中展示,缺失影响协议效力)
  COMPANY_NAME: '某某家电维修服务有限公司',

  // ★必改★ 平台客服电话(显示在"我的"页,用户投诉/师傅续费都打这个)
  SERVICE_PHONE: '13800000000',

  // 订阅消息模板ID:mp.weixin.qq.com -> 功能 -> 订阅消息 中申请后填入,留空则跳过推送
  // 推给师傅的"新订单提醒"模板,建议字段:服务类型/所在区域/期望时间
  TPL_NEW_ORDER: '',
  // 推给用户的"订单已接单"模板,建议字段:订单编号/师傅姓名/联系电话
  TPL_ORDER_TAKEN: '',
  // 推给用户的"维修完成待确认"模板,建议字段:订单编号/服务类型/温馨提示
  TPL_ORDER_FINISH: '',
  // 推给师傅的"订单异常提醒"模板,字段:订单编号/异常内容/备注
  TPL_ORDER_REJECTED: '',

  // 首页 hero 实景横幅。两种填法:
  // 1) 包内本地路径(推荐,如 '/assets/hero-home.jpg'):无权限/过期问题,换图需发版
  // 2) cloud:// fileID:受存储"仅创建者可读写"规则限制,控制台上传的文件终端用户读不了
  //    (STORAGE_EXCEED_AUTHORITY),要走此路线需服务端换链下发,勿为此改全桶读权限
  // 图片建议 16:9、≥1125×633,师傅主体居中偏右,左侧留 1/3 叠文字。留空回退品牌渐变版
  HERO_IMAGE: '/assets/hero-home.jpg',

  // 师傅招募文案(入驻页顶部横幅,留空不展示;冷启动推广期用)
  RECRUIT_NOTICE: '开业推广期:前20名入驻师傅免费领3个月接单会员,审核通过后联系客服开通',

  // ============ 转发分享(所有 onShareAppMessage 的唯一源) ============
  // ⚠️ imageUrl 必须显式给:留空时微信自动截取当前页面当封面 ——
  //    "我的"页会把师傅真名/评分/接单数截进卡片,"接单大厅"会把他人订单地址截进卡片。
  // 封面规格:微信按 5:4 裁切,必须用包内路径(cloud:// 与未备案域名图都不生效)
  SHARE_COVER: '/assets/share-home.jpg',
  SHARE: {
    home: { title: '空调坏了?发个单,同城师傅上门修', path: '/pages/index/index?from=share' },
    market: { title: '师傅直卖空调,新机二手都有,当面验货', path: '/pages/market/market?from=share' },
    recruit: { title: '空调师傅看过来:同城接单平台,不抽单佣金', path: '/pages/pool/pool?from=share' },
    listing: { title: '师傅直卖空调,当面验货' }
  }
}
