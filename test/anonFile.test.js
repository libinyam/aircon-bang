// 匿名副本换链助手专项:复制/映射复用/失败兜底的红线都钉在这里。
// 红线:含 openid 的 fileID 与 URL 不出助手;任何环节失败该文件空链,绝不回退源路径
const { fakeDb } = require('./stubs/fakeDb')
const makeAnon = require('../cloudfunctions/_shared/anonFile')

// 手工 cloud 桩(不经过 wx-server-sdk 桩,直接控到每次调用)
function mkCloud(over = {}) {
  const calls = { download: [], upload: [], sign: [] }
  return Object.assign({
    calls,
    async downloadFile({ fileID }) { calls.download.push(fileID); return { fileContent: Buffer.from('img') } },
    async uploadFile({ cloudPath }) { calls.upload.push(cloudPath); return { fileID: 'cloud://env.x/' + cloudPath } },
    async getTempFileURL({ fileList }) {
      calls.sign.push(...fileList)
      return { fileList: fileList.map(f => ({ fileID: f, tempFileURL: 'https://cdn/' + f.replace(/^cloud:\/\/[^/]+\//, '') })) }
    }
  }, over)
}

const SRC = 'cloud://env.x/orders/user-openid-1/123-0-abcd.jpg'

describe('anonFile 匿名副本换链', () => {
  test('首次下发:复制到匿名路径+映射落库,临时链基于副本,全程不见 openid', async () => {
    const cloud = mkCloud()
    const db = fakeDb({})
    const get = makeAnon(cloud, db)
    const r = await get([SRC])
    // 复制路径不含 openid,保留扩展名
    expect(cloud.calls.upload).toHaveLength(1)
    expect(cloud.calls.upload[0]).toMatch(/^alias\/[0-9a-f]{32}\.jpg$/)
    // 换链只针对副本 fileID
    expect(cloud.calls.sign).toHaveLength(1)
    expect(cloud.calls.sign[0]).not.toContain('user-openid-1')
    // 返回按源 fileID 键控(调用方 urlMap 不用改),URL 不含 openid
    expect(r.fileList).toHaveLength(1)
    expect(r.fileList[0].fileID).toBe(SRC)
    expect(r.fileList[0].tempFileURL).toContain('https://cdn/alias/')
    expect(r.fileList[0].tempFileURL).not.toContain('user-openid-1')
    // 映射落库
    const alias = (await db.collection('file_aliases').doc(SRC).get()).data
    expect(alias.alias).toContain('alias/')
  })

  test('二次下发:命中映射不再复制,只重新签临时链', async () => {
    const cloud = mkCloud()
    const db = fakeDb({})
    const get = makeAnon(cloud, db)
    await get([SRC])
    const r = await get([SRC])
    expect(cloud.calls.download).toHaveLength(1)
    expect(cloud.calls.upload).toHaveLength(1)
    expect(cloud.calls.sign).toHaveLength(2)
    expect(r.fileList[0].tempFileURL).toContain('https://cdn/alias/')
  })

  test('复制失败:该文件空链,不抛出、不换链(响应侧自然不含 openid)', async () => {
    const cloud = mkCloud({
      async downloadFile() { throw new Error('storage down') }
    })
    const db = fakeDb({})
    const r = await makeAnon(cloud, db)([SRC])
    expect(r.fileList[0].tempFileURL).toBe('')
    // fileID 键是给调用方映射用的服务端内部结构;出云函数的只有 tempFileURL,
    // 空链即什么都不泄露(池/详情响应级断言见 poolPrivacy/getOrdersDetail/getListings)
    expect(cloud.calls.upload).toHaveLength(0)
    expect(cloud.calls.sign).toHaveLength(0)
  })

  test('换链整批抛错:全部空链,不抛出', async () => {
    const cloud = mkCloud({
      async getTempFileURL() { throw new Error('sign failed') }
    })
    const db = fakeDb({})
    const r = await makeAnon(cloud, db)([SRC])
    expect(r.fileList[0].tempFileURL).toBe('')
  })

  test('映射查询失败:按未命中处理走复制,功能不受影响', async () => {
    const cloud = mkCloud()
    const db = fakeDb({})
    // 让 file_aliases 的 where 查询抛错(doc.get 在 ensureAlias 里另有 catch)
    const origCollection = db.collection.bind(db)
    db.collection = (name) => {
      const c = origCollection(name)
      if (name === 'file_aliases') {
        c.where = () => { throw new Error('query failed') }
      }
      return c
    }
    const r = await makeAnon(cloud, db)([SRC])
    expect(r.fileList[0].tempFileURL).toContain('https://cdn/alias/')
    expect(cloud.calls.upload).toHaveLength(1)
  })

  test('空输入与空值过滤:不发起任何存储调用', async () => {
    const cloud = mkCloud()
    const db = fakeDb({})
    const get = makeAnon(cloud, db)
    expect((await get([])).fileList).toEqual([])
    expect((await get(null)).fileList).toEqual([])
    const r = await get(['', SRC])
    expect(r.fileList).toHaveLength(1)
    expect(cloud.calls.upload).toHaveLength(1)
  })

  test('并发重复登记:映射冲突回读现成 alias,返回值不受影响', async () => {
    const cloud = mkCloud()
    const existing = 'cloud://env.x/alias/existing123.jpg'
    const db = fakeDb({ file_aliases: [{ _id: SRC, alias: existing }] })
    const r = await makeAnon(cloud, db)([SRC])
    expect(cloud.calls.upload).toHaveLength(0)
    expect(r.fileList[0].tempFileURL).toBe('https://cdn/alias/existing123.jpg')
  })
})
