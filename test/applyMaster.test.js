// applyMaster 入驻资质校验(分槽位收集)
// 关键约束:qualTypes 与 qualPhotos 必须平行一致(admin 端按下标配对展示);
// 身份证两面硬性必传,不留不分类的兼容入口
const { fakeDb } = require('./stubs/fakeDb')

// 最小合法 JPEG:魔数 FF D8 FF(mediaFile 只验文件头与大小)
const JPEG = () => Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10])

const fid = (openid, name) => `cloud://test-env.appid/quals/${openid}/${name}.jpg`

function baseEvent(openid) {
  return {
    realName: '李师傅',
    phone: '13800138000',
    serviceCity: '广州市',
    categories: ['repair'],
    intro: '',
    idCardFront: fid(openid, 'front'),
    idCardBack: fid(openid, 'back'),
    certPhotos: [],
    bizLicensePhoto: ''
  }
}

async function apply(openid, event, db) {
  jest.resetModules()
  global.__mockDb = db
  global.__mockCtx = { OPENID: openid }
  global.__mockDownload = JPEG
  global.__deletedFiles = global.__deletedFiles || []
  // 给桩补 openapi:文本/图片送检直接放行,避免走 fail-open 时刷 console.error
  const cloudStub = require('wx-server-sdk')
  cloudStub.openapi = {
    security: {
      msgSecCheck: async () => ({}),
      mediaCheckAsync: async () => ({ traceId: 'trace-' + Math.random().toString(36).slice(2) })
    }
  }
  try {
    const { main } = require('../cloudfunctions/applyMaster/index')
    return await main(event)
  } finally {
    // main 抛错(写库失败注入等)也要还原全局,不污染后续用例
    delete cloudStub.openapi
    delete global.__mockDb
    delete global.__mockCtx
    delete global.__mockDownload
  }
}

afterEach(() => { delete global.__deletedFiles })

