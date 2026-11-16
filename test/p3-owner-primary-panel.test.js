// P3 验收回归：主账号控制面（GET /platforms/people、POST /platforms/owner/primary、/platforms/people/fixed 非主人限制、/save 一致性、重启持久化、/test-send、api.ownerRoute、前端 TAB_KEYS/GlobalAccess/Platforms）。
import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Script } from 'node:vm'

const tempDirs = []
function freshDataDir(prefix = 'aurabot-p3-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  process.env.AURABOT_DATA_DIR = dir
  return dir
}

let hostMod
let normalize
let createIdentity
let createModules
let createFakeDsh
let makeFakeAdapter
let makeTestIdentity

before(async () => {
  freshDataDir('aurabot-p3-boot-')
  hostMod = await import('../src/host.js')
  ;({ normalize } = await import('../src/core/config.js'))
  ;({ createIdentity } = await import('../src/gateway/identity.js'))
  ;({ createModules } = await import('../src/core/modules.js'))
  ;({ createFakeDsh } = await import('./helpers/fake-dsh.js'))
  ;({ makeFakeAdapter } = await import('./helpers/fake-adapter.js'))
  ;({ makeTestIdentity } = await import('./helpers/identity.js'))
})

beforeEach(() => {
  freshDataDir('aurabot-p3-case-')
})

async function startHost(t, { dataDir = process.env.AURABOT_DATA_DIR, seedConfig, seedOwnerAccounts = [] } = {}) {
  process.env.AURABOT_DATA_DIR = dataDir
  const seedId = createIdentity({ dataDir: join(dataDir, 'gateway'), log: { info() {}, warn() {}, debug() {} } })
  const ownerPerson = seedId.claimOwner('qq', '10001')
  for (const [plat, acc] of seedOwnerAccounts) {
    seedId.link(plat, acc, ownerPerson, 'manual')
  }

  const cfgObj = normalize({
    enabled: true,
    dryRun: false,
    ownerQQ: '10001',
    snowluma: { autoStart: false },
    merge: { enabled: false },
    allow: { private: [], groups: [] },
    platforms: {
      bridge: { enabled: true },
      'bridge#2': { enabled: true },
      feishu: { enabled: true, caps: { proactive: 'none' } },
    },
    ...(seedConfig || {}),
  })
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify(cfgObj), 'utf8')

  const fake = createFakeDsh({ brain: async () => '好的' })
  const applied = hostMod.apply(fake.ctx)
  t.after(async () => {
    try { await applied.gateway?.stopAll?.() } catch {}
    try { applied.modules?.dispose?.() } catch {}
    try { applied.onebot?.disconnect?.() } catch {}
    try { fake.dispose() } catch {}
  })

  const adapters = new Map()
  if (applied.gateway) {
    applied.gateway.register(() => {
      const adapter = makeFakeAdapter({ id: 'bridge', name: 'Bridge' })
      const origStart = adapter.start
      adapter.start = async (ctx) => { adapters.set(ctx.instance, adapter); return origStart(ctx) }
      return adapter
    })
    applied.gateway.register(() => {
      const adapter = makeFakeAdapter({ id: 'feishu', name: '飞书', caps: { proactive: 'none' } })
      const origStart = adapter.start
      adapter.start = async (ctx) => { adapters.set(ctx.instance, adapter); return origStart(ctx) }
      return adapter
    })
    await applied.gateway.sync()
  }
  await applied.ready

  return { fake, applied, adapters, ownerPerson }
}

