// 用户发布维修需求:校验 -> 内容安全 -> 建单 -> 尽力通知同城师傅
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const crypto = require('crypto')

const { SCENE_KEYS, SCENES, SLOTS, STATUS, normalizeCity, normalizeCategories, categoryText } = require('./biz')
const { makeBizNo, nextBizNo } = require('./bizNo')
const textSafe = require('./textSafe')(cloud)
// 联系方式拦截:母本正则与商品侧同源,电话走独立 phone 字段收集
const { CONTACT_RE, normalizeContact } = require('./textSafe')
const verifyImages = require('./mediaFile')(cloud)
const log = require('./logger')('publishOrder')

function bad(msg) { return { ok: false, msg } }

// 订单号规则收进 _shared/bizNo:AC+北京时间年月日时分+8位 crypto 随机,
// 落库前查重重试;保留本地包装只为兼容 _internals 单测口径
const makeOrderNo = (nowMs, rand) => makeBizNo('AC', nowMs, rand)

// 发布幂等 ID:用户作用域哈希作文档 _id,双击/云函数已成功但客户端超时重试不会重复发单
// (不能拿裸 requestId 当全局 _id:跨用户撞号会让幂等返回冒领他人订单)
function makeOrderId(openid, requestId) {
  return crypto.createHash('sha256').update(`${openid}:${requestId}`).digest('hex').slice(0, 32)
}