describe('applyMaster 分槽位资质校验', () => {
  test('身份证两面 + 证书 + 执照:通过,qualTypes 与 qualPhotos 平行一致', async () => {
    const fx = { masters: [], media_checks: [] }
    const ev = baseEvent('m1')
    ev.certPhotos = [fid('m1', 'cert1'), fid('m1', 'cert2')]
    ev.bizLicensePhoto = fid('m1', 'license')
    ev.companyName = ' 广州快修家电服务部 '
    const r = await apply('m1', ev, fakeDb(fx))
    expect(r.ok).toBe(true)
    const doc = fx.masters[0]
    expect(doc._id).toBe('m1')
    expect(doc.qualPhotos).toEqual([
      fid('m1', 'front'), fid('m1', 'back'), fid('m1', 'cert1'), fid('m1', 'cert2'), fid('m1', 'license')
    ])
    expect(doc.qualTypes).toEqual(['idFront', 'idBack', 'cert', 'cert', 'bizLicense'])
    expect(doc.companyName).toBe('广州快修家电服务部')
    // 每张照片都送内容安全异步检测(回调路径见 mediaCheckCallback)
    expect(fx.media_checks.length).toBe(5)
  })

  test.each([
    ['缺人像面', { idCardFront: '' }, '人像面'],
    ['缺国徽面', { idCardBack: '' }, '国徽面']
  ])('%s -> 拒绝', async (_label, patch, msgPart) => {
    const fx = { masters: [], media_checks: [] }
    const r = await apply('m1', Object.assign(baseEvent('m1'), patch), fakeDb(fx))
    expect(r.ok).toBe(false)
    expect(r.msg).toContain(msgPart)
    expect(fx.masters.length).toBe(0)
  })

  test('证书超过3张 -> 拒绝', async () => {
    const ev = baseEvent('m1')
    ev.certPhotos = ['c1', 'c2', 'c3', 'c4'].map(n => fid('m1', n))
    const r = await apply('m1', ev, fakeDb({ masters: [], media_checks: [] }))
    expect(r.ok).toBe(false)
    expect(r.msg).toContain('最多3张')
  })

  test('冒用他人 openid 路径的照片 -> 拒绝', async () => {
    const ev = baseEvent('m1')
    ev.idCardBack = fid('other-user', 'back')
    const r = await apply('m1', ev, fakeDb({ masters: [], media_checks: [] }))
    expect(r.ok).toBe(false)
    expect(r.msg).toContain('校验失败')
  })

  test('同一张照片塞两个槽位 -> 拒绝', async () => {
    const ev = baseEvent('m1')
    ev.idCardBack = ev.idCardFront
    const r = await apply('m1', ev, fakeDb({ masters: [], media_checks: [] }))
    expect(r.ok).toBe(false)
    expect(r.msg).toContain('重复')
  })

  test('不分类 qualPhotos(老协议/直调绕实名):一律拒绝,要求身份证', async () => {
    const fx = { masters: [], media_checks: [] }
    const ev = baseEvent('m1')
    delete ev.idCardFront
    delete ev.idCardBack
    delete ev.certPhotos
    delete ev.bizLicensePhoto
    ev.qualPhotos = [fid('m1', 'a'), fid('m1', 'b')]
    const r = await apply('m1', ev, fakeDb(fx))
    expect(r.ok).toBe(false)
    expect(r.msg).toContain('身份证人像面')
    expect(fx.masters).toHaveLength(0)
  })

  test('新老字段都没给照片 -> 拒绝', async () => {
    const ev = baseEvent('m1')
    ev.idCardFront = ''
    ev.idCardBack = ''
    const r = await apply('m1', ev, fakeDb({ masters: [], media_checks: [] }))
    expect(r.ok).toBe(false)
  })

  test('门店名超30字 -> 拒绝', async () => {
    const ev = baseEvent('m1')
    ev.companyName = '很'.repeat(31)
    const r = await apply('m1', ev, fakeDb({ masters: [], media_checks: [] }))
    expect(r.ok).toBe(false)
    expect(r.msg).toContain('30')
  })

  test('被驳回后重新提交:旧照片被删除,新资料带类型标注覆盖', async () => {
    const oldPhotos = [fid('m1', 'old1'), fid('m1', 'old2')]
    const fx = {
      masters: [{
        _id: 'm1', openid: 'm1', status: 'rejected', rejectReason: '照片模糊',
        qualPhotos: oldPhotos, qualTypes: [],
        memberExpireAt: null, stats: { done: 3, reviewCount: 1, totalStars: 5, cancelled: 0 }
      }],
      media_checks: []
    }
    global.__deletedFiles = []
    const r = await apply('m1', baseEvent('m1'), fakeDb(fx))
    expect(r.ok).toBe(true)
    expect(global.__deletedFiles).toEqual(expect.arrayContaining(oldPhotos))
    const doc = fx.masters[0]
    expect(doc.status).toBe('pending')
    expect(doc.qualTypes).toEqual(['idFront', 'idBack'])
    // 重新申请保留统计
    expect(doc.stats.done).toBe(3)
  })

  test('旧照片删除失败:fileID 记入 orphanQualPhotos 不丢线索', async () => {
    const oldPhotos = [fid('m1', 'old1'), fid('m1', 'old2')]
    const fx = {
      masters: [{
        _id: 'm1', openid: 'm1', status: 'rejected', rejectReason: '照片模糊',
        qualPhotos: oldPhotos, qualTypes: [],
        memberExpireAt: null, stats: { done: 0, reviewCount: 0, totalStars: 0, cancelled: 0 }
      }],
      media_checks: []
    }
    global.__mockDeleteFile = (fileList) => ({
      fileList: fileList.map(f => ({ fileID: f, status: -1, errMsg: 'timeout' }))
    })
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const r = await apply('m1', baseEvent('m1'), fakeDb(fx))
    delete global.__mockDeleteFile
    errSpy.mockRestore()
    expect(r.ok).toBe(true) // 删除失败不阻断重新申请
    expect(fx.masters[0].orphanQualPhotos).toEqual(oldPhotos)
    expect(fx.masters[0].status).toBe('pending')
  })

  test('写库失败:旧文件不被删除、旧档案原样保留;重试成功后才清旧文件', async () => {
    const oldPhotos = [fid('m1', 'old1'), fid('m1', 'old2')]
    const master = () => ({
      _id: 'm1', openid: 'm1', status: 'rejected', rejectReason: '照片模糊',
      qualPhotos: [...oldPhotos], qualTypes: [],
      memberExpireAt: null, stats: { done: 0, reviewCount: 0, totalStars: 0, cancelled: 0 }
    })
    const fx = { masters: [master()], media_checks: [] }
    global.__deletedFiles = []
    global.__failUpdate = (col, f) => col === 'masters' && f._id === 'm1'
    await expect(apply('m1', baseEvent('m1'), fakeDb(fx))).rejects.toThrow()
    delete global.__failUpdate

    // 关键验收:旧文件仍可读取(一个都没删),档案保持原资料原状态
    expect(global.__deletedFiles).toEqual([])
    expect(fx.masters[0].qualPhotos).toEqual(oldPhotos)
    expect(fx.masters[0].status).toBe('rejected')

    // 重试(故障恢复):新资料先落库,旧文件此时才被删除
    const r = await apply('m1', baseEvent('m1'), fakeDb(fx))
    expect(r.ok).toBe(true)
    expect(global.__deletedFiles).toEqual(expect.arrayContaining(oldPhotos))
    expect(fx.masters[0].status).toBe('pending')
    expect(fx.masters[0].orphanQualPhotos).toEqual([])
  })

  test('重复提交沿用当前版本的文件:不会被当旧文件误删', async () => {
    const keep = fid('m1', 'front')   // 与新提交的 idCardFront 相同
    const fx = {
      masters: [{
        _id: 'm1', openid: 'm1', status: 'rejected', rejectReason: '证书模糊',
        qualPhotos: [keep, fid('m1', 'oldcert')], qualTypes: [],
        memberExpireAt: null, stats: { done: 0, reviewCount: 0, totalStars: 0, cancelled: 0 }
      }],
      media_checks: []
    }
    global.__deletedFiles = []
    const r = await apply('m1', baseEvent('m1'), fakeDb(fx))
    expect(r.ok).toBe(true)
    expect(global.__deletedFiles).toEqual([fid('m1', 'oldcert')])   // 只删真正弃用的
    expect(fx.masters[0].qualPhotos).toContain(keep)
  })

  test('历史 orphanQualPhotos 随本次替换一并清理,清净后线索归零', async () => {
    const orphan = fid('m1', 'orphan-old')
    const fx = {
      masters: [{
        _id: 'm1', openid: 'm1', status: 'rejected', rejectReason: 'x',
        qualPhotos: [fid('m1', 'old1')], qualTypes: [], orphanQualPhotos: [orphan],
        memberExpireAt: null, stats: { done: 0, reviewCount: 0, totalStars: 0, cancelled: 0 }
      }],
      media_checks: []
    }
    global.__deletedFiles = []
    const r = await apply('m1', baseEvent('m1'), fakeDb(fx))
    expect(r.ok).toBe(true)
    expect(global.__deletedFiles).toEqual(expect.arrayContaining([orphan, fid('m1', 'old1')]))
    expect(fx.masters[0].orphanQualPhotos).toEqual([])
  })
})