test('P3-1: api.ownerRoute() 暴露结构化主账号路由，blocked/no-route 时绝不穿透 QQ', async (t) => {
  const dir = freshDataDir('aurabot-p3-mod-')
  const identity = makeTestIdentity('10001', 'qq', { personId: 'owner-mod' })
  identity.setOwner('b_two', 'bridge', 'owner-mod')
  let routeState = {
    chatId: 'bridge#2:private:b_two',
    blocked: false,
    reason: 'ok',
    target: { platform: 'bridge', instance: 'bridge#2', account: 'b_two' },
    fallbackUsed: false,
  }
  let capturedApi = null
  const mods = createModules({
    ctx: {},
    core: {
      identity,
      resolveOwnerRoute: () => routeState,
      routeOwner: () => 'private:10001',
      hub: { ownerChat: () => 'private:10001', sendText: async () => ({ message_id: 'm1' }) },
      onebot: { call: async () => null },
      ask: async () => '',
    },
    getConfig: () => normalize({ ownerQQ: '10001' }),
    setConfig: () => {},
    logger: { child: () => ({ info() {}, warn() {}, debug() {}, error() {} }) },
    version: 'test',
    builtins: [{ id: 'p3-probe', name: 'p3-probe', platforms: ['*'], setup(api) { capturedApi = api; return {} } }],
  })
  t.after(() => mods.dispose())
  await mods.boot()
  assert.ok(dir)
  assert.deepEqual(capturedApi.ownerRoute(), routeState)
  assert.equal(capturedApi.ownerChat(), 'bridge#2:private:b_two')

  routeState = {
    chatId: '',
    blocked: true,
    reason: 'primary-offline',
    target: { platform: 'bridge', instance: 'bridge#2', account: 'b_two' },
    fallbackUsed: false,
  }
  assert.deepEqual(capturedApi.ownerRoute(), routeState)
  assert.equal(capturedApi.ownerChat(), '', 'blocked 时 ownerChat 返回空串不回退 QQ')

  routeState = { chatId: '', blocked: false, reason: 'no-route', target: null, fallbackUsed: false }
  assert.deepEqual(capturedApi.ownerRoute(), { chatId: '', blocked: false, reason: 'no-route', target: null, fallbackUsed: false })
  assert.equal(capturedApi.ownerChat(), '')
})

test('P3-2: GET /platforms/people 展开多实例选项、标注 proactive=none 禁用态且纯只读不误记阻塞态', async (t) => {
  const { fake, applied, adapters } = await startHost(t, {
    seedOwnerAccounts: [['bridge', 'b_acc'], ['feishu', 'ou_nop'], ['qqbot', 'qb_noinst']],
    seedConfig: {
      ownerPrimary: { mode: 'fixed', platform: 'bridge', instance: 'bridge#2', account: 'b_acc', fallback: false, noticeFallback: true },
    },
  })

  // 先让 b_acc 在 bridge#2 上入站，验证多实例下未观测实例 bridge 与无实例平台 qqbot 在 ownerAccountOptions 中均禁用（selectable=false）
  adapters.get('bridge#2').pushInbound({
    chat: { kind: 'private', id: 'b_acc' },
    sender: { account: 'b_acc', name: '主人2' },
    parts: [{ type: 'text', text: '在线2' }],
  })
  const pBeforeObs = (await fake.call('/platforms/people')).json()
  const preB1 = (pBeforeObs.ownerAccountOptions || []).find((o) => o.platform === 'bridge' && o.instance === 'bridge' && o.account === 'b_acc')
  const preB2 = (pBeforeObs.ownerAccountOptions || []).find((o) => o.platform === 'bridge' && o.instance === 'bridge#2' && o.account === 'b_acc')
  const preNoInst = (pBeforeObs.ownerAccountOptions || []).find((o) => o.platform === 'qqbot' && o.account === 'qb_noinst')
  assert.equal(preB1?.observed, false)
  assert.equal(preB1?.selectable, false, '多实例未在该实例观测到的账号必须标为不可选')
  assert.equal(preB2?.observed, true)
  assert.equal(preB2?.selectable, true)
  assert.equal(preNoInst?.hasInstance, false)
  assert.equal(preNoInst?.selectable, false, '没有配置平台实例的主账号选项必须标为不可选')

  // 再让 b_acc 在 bridge 上也入站，建立双实例观测归属，以便断线回退测试
  adapters.get('bridge').pushInbound({
    chat: { kind: 'private', id: 'b_acc' },
    sender: { account: 'b_acc', name: '主人1' },
    parts: [{ type: 'text', text: '在线1' }],
  })

  // 断掉 bridge#2，验证只读轮询 /platforms/people 不污染 lastBlockedRoute，且不产生 router.json 写副作用
  adapters.get('bridge#2').disconnect()
  const routerFile = join(process.env.AURABOT_DATA_DIR, 'gateway', 'router.json')
  const beforeRouter = existsSync(routerFile) ? readFileSync(routerFile, 'utf8') : ''

  const p1 = (await fake.call('/platforms/people')).json()
  assert.equal(p1.ok, true)
  assert.equal(p1.ownerPrimary.instance, 'bridge#2')
  assert.equal(p1.resolvedProactiveRoute.blocked, true)
  assert.equal(p1.resolvedProactiveRoute.reason, 'primary-offline')
  assert.equal(p1.resolvedNoticeRoute.blocked, false, 'noticeFallback=true 时 notice 路由允许回退到在线 bridge')
  assert.equal(p1.resolvedNoticeRoute.fallbackUsed, true)
  assert.equal(p1.lastBlockedRoute, null, '纯面板只读查看不应伪造运行期 lastBlockedRoute')

  const opts = p1.ownerAccountOptions || []
  const b1 = opts.find((o) => o.platform === 'bridge' && o.instance === 'bridge' && o.account === 'b_acc')
  const b2 = opts.find((o) => o.platform === 'bridge' && o.instance === 'bridge#2' && o.account === 'b_acc')
  const fsNop = opts.find((o) => o.platform === 'feishu' && o.account === 'ou_nop')
  const qqLegacy = opts.find((o) => o.platform === 'qq' && o.account === '10001')
  assert.ok(b1 && b2, '多实例 bridge 与 bridge#2 均应出现在 ownerAccountOptions 中')
  assert.equal(b1.multiInstance, true)
  assert.equal(b2.multiInstance, true)
  assert.equal(b2.state, 'disconnected')
  assert.equal(fsNop?.canProactive, false, 'caps.proactive=none 的实例应标为不可设为主账号')
  assert.equal(qqLegacy?.legacy, true)

  // 运行期真实调用 resolveOwnerRoute 才记入 lastBlockedRoute
  const rt = applied.resolveOwnerRoute({ purpose: 'proactive' })
  assert.equal(rt.blocked, true)
  const p2 = (await fake.call('/platforms/people')).json()
  assert.equal(p2.lastBlockedRoute?.reason, 'primary-offline')
  const afterRouter = existsSync(routerFile) ? readFileSync(routerFile, 'utf8') : ''
  assert.equal(afterRouter, beforeRouter, 'GET /platforms/people 与 resolveOwnerRoute 不得写 router.json')
})

