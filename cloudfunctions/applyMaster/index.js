// 师傅入驻申请:新申请或被驳回后重新提交
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const { CATEGORY_KEYS, QUAL_TYPE, normalizeCity } = require('./biz')
const textSafe = require('./textSafe')(cloud)
const verifyImages = require('./mediaFile')(cloud)
const deleteFilesStrict = require('./storage')(cloud)

function bad(msg) { return { ok: false, msg } }

// 展示头像(选填):入驻通过后随时补传/更换,对买家公开展示在商品卖家卡与"我的"页。
// 与资质照片性质不同——公开照片,走与商品照片同口径的送检与违规摘除(type masterAvatar)
async function updateAvatar(event, OPENID) {
  const { avatarPhoto } = event
  if (typeof avatarPhoto !== 'string' || !avatarPhoto.includes(`/avatars/${OPENID}/`) || !/\.(jpg|jpeg|png)$/i.test(avatarPhoto)) {
    return bad('头像校验失败,请重新上传')
  }
  const master = (await db.collection('masters').where({ openid: OPENID }).get()).data[0]
  if (!master || master.status !== 'approved') return bad('仅认证师傅可设置展示头像')
  // 魔数/大小校验不通过即删文件拒绝( 同口径,避免孤儿堆积)
  const imgErr = await verifyImages([avatarPhoto])
  if (imgErr) {
    await cloud.deleteFile({ fileList: [avatarPhoto] }).catch(e => console.error('clean rejected avatar failed', e))
    return bad(imgErr)
  }

  // 先落库新头像,再删旧文件( 同口径:反过来会出现"档案指向已删文件"的窗口)
  const old = master.avatarPhoto
  await db.collection('masters').doc(master._id).update({ data: { avatarPhoto } })
  // 作废旧头像的未完成检测,避免旧回调把结果打到新头像上( 同口径)
  await db.collection('media_checks').where({ targetId: master._id, type: 'masterAvatar', status: 'pending' })
    .update({ data: { status: 'superseded' } }).catch(e => console.error('supersede avatar checks failed', e))
  if (old && old !== avatarPhoto) {
    // 删失败仅留日志:24h 内更换的旧文件由 upload_logs 孤儿清理兜底(scene avatar)
    try { await deleteFilesStrict([old]) } catch (e) { console.error('clean old avatar failed', master._id, e) }
  }

  // 异步送检(scene 1=资料),违规由 mediaCheckCallback 摘除并删文件
  let avatarUrl = ''
  try {
    const { fileList } = await cloud.getTempFileURL({ fileList: [avatarPhoto] })
    avatarUrl = (fileList[0] && fileList[0].tempFileURL) || ''
    if (avatarUrl) {
      const check = await cloud.openapi.security.mediaCheckAsync({
        mediaUrl: avatarUrl, mediaType: 2, version: 2, scene: 1, openid: OPENID
      })
      const traceId = check.traceId || check.trace_id
      if (traceId) {
        await db.collection('media_checks').add({
          data: { traceId, type: 'masterAvatar', targetId: master._id, fileID: avatarPhoto, status: 'pending', createdAt: db.serverDate() }
        })
      }
    }
  } catch (e) { console.error('avatar mediaCheckAsync submit failed', e) }

  return { ok: true, avatarUrl }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  // 师傅自服务动作(不进入驻申请主流程)
  if (event.action === 'updateAvatar') return updateAvatar(event, OPENID)
  const {
    realName, phone, serviceCity, categories = [], intro = '', companyName = '',
    idCardFront = '', idCardBack = '', certPhotos = [], bizLicensePhoto = ''
  } = event

  if (!realName || realName.trim().length < 2) return bad('请填写真实姓名')
  if (!/^1[3-9]\d{9}$/.test(phone)) return bad('请填写正确的手机号')
  if (!serviceCity) return bad('请填写服务城市')
  // 匹配键校验:手填"青岛"与订单侧"青岛市"归一到同一个 cityKey;
  // 归一后过短的输入(如只填"市"或单字)明确拒绝,不静默保存——否则师傅会永久看不到订单
  const cityKey = normalizeCity(serviceCity)
  if (cityKey.length < 2 || cityKey.length > 15) return bad('服务城市无法识别,请填写所在城市名,如"青岛"')
  // 品类白名单校验:直调云函数也无法写入未定义品类
  const cats = [...new Set(categories)]
  if (!cats.length || cats.some(c => !CATEGORY_KEYS.includes(c))) return bad('服务能力选择不合法')
  if (typeof companyName !== 'string' || companyName.trim().length > 30) return bad('门店/企业名称最多30字')

  // 资质材料:分槽位收集,落库为扁平 qualPhotos + 平行 qualTypes 标注(审核端按标签分组展示)
  // 删除/送检/归属校验等既有机制都只认扁平数组,不感知类型
  // 身份证两面硬性必传(:上线前无老客户端,不留不分类的兼容入口,直调也绕不开实名材料)
  if (typeof idCardFront !== 'string' || !idCardFront) return bad('请上传身份证人像面照片')
  if (typeof idCardBack !== 'string' || !idCardBack) return bad('请上传身份证国徽面照片')
  if (bizLicensePhoto && typeof bizLicensePhoto !== 'string') return bad('营业执照照片不合法')
  const certs = (Array.isArray(certPhotos) ? certPhotos : []).filter(p => typeof p === 'string' && p)
  if (certs.length > 3) return bad('资质证书最多3张')
  const qualPhotos = [idCardFront, idCardBack, ...certs]
  const qualTypes = [QUAL_TYPE.ID_FRONT, QUAL_TYPE.ID_BACK, ...certs.map(() => QUAL_TYPE.CERT)]
  if (bizLicensePhoto) {
    qualPhotos.push(bizLicensePhoto)
    qualTypes.push(QUAL_TYPE.BIZ_LICENSE)
  }
  if (qualPhotos.length > 6) return bad('照片最多6张')
  if (new Set(qualPhotos).size !== qualPhotos.length) return bad('存在重复照片,请检查后重新上传')
  // 照片归属与类型校验
  for (const fid of qualPhotos) {
    if (typeof fid !== 'string' || !fid.includes(`/quals/${OPENID}/`) || !/\.(jpg|jpeg|png)$/i.test(fid)) {
      return bad('资质照片校验失败,请重新上传')
    }
  }
  // 照片归属已验证为本人所有;此后再拒绝就删掉本次上传,避免孤儿文件堆积
  async function badAndClean(msg) {
    await cloud.deleteFile({ fileList: qualPhotos }).catch(e => console.error('clean qualPhotos failed', e))
    return bad(msg)
  }
  // 真实类型与大小校验:扩展名可伪造,按文件魔数核验
  const imgErr = await verifyImages(qualPhotos)
  if (imgErr) return badAndClean(imgErr)
  if (!(await textSafe(`${realName} ${serviceCity} ${companyName} ${intro}`))) return badAndClean('内容含违规信息,请修改后重试')

  const existing = (await db.collection('masters').where({ openid: OPENID }).get()).data[0]
  if (existing && existing.status === 'pending') return badAndClean('已提交过申请,请等待审核')
  if (existing && existing.status === 'approved') return badAndClean('您已是平台师傅,无需重复申请')

  const data = {
    openid: OPENID,
    realName: realName.trim(),
    phone,
    serviceCity: serviceCity.trim(),
    cityKey,               // 匹配键:池/通知/抢单按此匹配,serviceCity 只作展示
    categories: cats,
    intro: intro.trim(),
    companyName: companyName.trim(),
    qualPhotos,
    qualTypes,
    status: 'pending',
    rejectReason: '',
    qualRisk: false,
    memberExpireAt: null,
    stats: { done: 0, reviewCount: 0, totalStars: 0, cancelled: 0 },
    appliedAt: db.serverDate()
  }

  let masterId
  if (existing) {
    // 旧资料替换顺序:先把新资料落库、旧文件记入待清理线索,落库成功后才删旧文件。
    // 反过来(先删后写)会出现"旧文件已删、写库失败"的窗口:档案里的 qualPhotos 指向
    // 已不可恢复的文件,新资料也没挂上。防误删:新资料引用的 fileID 绝不进清理清单
    const toClean = [...new Set([...(existing.orphanQualPhotos || []), ...(existing.qualPhotos || [])])]
      .filter(f => !qualPhotos.includes(f))
    data.orphanQualPhotos = toClean

    // 作废未完成的旧检测,避免旧回调把旧图结果打到新资料上
    await db.collection('media_checks').where({ targetId: existing._id, status: 'pending' })
      .update({ data: { status: 'superseded' } }).catch(e => console.error('supersede media_checks failed', e))

    // 被驳回后重新申请:保留会员/统计字段,覆盖资料
    delete data.memberExpireAt
    delete data.stats
    await db.collection('masters').doc(existing._id).update({ data })
    masterId = existing._id

    // 新资料已在档,现在才清旧文件;删失败保留 orphanQualPhotos 线索,下次重新申请/人工重试收敛,
    // 上传登记清理也把该字段视为已引用,不会误删
    if (toClean.length) {
      try {
        await deleteFilesStrict(toClean)
        await db.collection('masters').doc(existing._id).update({ data: { orphanQualPhotos: [] } })
          .catch(e => console.error('clear orphanQualPhotos failed(文件已删,重试按"不存在=成功"收敛)', existing._id, e))
      } catch (e) {
        console.error('clean old qualPhotos failed, kept in orphanQualPhotos', existing._id, e)
      }
    }
  } else {
    // openid 作文档ID,并发提交幂等
    await db.collection('masters').doc(OPENID).set({ data })
    masterId = OPENID
  }

  // 资质照片异步送检(scene 1=资料),违规由 mediaCheckCallback 标记 qualRisk 供审核参考
  try {
    const { fileList } = await cloud.getTempFileURL({ fileList: qualPhotos })
    for (const f of fileList) {
      if (!f.tempFileURL) continue
      const check = await cloud.openapi.security.mediaCheckAsync({
        mediaUrl: f.tempFileURL, mediaType: 2, version: 2, scene: 1, openid: OPENID
      })
      const traceId = check.traceId || check.trace_id
      if (traceId) {
        await db.collection('media_checks').add({
          data: { traceId, type: 'master', targetId: masterId, fileID: f.fileID, status: 'pending', createdAt: db.serverDate() }
        })
      }
    }
  } catch (e) { console.error('mediaCheckAsync submit failed', e) }

  return { ok: true }
}