describe('updateCategories 服务能力自助调整', () => {
  const approvedMaster = (over = {}) => Object.assign({
    _id: 'm1', openid: 'm1', status: 'approved', categories: ['repair', 'clean'],
    memberExpireAt: Date.now() + 86400000,
    stats: { done: 0, reviewCount: 0, totalStars: 0, cancelled: 0 }
  }, over)

  test('认证师傅补充新品类:落库即生效', async () => {
    const fx = { masters: [approvedMaster()] }
    const r = await apply('m1', { action: 'updateCategories', categories: ['repair', 'clean', 'coldRepair', 'chillerRepair'] }, fakeDb(fx))
    expect(r.ok).toBe(true)
    expect(fx.masters[0].categories).toEqual(['repair', 'clean', 'coldRepair', 'chillerRepair'])
  })

  test('收缩品类也允许(取消勾选即不再接该类单)', async () => {
    const fx = { masters: [approvedMaster()] }
    const r = await apply('m1', { action: 'updateCategories', categories: ['repair'] }, fakeDb(fx))
    expect(r.ok).toBe(true)
    expect(fx.masters[0].categories).toEqual(['repair'])
  })

  test('与现有集合相同(顺序不同):幂等返回成功,不改动档案', async () => {
    const fx = { masters: [approvedMaster()] }
    const r = await apply('m1', { action: 'updateCategories', categories: ['clean', 'repair'] }, fakeDb(fx))
    expect(r.ok).toBe(true)
    expect(fx.masters[0].categories).toEqual(['repair', 'clean'])
  })

  test.each([
    ['非师傅', []],
    ['审核中', [approvedMaster({ status: 'pending' })]],
    ['被驳回', [approvedMaster({ status: 'rejected' })]]
  ])('%s -> 拒绝', async (_label, masters) => {
    const fx = { masters }
    const r = await apply('m1', { action: 'updateCategories', categories: ['coldRepair'] }, fakeDb(fx))
    expect(r.ok).toBe(false)
    expect(r.msg).toContain('仅认证师傅')
  })

  test.each([
    ['空数组', [], '不合法'],
    ['非数组', undefined, '不合法'],
    ['混入未定义品类', ['repair', 'tv'], '不合法']
  ])('%s -> 拒绝', async (_label, categories, msgPart) => {
    const fx = { masters: [approvedMaster()] }
    const r = await apply('m1', { action: 'updateCategories', categories }, fakeDb(fx))
    expect(r.ok).toBe(false)
    expect(r.msg).toContain(msgPart)
    expect(fx.masters[0].categories).toEqual(['repair', 'clean'])
  })
})

