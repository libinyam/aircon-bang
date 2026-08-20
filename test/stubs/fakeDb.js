// 极简内存数据库,模拟 wx-server-sdk 的 db 链式调用(仅覆盖被测云函数用到的路径)
// fixtures: { 集合名: [文档, ...] }
// - where 支持浅层等值 + in/neq/gt/lt 命令
// - add 强制 _id 唯一(幂等写入模式依赖这一点,与真库行为一致)
// - update 支持 inc 命令与 'stats.done' 式点号路径
function fakeDb(fixtures) {
  const cmd = {
    in: (v) => ({ __cmd: 'in', v }),
    neq: (v) => ({ __cmd: 'neq', v }),
    gt: (v) => ({ __cmd: 'gt', v }),
    lt: (v) => ({ __cmd: 'lt', v }),
    inc: (v) => ({ __cmd: 'inc', v }),
    pull: (v) => ({ __cmd: 'pull', v })
  }
  // 等值匹配:Date 按时间值比较(真库行为);其余严格相等
  const valEq = (a, b) => {
    if (a instanceof Date || b instanceof Date) {
      return a != null && b != null && new Date(a).getTime() === new Date(b).getTime()
    }
    return a === b
  }
  const matches = (row, q) => Object.entries(q).every(([k, v]) => {
    if (v && v.__cmd === 'in') return v.v.includes(row[k])
    if (v && v.__cmd === 'neq') return row[k] !== v.v
    if (v && v.__cmd === 'gt') return row[k] > v.v
    if (v && v.__cmd === 'lt') return row[k] < v.v
    return valEq(row[k], v)
  })
  const setPath = (obj, dotted, val) => {
    const parts = dotted.split('.')
    let o = obj
    for (const p of parts.slice(0, -1)) o = o[p] = o[p] || {}
    o[parts[parts.length - 1]] = val
  }
  const getPath = (obj, dotted) => dotted.split('.').reduce((o, p) => (o || {})[p], obj)
  const applyUpdate = (row, data) => {
    for (const [k, v] of Object.entries(data)) {
      if (v && v.__cmd === 'inc') setPath(row, k, (getPath(row, k) || 0) + v.v)
      else if (v && v.__cmd === 'pull') setPath(row, k, (getPath(row, k) || []).filter(x => x !== v.v))
      else setPath(row, k, v)
    }
  }
  return {
    command: cmd,
    serverDate: () => new Date(),
    Geo: { Point: (lng, lat) => ({ type: 'Point', coordinates: [lng, lat] }) },
    collection(name) {
      const rows = fixtures[name] || (fixtures[name] = [])
      const query = (filter) => ({
        orderBy: () => query(filter),
        skip: () => query(filter),
        limit: () => query(filter),
        // 读取返回深拷贝:真库的查询结果是快照,不随后续 update 变化(structuredClone 保留 Date)
        async get() { return { data: structuredClone(rows.filter(r => matches(r, filter))) } },
        async count() { return { total: rows.filter(r => matches(r, filter)).length } },
        async update({ data }) {
          // 故障注入:global.__failUpdate = (集合名, where条件) => bool,命中则抛数据库异常
          if (global.__failUpdate && global.__failUpdate(name, filter)) {
            throw new Error('db update failed (injected)')
          }
          const hit = rows.filter(r => matches(r, filter))
          hit.forEach(r => applyUpdate(r, data))
          return { stats: { updated: hit.length } }
        },
        async remove() {
          // 条件批量删除(真库 where().remove());与 doc.remove 共用注入钩子,第二参传 where 条件
          if (global.__failRemove && global.__failRemove(name, filter)) {
            throw new Error('db remove failed (injected)')
          }
          const hit = rows.filter(r => matches(r, filter))
          for (const r of hit) rows.splice(rows.indexOf(r), 1)
          return { stats: { removed: hit.length } }
        }
      })
      return {
        // 允许不带 where 直接 orderBy/limit/get(admin health、allMasters 等用)
        orderBy: () => query({}),
        limit: () => query({}),
        skip: () => query({}),
        get: () => query({}).get(),
        count: () => query({}).count(),
        doc(id) {
          return {
            async get() {
              const row = rows.find(r => r._id === id)
              if (!row) throw new Error('document not found')
              return { data: structuredClone(row) }
            },
            async update({ data }) {
              // 与条件更新共用同一注入钩子,doc 路径以 { _id } 形状传入
              if (global.__failUpdate && global.__failUpdate(name, { _id: id })) {
                throw new Error('db update failed (injected)')
              }
              const row = rows.find(r => r._id === id)
              if (row) applyUpdate(row, data)
              return { stats: { updated: row ? 1 : 0 } }
            },
            async set({ data }) {
              const i = rows.findIndex(r => r._id === id)
              const doc = Object.assign({ _id: id }, data)
              if (i >= 0) rows[i] = doc; else rows.push(doc)
              return { stats: { updated: i >= 0 ? 1 : 0 } }
            },
            async remove() {
              // 故障注入:global.__failRemove = (集合名, 文档id) => bool,命中则抛数据库异常
              if (global.__failRemove && global.__failRemove(name, id)) {
                throw new Error('db remove failed (injected)')
              }
              const i = rows.findIndex(r => r._id === id)
              if (i >= 0) rows.splice(i, 1)
              return { stats: { removed: i >= 0 ? 1 : 0 } }
            }
          }
        },
        where: (q) => query(q),
        async add({ data }) {
          // 故障注入:global.__failNextAdd = true 时下一次 add 抛通用写失败(非 _id 冲突)
          if (global.__failNextAdd) {
            global.__failNextAdd = false
            throw new Error('db write failed (injected)')
          }
          if (data._id !== undefined && rows.some(r => r._id === data._id)) {
            throw new Error('duplicate _id: ' + data._id) // 与真库一致:_id 冲突写入失败
          }
          rows.push(data)
          return { _id: data._id || 'auto-' + rows.length }
        }
      }
    }
  }
}

module.exports = { fakeDb }