test('P3-3: /platforms/people/fixed 仅非主人；/platforms/owner/primary 与 /save 一致清理 router.fixed 且重启持久化', async (t) => {
  const dirA = freshDataDir('aurabot-p3-consistency-a-')
  const hostA = await startHost(t, {
    dataDir: dirA,
    seedOwnerAccounts: [['bridge', 'b_acc'], ['feishu', 'ou_nop']],
  })
  hostA.adapters.get('bridge#2').pushInbound({
    chat: { kind: 'private', id: 'b_acc' },
    sender: { account: 'b_acc', name: '主人' },
    parts: [{ type: 'text', text: 'hi' }],
  })
  // 预写入历史 router.fixed[owner]，以及一个非主人访客
  hostA.applied.gateway.routing.setFixed(hostA.ownerPerson, 'qq')
  const guestPerson = hostA.applied.gateway.identity.resolve('bridge', 'guest_9')
  hostA.applied.memory.add({ text: '访客小王', about: guestPerson, aboutName: '小王', source: 'panel' })

  // 1) /platforms/people/fixed 禁止修改主人，正常放行非主人
  const ownerFixRes = (await hostA.fake.call('/platforms/people/fixed', { person: hostA.ownerPerson, platform: 'bridge' })).json()
  assert.equal(ownerFixRes.ok, false)
  assert.match(ownerFixRes.message, /权限 → 主人/)
  assert.equal(hostA.applied.gateway.routing.fixedPlatform(hostA.ownerPerson), 'qq', '拒绝后原有残留暂保持，不走旁路改写')

  const guestFixRes = (await hostA.fake.call('/platforms/people/fixed', { person: guestPerson, platform: 'bridge' })).json()
  assert.equal(guestFixRes.ok, true)
  assert.equal(hostA.applied.gateway.routing.fixedPlatform(guestPerson), 'bridge')

  // 2) /platforms/owner/primary 拒绝 caps.proactive=none 实例、不存在平台/实例、他人账号、以及未观测多实例账号
  const rejectNone = (await hostA.fake.call('/platforms/owner/primary', { mode: 'fixed', platform: 'feishu', instance: 'feishu', account: 'ou_nop' })).json()
  assert.equal(rejectNone.ok, false)
  assert.match(rejectNone.message, /仅支持回复/)

  const rejectNoneNoInst = (await hostA.fake.call('/platforms/owner/primary', { mode: 'fixed', platform: 'feishu', account: 'ou_nop' })).json()
  assert.equal(rejectNoneNoInst.ok, false)
  assert.match(rejectNoneNoInst.message, /仅支持回复/)

  const rejectMissingInst = (await hostA.fake.call('/platforms/owner/primary', { mode: 'fixed', platform: 'bridge', instance: 'bridge#99', account: 'b_acc' })).json()
  assert.equal(rejectMissingInst.ok, false)

  const rejectForeignAcc = (await hostA.fake.call('/platforms/owner/primary', { mode: 'fixed', platform: 'bridge', instance: 'bridge#2', account: 'stranger_999' })).json()
  assert.equal(rejectForeignAcc.ok, false)
  assert.match(rejectForeignAcc.message, /未绑定在当前主人名下/)

  const rejectUnobserved = (await hostA.fake.call('/platforms/owner/primary', { mode: 'fixed', platform: 'bridge', instance: 'bridge', account: 'b_acc' })).json()
  assert.equal(rejectUnobserved.ok, false)
  assert.match(rejectUnobserved.message, /尚未在实例「bridge」观测到/)

  const rejectNoInstance = (await hostA.fake.call('/platforms/owner/primary', { mode: 'fixed', platform: 'qqbot', instance: 'qqbot', account: 'qb_noinst' })).json()
  assert.equal(rejectNoInstance.ok, false)
  assert.match(rejectNoInstance.message, /找不到平台实例/)

  // 3) 通过 POST /platforms/owner/primary 设置并对比另一套干净实例上的 POST /save
  const primaryPatch = { mode: 'fixed', platform: 'bridge', instance: 'bridge#2', account: 'b_acc', fallback: false, noticeFallback: true }
  const setByPrimary = (await hostA.fake.call('/platforms/owner/primary', primaryPatch)).json()
  assert.equal(setByPrimary.ok, true)
  assert.deepEqual(setByPrimary.ownerPrimary, primaryPatch)
  assert.ok(!hostA.applied.gateway.routing.fixedPlatform(hostA.ownerPerson), 'router.fixed[owner] 应在切换后被幂等清空')

  const dirB = freshDataDir('aurabot-p3-consistency-b-')
  const hostB = await startHost(t, {
    dataDir: dirB,
    seedOwnerAccounts: [['bridge', 'b_acc'], ['feishu', 'ou_nop']],
  })
  hostB.adapters.get('bridge#2').pushInbound({
    chat: { kind: 'private', id: 'b_acc' },
    sender: { account: 'b_acc', name: '主人' },
    parts: [{ type: 'text', text: 'hi' }],
  })
  hostB.applied.gateway.routing.setFixed(hostB.ownerPerson, 'qq')
  const setBySave = (await hostB.fake.call('/save', { ownerPrimary: primaryPatch })).json()
  assert.equal(setBySave.ok, true)
  assert.deepEqual(setBySave.config.ownerPrimary, setByPrimary.ownerPrimary)
  assert.ok(!hostB.applied.gateway.routing.fixedPlatform(hostB.ownerPerson), '/save 也必须清理 router.fixed[owner]')

  // 4) 单字段清空 account='' 重新解析，以及切 recent 清空旧平台字段（两边一致）
  const clearAccA = (await hostA.fake.call('/platforms/owner/primary', { mode: 'fixed', platform: 'bridge', instance: 'bridge#2', account: '' })).json()
  const clearAccB = (await hostB.fake.call('/save', { ownerPrimary: { mode: 'fixed', platform: 'bridge', instance: 'bridge#2', account: '' } })).json()
  assert.deepEqual(clearAccA.ownerPrimary, clearAccB.config.ownerPrimary)
  assert.equal(clearAccA.ownerPrimary.account, '')
  assert.equal(clearAccA.resolvedProactiveRoute.chatId, 'bridge#2:private:b_acc')

  const recentA = (await hostA.fake.call('/platforms/owner/primary', { mode: 'recent' })).json()
  const recentB = (await hostB.fake.call('/save', { ownerPrimary: { mode: 'recent' } })).json()
  assert.deepEqual(recentA.ownerPrimary, { mode: 'recent', platform: '', instance: '', account: '', fallback: false, noticeFallback: true })
  assert.deepEqual(recentA.ownerPrimary, recentB.config.ownerPrimary)

  // 5) 先切回 fixed bridge#2，再模拟宿主重启并校验持久化生效
  const savedFixed = (await hostA.fake.call('/platforms/owner/primary', primaryPatch)).json()
  assert.equal(savedFixed.ok, true)
  await hostA.applied.gateway.stopAll()
  hostA.applied.modules.dispose()
  hostA.fake.dispose()

  // 同一目录重启加载
  process.env.AURABOT_DATA_DIR = dirA
  const fake2 = createFakeDsh({ brain: async () => '好的' })
  const applied2 = hostMod.apply(fake2.ctx)
  t.after(async () => {
    try { await applied2.gateway?.stopAll?.() } catch {}
    try { applied2.modules?.dispose?.() } catch {}
    try { applied2.onebot?.disconnect?.() } catch {}
    try { fake2.dispose() } catch {}
  })
  const b2Again = []
  applied2.gateway.register(() => {
    const adapter = makeFakeAdapter({ id: 'bridge', name: 'Bridge' })
    const origStart = adapter.start
    adapter.start = async (ctx) => { if (ctx.instance === 'bridge#2') b2Again.push(adapter); return origStart(ctx) }
    return adapter
  })
  applied2.gateway.register(() => makeFakeAdapter({ id: 'feishu', name: '飞书', caps: { proactive: 'none' } }))
  await applied2.gateway.sync()
  await applied2.ready

  const reloadedPeople = (await fake2.call('/platforms/people')).json()
  assert.deepEqual(reloadedPeople.ownerPrimary, primaryPatch, '重启后 ownerPrimary 配置应从磁盘恢复')
  assert.equal(reloadedPeople.resolvedProactiveRoute.chatId, 'bridge#2:private:b_acc')
  assert.equal(applied2.resolveOwnerRoute({ purpose: 'proactive' }).chatId, 'bridge#2:private:b_acc')
  assert.equal(b2Again.length, 1)
})