describe('资质材料类型的前后端契约', () => {
  test('前端 QUAL_TYPES 与后端母本 QUAL_TYPE 的 key 集合一致', () => {
    const { QUAL_TYPES } = require('../miniprogram/utils/constants')
    const { QUAL_TYPE } = require('../cloudfunctions/_shared/biz')
    expect(QUAL_TYPES.map(t => t.key).sort()).toEqual(Object.values(QUAL_TYPE).sort())
  })
})

describe('updateAvatar 展示头像(入驻后选填,不卡在申请环节)', () => {
  const afid = (openid, name) => `cloud://test-env.appid/avatars/${openid}/${name}.jpg`
  const approvedMaster = (over = {}) => Object.assign({
    _id: 'm1', openid: 'm1', status: 'approved',
    memberExpireAt: Date.now() + 86400000,
    stats: { done: 0, reviewCount: 0, totalStars: 0, cancelled: 0 }
  }, over)

  test('认证师傅设置头像:先落库、旧文件后删、送检登记 masterAvatar', async () => {
    const fx = { masters: [approvedMaster({ avatarPhoto: afid('m1', 'old') })], media_checks: [] }
    global.__deletedFiles = []
    const r = await apply('m1', { action: 'updateAvatar', avatarPhoto: afid('m1', 'new') }, fakeDb(fx))
    expect(r.ok).toBe(true)
    expect(r.avatarUrl).toContain('https://tmp/')
    expect(fx.masters[0].avatarPhoto).toBe(afid('m1', 'new'))
    expect(global.__deletedFiles).toEqual([afid('m1', 'old')])
    expect(fx.media_checks).toHaveLength(1)
    expect(fx.media_checks[0]).toMatchObject({
      type: 'masterAvatar', targetId: 'm1', fileID: afid('m1', 'new'), status: 'pending'
    })
  })

  test('首次设置(无旧头像):不删任何文件', async () => {
    const fx = { masters: [approvedMaster()], media_checks: [] }
    global.__deletedFiles = []
    const r = await apply('m1', { action: 'updateAvatar', avatarPhoto: afid('m1', 'a') }, fakeDb(fx))
    expect(r.ok).toBe(true)
    expect(global.__deletedFiles).toEqual([])
    expect(fx.masters[0].avatarPhoto).toBe(afid('m1', 'a'))
  })

  test('非师傅/审核中/被驳回 -> 拒绝,不产生送检记录', async () => {
    for (const masters of [
      [],
      [approvedMaster({ status: 'pending' })],
      [approvedMaster({ status: 'rejected' })]
    ]) {
      const fx = { masters, media_checks: [] }
      const r = await apply('m1', { action: 'updateAvatar', avatarPhoto: afid('m1', 'a') }, fakeDb(fx))
      expect(r.ok).toBe(false)
      expect(r.msg).toContain('仅认证师傅')
      expect(fx.media_checks).toHaveLength(0)
    }
  })

  test('冒用他人命名空间的文件 -> 拒绝', async () => {
    const fx = { masters: [approvedMaster()], media_checks: [] }
    const r = await apply('m1', { action: 'updateAvatar', avatarPhoto: afid('other', 'a') }, fakeDb(fx))
    expect(r.ok).toBe(false)
    expect(r.msg).toContain('校验失败')
    expect(fx.masters[0].avatarPhoto).toBeUndefined()
  })
})