exports.main = async (event) => {
  const start = Date.now()
  const { OPENID } = cloud.getWXContext()
  const { requestId, categories, category, scene, desc, photos = [], location, address, addressDetail = '', cityName, expectDate, slotKey, phone, contactName } = event

  if (typeof requestId !== 'string' || !requestId || requestId.length > 64) return bad('请求标识缺失,请返回重试')
  const orderId = makeOrderId(OPENID, requestId)

  // 幂等前查:同一表单重复提交(双击/云函数已成功但客户端超时)直接返回原单,
  // 不再走后续校验——否则时段过期等后置拒绝会把用户引向重复发单
  const existed = (await db.collection('orders').doc(orderId).get().catch(() => ({ data: null }))).data
  if (existed) {
    if (existed.userOpenid !== OPENID) return bad('请求标识冲突,请返回重试')
    return { ok: true, orderId, orderNo: existed.orderNo, duplicated: true }
  }

  // 品类多选:categories 数组为准,老客户端单选 category 字符串兼容;非法 key / 空选都拒
  const cats = normalizeCategories(categories || category)
  if (!cats || !cats.length) return bad('请选择服务类型')
  // 家用/商用决定接单费档位(¥20/¥300),发单时必须选定
  if (!SCENE_KEYS.includes(scene)) return bad('请选择空调类型(家用/商用)')
  if (!desc || desc.trim().length < 5) return bad('请描述一下故障情况(至少5个字)')
  if (desc.length > 500) return bad('描述太长了')
  // 坐标校验:云函数是最终信任边界,直调伪造的字符串/NaN/越界值不能等到
  // Geo.Point 抛异常才暴露;纬度 0 是合法值,不能用真值判断
  if (!location ||
      !Number.isFinite(location.latitude) || !Number.isFinite(location.longitude) ||
      Math.abs(location.latitude) > 90 || Math.abs(location.longitude) > 180) {
    return bad('请选择上门地址')
  }
  if (!cityName) return bad('地址无法识别城市,请重新选择')
  // 匹配键与展示名分离:"青岛市"/"青岛"归一到同一个 cityKey,池/通知/抢单按键匹配
  const cityKey = normalizeCity(cityName)
  if (!cityKey) return bad('地址无法识别城市,请重新选择')
  // 结构化时间校验:必须是白名单时段、未过期、30天以内
  const slot = SLOTS[slotKey]
  if (!slot || !/^\d{4}-\d{2}-\d{2}$/.test(expectDate || '')) return bad('请选择期望上门时间')
  const [ey, em, ed] = expectDate.split('-').map(Number)
  // Date.UTC 会把 2月31日 归一化成 3月2日而不是报错:反向核对年月日,拒掉不存在的日期,
  // 否则展示文本/expectEnd 过滤和用户所选日期会互相矛盾
  const probe = new Date(Date.UTC(ey, em - 1, ed))
  if (probe.getUTCFullYear() !== ey || probe.getUTCMonth() !== em - 1 || probe.getUTCDate() !== ed) {
    return bad('日期不合法')
  }
  const slotStartMs = Date.UTC(ey, em - 1, ed, slot.start - 8)
  const slotEndMs = Date.UTC(ey, em - 1, ed, slot.end - 8)
  if (slotEndMs <= Date.now()) return bad('期望时间已过,请重新选择')
  if (slotStartMs > Date.now() + 30 * 24 * 3600 * 1000) return bad('最多可预约30天内的时间')
  const expectTime = `${expectDate} ${slot.label}`

  if (!/^1[3-9]\d{9}$/.test(phone)) return bad('请填写正确的手机号')
  if (photos.length > 6) return bad('照片最多6张')
  // 照片归属与类型校验:必须是本人命名空间下上传的图片文件
  for (const fid of photos) {
    if (typeof fid !== 'string' || !fid.includes(`/orders/${OPENID}/`) || !/\.(jpg|jpeg|png)$/i.test(fid)) {
      return bad('照片校验失败,请重新上传')
    }
  }

  // 照片归属已验证为本人所有;此后再拒单就删掉本次上传,避免孤儿文件堆积
  async function badAndClean(msg) {
    if (photos.length) await cloud.deleteFile({ fileList: photos }).catch(e => log.error('badAndClean deleteFile failed', { openid: OPENID }, e))
    return bad(msg)
  }

  // 真实类型与大小校验:扩展名可伪造,按文件魔数核验
  if (photos.length) {
    const imgErr = await verifyImages(photos)
    if (imgErr) return badAndClean(imgErr)
  }

  // 联系方式拦截:desc/address 都在围观白名单里,发单即广播给全城师傅;
  // 手机号有独立 phone 字段,文本里贴电话/微信会击穿"抢单成功后才可见"的分层。
  // 逐字段归一化匹配(与 publishListing 同口径,防止拼接把短数字粘成假手机号)
  if ([desc, address].some(t => CONTACT_RE.test(normalizeContact(t)))) {
    return badAndClean('请勿在描述或地址中留电话/微信等联系方式,电话号码请在联系电话栏填写')
  }

  if (!(await textSafe(`${desc} ${address} ${addressDetail} ${contactName || ''}`))) {
    return badAndClean('内容含违规信息,请修改后重试')
  }

  // 限频防刷:同一用户1小时内最多发3单
  const recent = await db.collection('orders').where({
    userOpenid: OPENID,
    publishedAt: _.gt(new Date(Date.now() - 3600 * 1000))
  }).count()
  if (recent.total >= 3) return badAndClean('发单太频繁,请1小时后再试')

  // 手机号回填到用户档案,下次发单免填
  await db.collection('users').where({ openid: OPENID })
    .update({ data: { phone, contactName: contactName || '' } })

  // 单号落库前查重:撞候选换新,连续撞满明确失败而不是静默重复
  const orderNo = await nextBizNo('AC', async no =>
    (await db.collection('orders').where({ orderNo: no }).count()).total > 0)
  if (!orderNo) return badAndClean('单号生成失败,请重新提交')

  const order = {
    orderNo,
    userOpenid: OPENID,
    userPhone: phone,
    userName: contactName || '',
    category: cats[0],               // 首选项:兼容存量读方(展示/通知兜底),匹配一律走 categories
    categories: cats,                // 多选全集:订单池/抢单/围观按此项与师傅能力求交集
    categoryName: categoryText(cats),
    scene,                 // 家用/商用:接单费档位依据(grabOrder 按此扣费)
    sceneName: SCENES[scene].name,
    desc: desc.trim(),
    photos,
    location: db.Geo.Point(location.longitude, location.latitude),
    address,               // 小区/POI级,抢单前对师傅可见
    addressDetail,         // 门牌号等,仅订单双方可见
    cityName,
    cityKey,               // 匹配键:池/通知/抢单按此匹配,cityName 只作展示
    expectTime,                       // 展示用文本
    expectDate,                       // 结构化:日期
    expectSlot: slotKey,              // 结构化:时段
    expectEnd: new Date(slotEndMs),   // 结构化:时段截止,订单池/抢单据此过滤过期需求
    status: STATUS.PUBLISHED,
    masterOpenid: '',
    reviewed: false,
    publishedAt: db.serverDate()
  }
  let res
  try {
    res = await db.collection('orders').add({ data: Object.assign({ _id: orderId }, order) })
  } catch (e) {
    // _id 冲突 = 幂等前查之后的并发窗口里同请求已落库:核对归属后按成功返回,
    // 照片正被该订单引用,不删
    const dup = (await db.collection('orders').doc(orderId).get().catch(() => ({ data: null }))).data
    if (dup && dup.userOpenid === OPENID) return { ok: true, orderId, orderNo: dup.orderNo, duplicated: true }
    log.error('order add failed', { orderId, openid: OPENID }, e)
    return badAndClean('发布失败,请重试')
  }
  log.info('order published', { orderId: res._id, orderNo, openid: OPENID, photoCount: photos.length, ms: Date.now() - start })

  // 图片异步送检:结果回调到 mediaCheckCallback 云函数(需在云开发控制台配置消息推送,见 README)
  // 送检失败不阻断发单(fail-open,与文本检测策略一致)
  if (photos.length) {
    try {
      const { fileList } = await cloud.getTempFileURL({ fileList: photos })
      for (const f of fileList) {
        if (!f.tempFileURL) continue
        const check = await cloud.openapi.security.mediaCheckAsync({
          mediaUrl: f.tempFileURL,
          mediaType: 2,        // 2=图片
          version: 2,
          scene: 3,            // 3=论坛(用户发布的公开内容)
          openid: OPENID
        })
        const traceId = check.traceId || check.trace_id
        if (traceId) {
          await db.collection('media_checks').add({
            data: { traceId, type: 'order', targetId: res._id, fileID: f.fileID, status: 'pending', createdAt: db.serverDate() }
          })
        }
      }
    } catch (e) { log.error('mediaCheckAsync submit failed', { orderId: res._id }, e) }
  }

  // 尽力而为:给同城已审核师傅推订阅消息(模板ID配置在 config/app 文档,未配置则跳过)
  // 接单费制下不再筛会员:所有 approved 师傅都可自费接单,推给谁由余额/意愿自己决定
  // 轮转选取:按 lastNotifiedAt 升序取 20——从未被通知过的(缺字段)排最前,
  // 之后按上次通知时间轮流;同城师傅超过 20 位时不再有人永远收不到推送。
  // 选中即打卡(与送达与否无关,公平的是"被选中的机会"),发送前落库挡住并发同选题重选
  // 响应时延上限:发送与 3s 超时竞速,微信接口抖动不再把发单响应拖到客户端超时;
  // 超时未完成的发送会丢(尽力而为语义不变),彻底解耦待 outbox 方案
  let notifyTimer = null
  try {
    const cfg = (await db.collection('config').doc('app').get()).data
    if (cfg.tplNewOrder) {
      const masters = (await db.collection('masters').where({
        status: 'approved',
        cityKey
      }).orderBy('lastNotifiedAt', 'asc').limit(20).get()).data
      if (masters.length) {
        await db.collection('masters').where({ _id: _.in(masters.map(m => m._id)) })
          .update({ data: { lastNotifiedAt: db.serverDate() } })
        const sends = masters.map(m =>
          cloud.openapi.subscribeMessage.send({
            touser: m.openid,
            templateId: cfg.tplNewOrder,
            page: 'pages/pool/pool',
            // 字段名需与申请的模板一致,申请后按实际字段调整这里
            data: {
              thing4: { value: categoryText(cats, true) },
              thing1: { value: (address || cityName).slice(0, 20) },
              thing7: { value: expectTime.slice(0, 20) }
            }
          }).catch(() => {}))
        await Promise.race([
          Promise.all(sends),
          new Promise(resolve => { notifyTimer = setTimeout(resolve, 3000) })
        ])
      }
    }
  } catch (e) { /* 未配置或发送失败不影响发单 */ } finally {
    if (notifyTimer) clearTimeout(notifyTimer)   // 不留悬挂定时器
  }

  return { ok: true, orderId: res._id, orderNo }
}

// 仅供离线单测使用,云端运行不受影响
exports._internals = { makeOrderNo }