test('P3-4: POST /test-send 遵循 noticeFallback 并在响应中返回目标与 fallbackUsed', async (t) => {
  const { fake, adapters } = await startHost(t, {
    seedOwnerAccounts: [['bridge', 'b_acc']],
    seedConfig: {
      ownerPrimary: { mode: 'fixed', platform: 'bridge', instance: 'bridge#2', account: 'b_acc', fallback: false, noticeFallback: false },
    },
  })
  adapters.get('bridge').pushInbound({
    chat: { kind: 'private', id: 'b_acc' },
    sender: { account: 'b_acc', name: '主人' },
    parts: [{ type: 'text', text: 'hello1' }],
  })
  adapters.get('bridge#2').pushInbound({
    chat: { kind: 'private', id: 'b_acc' },
    sender: { account: 'b_acc', name: '主人' },
    parts: [{ type: 'text', text: 'hello' }],
  })

  // 关闭 noticeFallback 且 bridge#2 离线 → /test-send 明确阻塞
  adapters.get('bridge#2').disconnect()
  const rBlocked = (await fake.call('/test-send', {})).json()
  assert.equal(rBlocked.ok, false)
  assert.equal(rBlocked.blocked, true)
  assert.equal(rBlocked.reason, 'primary-offline')

  // 打开 noticeFallback（保留 fallback=false），再测 /test-send → 经在线 bridge 实例回退发出
  const switched = (await fake.call('/platforms/owner/primary', { noticeFallback: true })).json()
  assert.equal(switched.ok, true)
  const rFallback = (await fake.call('/test-send', {})).json()
  assert.equal(rFallback.ok, true, JSON.stringify(rFallback))
  assert.equal(rFallback.fallbackUsed, true)
  assert.equal(rFallback.target?.platform, 'bridge')
  assert.ok(adapters.get('bridge').sent.some((x) => JSON.stringify(x.message.parts).includes('大肥鱼到此一游')))
})

test('P3-5: 前端 client.js 注册 TAB_KEYS.access、GlobalAccess 主账号与告警渲染及 Platforms 人卡片防双写', async () => {
  const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  const marker = '    exports.apply = apply'
  assert.ok(source.includes(marker))
  const tapMarker = 'const TAB_KEYS = {'
  assert.ok(source.includes(tapMarker))

  const instrumented = source
    .replace(
      'return h(\'div\', { className: \'ab-root\' },',
      'exports.__tabKeys = TAB_KEYS;\n      return h(\'div\', { className: \'ab-root\' },',
    )
    .replace(
      marker,
      '    exports.panelTest = { GlobalAccess, Platforms, Access, ownerPrimaryLabel }\n' + marker,
    )

  const posted = []
  const fakeFetch = async (url, init) => {
    if (init?.method === 'POST') posted.push({ url, body: JSON.parse(init.body || '{}') })
    return { json: async () => ({ ok: true }) }
  }
  const script = new Script(instrumented, { filename: 'client/client.js' })
  const storage = new Map()
  const localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)) }
  let loader
  script.runInNewContext({ fetch: fakeFetch, localStorage, window: { __ModuleLoader__: { load: (v) => { loader = v } } } })

  let hook = 0
  let state = []
  let draftState = null
  const React = {
    Component: class {},
    Fragment: 'fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (initial) => {
      const i = hook++
      if (!(i in state)) state[i] = typeof initial === 'function' ? initial() : initial
      return [state[i], (val) => { state[i] = typeof val === 'function' ? val(state[i]) : val }]
    },
    useEffect() {},
    useRef: () => ({ current: null }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  }
  const vmExport = (() => {
    const exportsObj = loader.factory(() => React)
    return { ...loader, ...exportsObj }
  })()
  assert.ok(vmExport.panelTest)

  // 全局 fetch 给 post('/test-send') 用
  const origFetch = globalThis.fetch
  globalThis.fetch = fakeFetch
  try {
    // 1) 验证源码中的 TAB_KEYS.access 已纳入 ownerPrimary
    const tabKeysLine = source.split(/\r?\n/).find((l) => l.includes('const TAB_KEYS ='))
    assert.ok(tabKeysLine && tabKeysLine.includes("'ownerPrimary'"), 'TAB_KEYS.access 必须包含 ownerPrimary')

    // 2) GlobalAccess：主账号选择器、proactive=none 禁用、blocked 告警条、两个回退开关
    const cfg = {
      enabled: true,
      ownerQQ: '10001',
      ownerName: '主人',
      ownerLevel: 'full',
      ownerPrimary: { mode: 'fixed', platform: 'bridge', instance: 'bridge#2', account: 'b_acc', fallback: false, noticeFallback: true },
      notice: { enabled: true, approval: true, question: true },
      qqApi: { enabled: true },
      approvalViaQQ: true,
      longTasks: true,
      subagentBackground: false,
      profilePerms: {},
      platforms: {},
    }
    draftState = JSON.parse(JSON.stringify(cfg))
    hook = 0
    state = [
      {
        ok: true,
        ownerAccountOptions: [
          { key: 'qq:qq:10001', platform: 'qq', instance: 'qq', account: '10001', state: 'connected', enabled: true, canProactive: true, legacy: true, multiInstance: false },
          { key: 'bridge:bridge#2:b_acc', platform: 'bridge', instance: 'bridge#2', account: 'b_acc', state: 'disconnected', enabled: true, canProactive: true, multiInstance: true },
          { key: 'feishu:feishu:ou_nop', platform: 'feishu', instance: 'feishu', account: 'ou_nop', state: 'connected', enabled: true, canProactive: false, proactive: 'none', multiInstance: false },
        ],
        resolvedProactiveRoute: { chatId: '', blocked: true, reason: 'primary-offline', target: { platform: 'bridge', instance: 'bridge#2', account: 'b_acc' }, fallbackUsed: false },
        resolvedNoticeRoute: { chatId: 'private:10001', blocked: false, reason: 'fallback-used', target: { platform: 'qq', instance: 'qq', account: '10001' }, fallbackUsed: true },
        lastBlockedRoute: null,
      },
      false,
      null,
    ]
    const tree = vmExport.panelTest.GlobalAccess({
      st: { config: cfg, modules: [], onebot: { state: 'connected' } },
      draft: draftState,
      setDraft: (d) => { draftState = d },
      toast() {},
    })

    const collectNodes = (node, pred, out = []) => {
      if (!node || typeof node !== 'object') return out
      if (Array.isArray(node)) { for (const x of node) collectNodes(x, pred, out); return out }
      if (pred(node)) out.push(node)
      if (node.children) collectNodes(node.children, pred, out)
      return out
    }
    const textOf = (node) => {
      if (node == null || node === false) return ''
      if (typeof node !== 'object') return String(node)
      if (Array.isArray(node)) return node.map(textOf).join('')
      return [node.props?.label, node.props?.hint, textOf(node.children)].filter(Boolean).join(' ')
    }

    const gaText = textOf(tree)
    assert.match(gaText, /主人的主账号/)
    assert.match(gaText, /不是机器人自己的账号/)
    assert.doesNotMatch(gaText, /大肥鱼的主账号/)
    assert.match(gaText, /主人 · QQ/)
    assert.match(gaText, /主人 · 飞书/)

    const selects = collectNodes(tree, (n) => n.type === 'select')
    assert.equal(selects.length, 1)
    assert.equal(selects[0].props['aria-label'], '主人的主账号（大肥鱼主动消息接收账号）')
    const opts = collectNodes(selects[0], (n) => n.type === 'option')
    assert.ok(opts.some((o) => o.props.value === '__default__' && textOf(o).includes('有 QQ 时优先 QQ，否则跟随最近平台')))
    assert.ok(opts.some((o) => o.props.value === '__recent__' && textOf(o).includes('recent')))
    assert.ok(opts.some((o) => o.props.value === 'account:feishu:feishu:ou_nop' && o.props.disabled === true && textOf(o).includes('仅支持回复')))

    // 多实例未观测选项（observed:false, selectable:false）在下拉与快捷按钮均禁用
    hook = 0
    state = [
      {
        ok: true,
        ownerAccountOptions: [
          { key: 'bridge:bridge:b_acc', platform: 'bridge', instance: 'bridge', account: 'b_acc', state: 'connected', enabled: true, canProactive: true, multiInstance: true, hasInstance: true, observed: false, selectable: false },
          { key: 'bridge:bridge#2:b_acc', platform: 'bridge', instance: 'bridge#2', account: 'b_acc', state: 'connected', enabled: true, canProactive: true, multiInstance: true, hasInstance: true, observed: true, selectable: true },
          { key: 'qqbot:qqbot:qb_noinst', platform: 'qqbot', instance: 'qqbot', account: 'qb_noinst', state: 'stopped', enabled: false, canProactive: true, multiInstance: false, hasInstance: false, observed: false, selectable: false },
        ],
        resolvedProactiveRoute: { chatId: 'bridge#2:private:b_acc', blocked: false, reason: 'ok', target: { platform: 'bridge', instance: 'bridge#2', account: 'b_acc' }, fallbackUsed: false },
        resolvedNoticeRoute: { chatId: 'bridge#2:private:b_acc', blocked: false, reason: 'ok', target: { platform: 'bridge', instance: 'bridge#2', account: 'b_acc' }, fallbackUsed: false },
        lastBlockedRoute: null,
      },
      false,
      null,
    ]
    const treeMulti = vmExport.panelTest.GlobalAccess({
      st: { config: cfg, modules: [], onebot: { state: 'connected' } },
      draft: JSON.parse(JSON.stringify(cfg)),
      setDraft() {},
      toast() {},
    })
    const optsMulti = collectNodes(treeMulti, (n) => n.type === 'option')
    assert.ok(optsMulti.some((o) => o.props.value === 'account:bridge:bridge:b_acc' && o.props.disabled === true && textOf(o).includes('未观测到')))
    assert.ok(optsMulti.some((o) => o.props.value === 'account:qqbot:qqbot:qb_noinst' && o.props.disabled === true && textOf(o).includes('未配置平台实例')))
    assert.ok(optsMulti.some((o) => o.props.value === 'account:bridge:bridge#2:b_acc' && o.props.disabled !== true))

    // 恢复 GlobalAccess 原始 tree 状态供下方按钮/开关测试使用
    hook = 0
    state = [
      {
        ok: true,
        ownerAccountOptions: [
          { key: 'qq:qq:10001', platform: 'qq', instance: 'qq', account: '10001', state: 'connected', enabled: true, canProactive: true, legacy: true, multiInstance: false },
          { key: 'bridge:bridge#2:b_acc', platform: 'bridge', instance: 'bridge#2', account: 'b_acc', state: 'disconnected', enabled: true, canProactive: true, multiInstance: true },
          { key: 'feishu:feishu:ou_nop', platform: 'feishu', instance: 'feishu', account: 'ou_nop', state: 'connected', enabled: true, canProactive: false, proactive: 'none', multiInstance: false },
        ],
        resolvedProactiveRoute: { chatId: '', blocked: true, reason: 'primary-offline', target: { platform: 'bridge', instance: 'bridge#2', account: 'b_acc' }, fallbackUsed: false },
        resolvedNoticeRoute: { chatId: 'private:10001', blocked: false, reason: 'fallback-used', target: { platform: 'qq', instance: 'qq', account: '10001' }, fallbackUsed: true },
        lastBlockedRoute: null,
      },
      false,
      null,
    ]
    draftState = JSON.parse(JSON.stringify(cfg))
    vmExport.panelTest.GlobalAccess({
      st: { config: cfg, modules: [], onebot: { state: 'connected' } },
      draft: draftState,
      setDraft: (d) => { draftState = d },
      toast() {},
    })

    // 切换成 recent 会触发 setDraft 清空旧字段语义交由服务端前先把 mode 置 recent、platform/instance/account 清空
    selects[0].props.onChange({ target: { value: '__recent__' } })
    assert.equal(draftState.ownerPrimary.mode, 'recent')
    assert.equal(draftState.ownerPrimary.instance, '')

    // 页面文本应含主账号阻塞告警和两个回退开关文案
    const fullText = textOf(tree)
    assert.match(fullText, /普通主动消息已暂停发送/)
    assert.match(fullText, /允许普通主动聊天改发其他在线平台/)
    assert.match(fullText, /允许系统重要通知与自测提醒改发其他在线平台/)

    // 点击「测试发送给主人主账号」与切换 fallback 开关
    const testSendBtn = collectNodes(tree, (n) => n.type?.name === 'Btn' && textOf(n.children).includes('测试发送给主人主账号'))[0]
    assert.ok(testSendBtn)
    await testSendBtn.props.onClick()
    assert.ok(posted.some((x) => x.url === '/aurabot/api/test-send'))
    const fbRow = collectNodes(tree, (n) => n.type?.name === 'Row' && String(n.props?.label || '').includes('允许普通主动聊天改发其他在线平台'))[0]
    assert.ok(fbRow)
    const fbSw = collectNodes(fbRow, (n) => n.type?.name === 'Switch')[0]
    fbSw.props.onChange(true)
    assert.equal(draftState.ownerPrimary.fallback, true)

    // 3) Platforms 人卡片：主人行不显示「固定平台」select，显示「当前主账号」与「设为主账号」按钮；非主人行保留「固定平台」select
    hook = 0
    state = [
      { ok: true, owner: 'p-owner', instances: [], catalog: [], candidates: [], configs: {} }, // data
      '', // busy
      '', // addPlatform
      {
        ok: true,
        owner: 'p-owner',
        ownerPrimary: { mode: 'fixed', platform: 'qq', instance: 'qq', account: '10001' },
        ownerAccountOptions: [
          { key: 'qq:qq:10001', platform: 'qq', instance: 'qq', account: '10001', state: 'connected', enabled: true, canProactive: true, multiInstance: false, hasInstance: true, observed: true, selectable: true },
          { key: 'bridge:bridge:b_acc', platform: 'bridge', instance: 'bridge', account: 'b_acc', state: 'connected', enabled: true, canProactive: true, multiInstance: true, hasInstance: true, observed: false, selectable: false },
          { key: 'bridge:bridge#2:b_acc', platform: 'bridge', instance: 'bridge#2', account: 'b_acc', state: 'connected', enabled: true, canProactive: true, multiInstance: true, hasInstance: true, observed: true, selectable: true },
          { key: 'qqbot:qqbot:qb_noinst', platform: 'qqbot', instance: 'qqbot', account: 'qb_noinst', state: 'stopped', enabled: false, canProactive: true, multiInstance: false, hasInstance: false, observed: false, selectable: false },
        ],
        list: [
          { person: 'p-owner', name: '主人', owner: true, fixed: '', accounts: [{ platform: 'qq', account: '10001' }, { platform: 'bridge', account: 'b_acc' }, { platform: 'qqbot', account: 'qb_noinst' }] },
          { person: 'p-guest', name: '访客', owner: false, fixed: 'bridge', accounts: [{ platform: 'bridge', account: 'g_1' }] },
        ],
      }, // peopleData
      [], // chats
      '', // mergeFrom
      '', // mergeInto
      null, // mergeMsg
      '', // importPath
      null, // importPreview
      '', // importMsg
      false, // importBusy
    ]
    const platTree = vmExport.panelTest.Platforms({
      st: { config: cfg, modules: [], onebot: { state: 'connected' } },
      draft: cfg,
      setDraft() {},
      toast() {},
      reload() {},
      go() {},
    })
    const platText = textOf(platTree)
    assert.match(platText, /当前主人主账号：QQ · 10001/)
    assert.match(platText, /设为主人 bridge#2 主账号/)

    const unobsQuickBtn = collectNodes(platTree, (n) => n.type?.name === 'Btn' && textOf(n.children).includes('bridge 未观测'))[0]
    assert.ok(unobsQuickBtn)
    assert.equal(unobsQuickBtn.props.disabled, true, '多实例未观测快捷按钮必须禁用')
    const noInstQuickBtn = collectNodes(platTree, (n) => n.type?.name === 'Btn' && textOf(n.children).includes('未配置实例'))[0]
    assert.ok(noInstQuickBtn)
    assert.equal(noInstQuickBtn.props.disabled, true, '无平台实例快捷按钮必须禁用')

    // 快捷按钮应走 /platforms/owner/primary
    const quickPrimaryBtn = collectNodes(platTree, (n) => n.type?.name === 'Btn' && textOf(n.children).includes('设为主人 bridge#2 主账号'))[0]
    assert.ok(quickPrimaryBtn)
    await quickPrimaryBtn.props.onClick()
    assert.deepEqual(
      posted.find((x) => x.url === '/aurabot/api/platforms/owner/primary')?.body,
      { mode: 'fixed', platform: 'bridge', instance: 'bridge#2', account: 'b_acc' },
    )

    // 只应有 1 个固定平台下拉（对应访客 p-guest，而非主人 p-owner）
    const fixedSelects = collectNodes(platTree, (n) => n.type === 'select' && collectNodes(n, (o) => o.type === 'option' && textOf(o) === '跟随最近').length > 0)
    assert.equal(fixedSelects.length, 1, '主人行不得渲染第二个冲突的固定平台下拉')
  } finally {
    globalThis.fetch = origFetch
  }
})
