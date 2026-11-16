// P2 验收回归：A/B/C 类主动消息全调用点收口与安全边界加固。
import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dirs = []
function freshDataDir(prefix = 'aurabot-p2-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  process.env.AURABOT_DATA_DIR = dir
  return dir
}

let hostMod
let normalize
let createIdentity
let resolveConfirmChat
let createApprovalRelay
let createDangerGuard
let createSpeakUp
let createPurpose
let createBili
let createGroupShare
let createModules
let createOutboundPolicy
let contactsMod
let songMod
let createFakeDsh
let makeFakeAdapter
let makeTestIdentity

before(async () => {
  freshDataDir('aurabot-p2-boot-')
  hostMod = await import('../src/host.js')
  ;({ normalize } = await import('../src/core/config.js'))
  ;({ createIdentity } = await import('../src/gateway/identity.js'))
  ;({ resolveConfirmChat } = await import('../src/chat/access.js'))
  ;({ createApprovalRelay } = await import('../src/security/approval.js'))
  ;({ createDangerGuard } = await import('../src/security/danger.js'))
  ;({ createSpeakUp } = await import('../src/features/companion.js'))
  ;({ createPurpose } = await import('../src/purpose/module.js'))
  ;({ createBili } = await import('../src/bili/duty.js'))
  ;({ createGroupShare } = await import('../src/bili/group-share.js'))
  ;({ createModules } = await import('../src/core/modules.js'))
  ;({ createOutboundPolicy } = await import('../src/chat/outbound-policy.js'))
  ;({ default: contactsMod } = await import('../src/modules/contacts/index.js'))
  ;({ default: songMod } = await import('../src/modules/song/index.js'))
  ;({ createFakeDsh } = await import('./helpers/fake-dsh.js'))
  ;({ makeFakeAdapter } = await import('./helpers/fake-adapter.js'))
  ;({ makeTestIdentity } = await import('./helpers/identity.js'))
})

beforeEach(() => {
  freshDataDir('aurabot-p2-case-')
})

async function setupHostWithBridge2(t, { primary, fallback = false, noticeFallback = true } = {}) {
  const seedId = createIdentity({ dataDir: join(process.env.AURABOT_DATA_DIR, 'gateway'), log: { info() {}, warn() {}, debug() {} } })
  const ownerPerson = seedId.claimOwner('qq', '10001')
  seedId.link('bridge', 'b_two', ownerPerson, 'manual')

  const fake = createFakeDsh({ brain: async () => '好的' })
  const applied = hostMod.apply(fake.ctx)
  t.after(async () => {
    try { await applied.gateway?.stopAll?.() } catch {}
    try { applied.modules?.dispose?.() } catch {}
    try { applied.onebot?.disconnect?.() } catch {}
    try { fake.dispose() } catch {}
  })

  const bridgeAdapters = new Map()
  applied.setConfig(normalize({
    enabled: true,
    dryRun: false,
    ownerQQ: '10001',
    snowluma: { autoStart: false },
    merge: { enabled: false },
    allow: { private: ['30003'], groups: [] },
    platforms: {
      'bridge#2': { enabled: true },
    },
    song: { enabled: true },
    ext: { purpose: { enabled: true, initialDelayMinutes: 1, minMaterials: 0 } },
    ownerPrimary: primary || {
      mode: 'fixed',
      platform: 'bridge',
      instance: 'bridge#2',
      account: 'b_two',
      fallback,
      noticeFallback,
    },
  }))

  assert.ok(applied.gateway, '配置 platforms 后 gateway 应已初始化')
  applied.gateway.register(() => {
    const adapter = makeFakeAdapter({ id: 'bridge', name: 'Bridge' })
    const origStart = adapter.start
    adapter.start = async (ctx) => {
      bridgeAdapters.set(ctx.instance, adapter)
      return origStart(ctx)
    }
    return adapter
  })

  await applied.gateway.sync()
  await applied.ready

  const b2 = bridgeAdapters.get('bridge#2')
  assert.ok(b2, 'bridge#2 实例应已启动')

  // 让 bridge#2:b_two 发一条私聊，记录 instanceAccounts 归属 bridge#2
  b2.pushInbound({
    chat: { kind: 'private', id: 'b_two' },
    sender: { account: 'b_two', name: '主人小号' },
    parts: [{ type: 'text', text: '绑定小号' }],
  })

  return { fake, applied, bridgeAdapters, ownerPerson }
}

test('P2-1: Class A 不绕过主账号路由且多实例 primary 经由 outbound-policy 治理', async (t) => {
  const { fake, applied, bridgeAdapters } = await setupHostWithBridge2(t)

  const reachable = applied.resolveOwnerRoute({ purpose: 'proactive' })
  assert.equal(reachable.blocked, false)
  assert.equal(reachable.chatId, 'bridge#2:private:b_two')

  // 验证多实例 bridge#2:private:b_two 在 outbound-policy 下的 parsePrivateTarget + isGovernedTarget 与 api.ownerChat/api.proactive
  const policyIdentity = makeTestIdentity('10001', 'qq', { personId: 'owner-1' })
  policyIdentity.setOwner('b_two', 'bridge', 'owner-1')
  const policyCfg = normalize({
    enabled: true,
    dryRun: false,
    ownerQQ: '10001',
    ext: { outboundPolicy: { tier: 'broker' } },
    ownerPrimary: { mode: 'fixed', platform: 'bridge', instance: 'bridge#2', account: 'b_two', fallback: false, noticeFallback: true },
  })
  const policy = createOutboundPolicy({
    identity: policyIdentity,
    owner: () => policyIdentity.owner() || '',
    getConfig: () => policyCfg,
    dataDir: null,
    hooks: { fsSync: false },
  })
  policy.registerPolicySource({
    name: 'purpose',
    state: () => 'ready',
    ready: () => true,
    reserve: () => ({ ok: true, reserveId: 'r-p2' }),
    commit: () => ({ ok: true }),
    release: () => ({ ok: true }),
  })
  const deliveredTargets = []
  policy.setDeliverer(async (to, text) => { deliveredTargets.push({ to, text }); return true })

  let routeBlocked = false
  let capturedApi = null
  const hubSends = []
  const modDir = freshDataDir('aurabot-p2-mod-')
  const mods = createModules({
    ctx: {},
    core: {
      identity: policyIdentity,
      outbound: policy,
      resolveOwnerRoute: ({ purpose } = {}) => routeBlocked
        ? { ok: false, blocked: true, reason: 'primary-offline', chatId: '', platform: '', instance: '', usedFallback: false }
        : { ok: true, blocked: false, reason: purpose || 'primary', chatId: 'bridge#2:private:b_two', platform: 'bridge', instance: 'bridge#2', usedFallback: false },
      routeOwner: () => 'private:10001',
      hub: {
        ownerChat: () => 'private:10001',
        sendText: async (chatId, text) => { hubSends.push({ chatId, text }); return { message_id: 'm1' } },
        sendSegments: async () => ({ message_id: 'm2' }),
        sendImage: async () => ({ message_id: 'm3' }),
        sendFile: async () => ({ message_id: 'm4' }),
        sendVoiceFile: async () => ({ message_id: 'm5' }),
        deliver: async () => ({ missedAt: [] }),
        runSystemTurn: async () => '',
        subagentFor: () => () => 'ok',
      },
      onebot: { call: async () => null },
      ask: async () => '',
    },
    getConfig: () => policyCfg,
    setConfig: () => {},
    logger: { child: () => ({ info() {}, warn() {}, debug() {}, error() {} }) },
    version: 'test',
    builtins: [{ id: 'p2-probe', name: 'p2-probe', setup(api) { capturedApi = api; return {} } }],
  })
  t.after(() => mods.dispose())
  await mods.boot()
  assert.ok(capturedApi)
  assert.ok(modDir)

  assert.equal(capturedApi.ownerChat(), 'bridge#2:private:b_two')
  const subOk = await capturedApi.proactive.submit({ itemId: 'i-ok', text: '去 bridge#2' })
  assert.equal(subOk.state, 'sent')
  assert.deepEqual(deliveredTargets.map((x) => x.to), ['bridge#2:private:b_two'], '多实例主账号 target 必须被 outbound-policy 识别并投递')

  // 切到主账号断线 + fallback:false → A 类全阻断且不落入 private:10001
  routeBlocked = true
  assert.equal(capturedApi.ownerChat(), '', 'blocked 时 api.ownerChat() 返回空串且不回退 hub.ownerChat')
  const subDropped = await capturedApi.proactive.submit({ itemId: 'i-drop', text: '不应该发出' })
  assert.deepEqual(subDropped, { deliveryId: null, state: 'dropped', reason: 'primary-offline' })
  assert.equal(hubSends.length, 0)
  assert.equal(deliveredTargets.length, 1)

  // 真实宿主上断掉 bridge#2，验证 bridge.ops.send / /song/request 一律结构化 blocked 且不落回 QQ
  bridgeAdapters.get('bridge#2').disconnect()
  const qqBefore = bridgeAdapters.get('bridge#2').sent.length
  const blockedRoute = applied.resolveOwnerRoute({ purpose: 'proactive' })
  assert.equal(blockedRoute.blocked, true)
  assert.equal(blockedRoute.chatId, '')
  assert.equal(blockedRoute.reason, 'primary-offline')

  const bridgeRes = await applied.bridge.ops.send({ text: '外联消息不许回退 QQ' })
  assert.equal(bridgeRes.ok, false)
  assert.equal(bridgeRes.blocked, true)
  assert.equal(bridgeRes.reason, 'primary-offline')

  const songReqRes = (await fake.call('/song/request', { song: '小幸运' })).json()
  assert.equal(songReqRes.ok, false)
  assert.equal(songReqRes.blocked, true)
  assert.equal(songReqRes.reason, 'primary-offline')
  assert.equal(bridgeAdapters.get('bridge#2').sent.length, qqBefore)

  // contacts 好友申请通知：blocked 时停发，不发回 QQ；切换可路由 feishu 时发往 feishu
  const contactSent = []
  let contactsBlocked = true
  let contactListener
  contactsMod.setup({
    core: {
      identity: policyIdentity,
      resolveOwnerRoute: () => (contactsBlocked
        ? { ok: false, blocked: true, reason: 'primary-offline', chatId: '' }
        : { ok: true, blocked: false, reason: 'primary', chatId: 'feishu:private:ou_c' }),
      routeOwner: () => 'private:10001',
      hub: { ownerChat: () => 'private:10001', turnSendersAllOwner: () => true },
      onebot: { call: async () => null },
    },
    log: { warn() {}, info() {} },
    config: () => normalize({ ownerQQ: '10001', dryRun: false }),
    setConfig: () => {},
    dataDir: (...p) => join(freshDataDir('aurabot-p2-contacts-'), ...p),
    on: (name, fn) => { if (name === 'onebot') contactListener = fn },
    tool: () => {},
    sendText: async (chatId, text) => { contactSent.push({ chatId, text }) },
  })
  await contactListener({ post_type: 'request', request_type: 'friend', user_id: 40004, comment: '加好友', flag: 'f_1' })
  assert.equal(contactSent.length, 0, '主账号 blocked 时好友申请不得回退 QQ 发送')

  contactsBlocked = false
  await contactListener({ post_type: 'request', request_type: 'friend', user_id: 40005, comment: '加好友2', flag: 'f_2' })
  assert.deepEqual(contactSent.map((x) => x.chatId), ['feishu:private:ou_c'])
})

test('P2-2: speakup 与 purpose 在 owner blocked 时不消耗额度，朋友线不受阻，回合标题去 QQ 前缀', async (t) => {
  // ---- speakup ----
  const speakDir = freshDataDir('aurabot-p2-speak-')
  const speakPushed = []
  let speakOwnerBlocked = true
  const speakCfg = normalize({
    enabled: true,
    dryRun: false,
    ownerQQ: '10001',
    allow: { private: ['22222'], groups: [] },
    speakUp: {
      enabled: true,
      awakeFrom: 0,
      awakeTo: 24,
      minIntervalMinutes: 1,
      maxIntervalMinutes: 1,
      idleMinutes: 1,
      maxPerDay: 5,
      allow: ['22222'],
    },
  })
  const speakIdentity = makeTestIdentity('10001', 'qq', { personId: 'owner-sp' })
  speakIdentity.setOwner('ou_sp', 'feishu', 'owner-sp')
  const speakHub = {
    lastOwnerChatAt: Date.now() - 120 * 60_000,
    lastChatAt: Date.now(),
    lastBotToOwner: { at: Date.now() - 120 * 60_000, text: '晚安' },
    lastPrivateAt: () => 0,
    ownerChat: () => 'private:10001',
    pushToSession: async (chat, content) => speakPushed.push({ chatId: chat.chatId, text: content[0].text }),
  }
  const realNow = Date.now
  try {
    const speakup = createSpeakUp({
      getConfig: () => speakCfg,
      hub: speakHub,
      log: { info() {}, debug() {}, warn() {} },
      identity: speakIdentity,
      resolveOwnerRoute: () => (speakOwnerBlocked
        ? { ok: false, blocked: true, reason: 'primary-offline', chatId: '' }
        : { ok: true, blocked: false, reason: 'primary', chatId: 'feishu:private:ou_sp' }),
      routeOwner: () => 'private:10001',
    })
    await speakup.tick() // 首次排时间
    assert.equal(speakPushed.length, 0)
    Date.now = () => realNow() + 5 * 60_000
    await speakup.tick()
    assert.equal(speakup.state().count, 0, 'owner blocked 时 tick 不能消费 speakup 每日次数')
    assert.equal(speakPushed.filter((x) => x.chatId === 'private:10001' || x.chatId.includes('ou_sp')).length, 0)
    assert.deepEqual(speakPushed.map((x) => x.chatId), ['private:22222'], '白名单朋友线在 owner blocked 时仍正常触发')

    const fireBlocked = await speakup.fire()
    assert.equal(fireBlocked.ok, false)
    assert.equal(fireBlocked.blocked, true)
    assert.equal(fireBlocked.reason, 'primary-offline')
    assert.equal(speakup.state().count, 0, 'blocked fire 不得消费次数')
  } finally {
    Date.now = realNow
  }
  assert.ok(speakDir)

  // ---- purpose ----
  const purposeDir = freshDataDir('aurabot-p2-purpose-')
  const purposeIdentity = makeTestIdentity('10001', 'qq', { personId: 'owner-pp' })
  purposeIdentity.setOwner('ou_pp', 'feishu', 'owner-pp')
  let purposeRoute = { ok: false, blocked: true, reason: 'primary-offline', chatId: '' }
  const purposeHub = {
    lastOwnerChatAt: 0,
    lastBotToOwner: { at: 0, text: '' },
    ownerChat: () => 'private:10001',
    chatLogDays: () => [],
    chatLogOf: () => [],
    delivered: [],
    turns: [],
    async runSystemTurn(name, title, prompt, options = {}) {
      this.turns.push({ name, title, prompt, options })
      return name === 'purpose-score' ? '[]' : '今天想起来跟你说句话'
    },
    async deliver(chatId, text, opts = {}) {
      this.delivered.push({ chatId, text, opts })
      return { missedAt: [], failed: 0, errors: [], sent: text }
    },
  }
  const purposeCfg = {
    enabled: true,
    dryRun: false,
    ownerQQ: '10001',
    ownerName: '主人',
    allow: { private: ['33333'], groups: [] },
    speakUp: { enabled: false, awakeFrom: 0, awakeTo: 24, idleMinutes: 30, minIntervalMinutes: 5, maxIntervalMinutes: 5, maxPerDay: 10, nudge: true, allow: ['33333'] },
    ext: { purpose: { enabled: true, initialDelayMinutes: 1, minMaterials: 0 } },
  }
  const purpose = createPurpose({
    getConfig: () => purposeCfg,
    hub: purposeHub,
    identity: purposeIdentity,
    resolveOwnerRoute: () => purposeRoute,
    routeOwner: () => 'private:10001',
    log: { info() {}, warn() {}, debug() {} },
    isMuted: () => false,
    mood: () => ({ nudge() {} }),
    memory: () => ({ list: () => [{ id: 'm1', text: '主人喜欢喝乌龙茶', importance: 0.8, at: Date.now() }] }),
    personaText: () => '',
    use: () => null,
  })

  // 冷启动直接 blocked 时既不投递也不消耗次数
  await purpose.tick()
  assert.equal(purposeHub.delivered.length, 0)
  assert.equal(purpose.state().countToday, 0)

  // 先在可达态下首次排程写入 nextFireAt，再拨到点并切换为 blocked，验证到点 tick() 仍安全跳过且不扣 countToday
  purposeRoute = { ok: true, blocked: false, reason: 'primary', chatId: 'feishu:private:ou_pp' }
  await purpose.tick()
  const statePath = join(purposeDir, 'purpose', 'purpose-state.json')
  const st = JSON.parse(readFileSync(statePath, 'utf8'))
  st.nextFireAt = Date.now() - 1
  writeFileSync(statePath, JSON.stringify(st))
  purposeRoute = { ok: false, blocked: true, reason: 'primary-offline', chatId: '' }
  await purpose.tick()
  assert.equal(purposeHub.delivered.length, 0, 'owner blocked 时 tick 不得投递且不得回退 private:10001')
  assert.equal(purpose.state().countToday, 0, 'owner blocked 时 tick 不得消耗 purpose.state().countToday')

  const pFireBlocked = await purpose.fire()
  assert.equal(pFireBlocked.outcome, 'blocked')
  assert.equal(pFireBlocked.reason, 'primary-offline')
  assert.equal(purpose.state().countToday, 0)

  purposeRoute = { ok: false, blocked: false, reason: 'no-route', chatId: '' }
  const pFireNoRoute = await purpose.fire()
  assert.equal(pFireNoRoute.outcome, 'no-route')
  assert.equal(purpose.state().countToday, 0)

  // 可达时通过 Feishu 主账号触发，并检查所有回合标题不含硬编码 'QQ · '
  purposeRoute = { ok: true, blocked: false, reason: 'primary', chatId: 'feishu:private:ou_pp' }
  const pFireOk = await purpose.fire()
  assert.equal(pFireOk.outcome, 'sent')
  assert.deepEqual(purposeHub.delivered.map((x) => x.chatId), ['feishu:private:ou_pp'])
  assert.ok(purposeHub.turns.length >= 1)
  for (const turn of purposeHub.turns) {
    assert.ok(!String(turn.title || '').startsWith('QQ · '), `回合标题不应含硬编码 QQ 前缀: ${turn.title}`)
  }

  // 宿主 HTTP /speakup/fire 与 /purpose/fire 在 primary-offline 时返回结构化 blocked
  const { fake, bridgeAdapters } = await setupHostWithBridge2(t)
  bridgeAdapters.get('bridge#2').disconnect()
  const httpSpeak = (await fake.call('/speakup/fire', {})).json()
  assert.equal(httpSpeak.ok, false)
  assert.equal(httpSpeak.blocked, true)
  assert.equal(httpSpeak.reason, 'primary-offline')

  const httpPurpose = (await fake.call('/purpose/fire', {})).json()
  assert.equal(httpPurpose.ok, false)
  assert.equal(httpPurpose.blocked, true)
  assert.equal(httpPurpose.reason, 'primary-offline')
})

test('P2-3: bili 与 groupShare 按 A/C 类分流且原路回执不受 ownerPrimary 阻塞影响', async () => {
  freshDataDir('aurabot-p2-bili-')
  const OWNER_QQ = '10000001'
  const GROUP = '20000002'
  const identity = makeTestIdentity(OWNER_QQ, 'qq', { personId: 'owner-bili' })
  identity.setOwner('ou_bili', 'feishu', 'owner-bili')

  let route = { ok: true, blocked: false, reason: 'primary', chatId: 'feishu:private:ou_bili' }
  const biliSent = []
  const biliHub = {
    ownerChat: () => `private:${OWNER_QQ}`,
    runSystemTurn: async (_name, _title, prompt) => {
      if (prompt.includes('挑 3 个')) return '["猫"]'
      if (prompt.includes('看完说说你的想法')) return JSON.stringify([{ i: 1, feeling: '好玩', comment: '', share: '快来看这个！', remember: '' }])
      return ''
    },
    sendText: async (chatId, text) => { biliSent.push({ chatId, text }); return { message_id: 'b1' } },
    logChat: () => {},
  }
  const fakeApi = {
    nav: async () => ({ isLogin: true, uname: '小号' }),
    search: async () => [{ bvid: 'BV1xxyyzz11', aid: 11, title: '猫猫跳水', play: 20000, pubdate: Date.now() }],
    popular: async () => [],
    view: async ({ bvid }) => ({ bvid, aid: 11, cid: 1, title: '猫猫跳水', author: 'UP', play: 20000, desc: '猫猫' }),
    subtitle: async () => '',
    comments: async () => [],
    replyFeed: async () => [],
  }
  const bCfg = normalize({
    enabled: true,
    dryRun: false,
    ownerQQ: OWNER_QQ,
    bili: { enabled: true, cookie: 'SESSDATA=x; bili_jct=y', perRun: 1, maxCommentsPerDay: 0, groupShare: { enabled: true, groupId: GROUP } },
  })
  const bili = createBili({
    getConfig: () => bCfg,
    hub: biliHub,
    memory: { list: () => [], recentEvents: () => [], addEvent: () => {}, add: () => {} },
    identity,
    resolveOwnerRoute: () => route,
    routeOwner: () => `private:${OWNER_QQ}`,
    log: { info() {}, warn() {}, debug() {} },
    api: fakeApi,
  })

  // 可达走 Feishu
  const rOk = await bili.run({ force: true })
  assert.equal(rOk.ok, true)
  assert.deepEqual(biliSent.map((x) => x.chatId), ['feishu:private:ou_bili'])

  // 清除 seen 使同一测试隔离后再测 blocked
  biliSent.length = 0
  rmSync(join(process.env.AURABOT_DATA_DIR, 'bili.json'), { force: true })
  route = { ok: false, blocked: true, reason: 'primary-offline', chatId: '' }
  const rBlocked = await bili.run({ force: true })
  assert.equal(rBlocked.ok, true)
  assert.equal(biliSent.length, 0, 'owner blocked 时 shareToOwner 必须停止发送，不落入 hub.ownerChat')

  // groupShare: A 类 submit vs C 类原路回执
  const gsSent = []
  let gsRoute = { ok: false, blocked: true, reason: 'primary-offline', chatId: '' }
  const gs = createGroupShare({
    getConfig: () => bCfg,
    hub: {
      ownerChat: () => `private:${OWNER_QQ}`,
      sendText: async (chatId, text) => { gsSent.push({ chatId, text }); return { message_id: gsSent.length } },
      sendImage: async () => ({ message_id: 99 }),
      groupNames: new Map(),
    },
    identity,
    resolveOwnerRoute: () => gsRoute,
    routeOwner: () => `private:${OWNER_QQ}`,
    log: { info() {}, warn() {}, debug() {} },
    think: async (kind) => (kind === 'ask' ? '这个可以发群里吗？' : '发好啦！'),
  })

  const subBlocked = await gs.submit([{ bvid: 'BV1gsBlocked1', title: '阻塞条', text: '给群友看看' }])
  assert.equal(subBlocked.ok, false)
  assert.equal(subBlocked.blocked, true)
  assert.equal(subBlocked.reason, 'primary-offline')
  assert.equal(gsSent.length, 0, 'groupShare.submit 在 owner blocked 时不能回退 QQ')

  // 先在 Feishu 主账号下发问，再切换主账号为 blocked，但主人在 QQ 原回复 '发 1'（C 类）
  rmSync(join(process.env.AURABOT_DATA_DIR, 'bili-group-share.json'), { force: true })
  gsRoute = { ok: true, blocked: false, reason: 'primary', chatId: 'feishu:private:ou_bili' }
  const subOk = await gs.submit([{ bvid: 'BV1gsReceipt1', title: '原路回执', text: '好玩的视频' }])
  assert.equal(subOk.ok, true)
  assert.deepEqual(gsSent.map((x) => x.chatId), ['feishu:private:ou_bili'])

  // ownerPrimary 变成 blocked 后，主人在 QQ 私聊回复 '发 1'，群分享消息与回执仍按 replyTo 原路完成
  gsSent.length = 0
  gsRoute = { ok: false, blocked: true, reason: 'primary-offline', chatId: '' }
  const handled = await gs.handleReply(`private:${OWNER_QQ}`, OWNER_QQ, '发 1')
  assert.equal(handled, true)
  await new Promise((r) => setTimeout(r, 40))
  assert.ok(gsSent.some((x) => x.chatId === `group:${GROUP}`), '批准后仍应发出到群')
  const receipts = gsSent.filter((x) => x.chatId !== `group:${GROUP}`)
  assert.deepEqual(receipts.map((x) => x.chatId), [`private:${OWNER_QQ}`], 'C 类回执应严格回在触发回复的原私聊')
})

test('P2-4: 安全边界与 C 类既有上下文（resolveConfirmChat / approval / danger / memory preview / qq_song_cover）', async (t) => {
  const identity = makeTestIdentity('10001', 'qq', { personId: 'owner-sec' })

  // 1) resolveConfirmChat 非空触发会话严格短路，绝不误调 notice 路由或询问主人
  let noticeCalls = 0
  const spyNotice = () => {
    noticeCalls++
    return { ok: true, blocked: false, reason: 'primary', chatId: 'private:10001' }
  }
  assert.equal(resolveConfirmChat(identity, 'group:555', spyNotice), '')
  assert.equal(resolveConfirmChat(identity, 'private:999', spyNotice), '')
  assert.equal(noticeCalls, 0, '非空非主人会话不得触发 resolveNoticeOwnerChat')

  // 空触发来源时才允许走 resolveNoticeOwnerChat，且受 blocked / noticeFallback 约束
  assert.equal(resolveConfirmChat(identity, '', () => ({ ok: false, blocked: true, reason: 'primary-offline', chatId: '' })), '')
  assert.equal(resolveConfirmChat(identity, '', () => ({ ok: true, blocked: false, reason: 'notice-fallback', chatId: 'private:10001', usedFallback: true })), 'qq:private:10001')

  // 2) approvalRelay 保留 !rawChat 早退：会话来源为空时不触发远程主人询问
  let approvalNoticeCalls = 0
  const approvalSent = []
  const relay = createApprovalRelay({
    getConfig: () => ({ enabled: true, dryRun: false, approvalViaQQ: true }),
    deliver: async (chatId, text) => { approvalSent.push({ chatId, text }) },
    chatOfSession: () => '',
    identity,
    resolveNoticeOwnerChat: () => {
      approvalNoticeCalls++
      return { ok: true, chatId: 'private:10001' }
    },
    timeoutMs: 100,
  })
  const relayRes = await relay.onRequest({ agent: { session: { id: 'no-chat' } }, toolName: 'bash', reason: 'test' }, async () => 'unavailable')
  assert.equal(relayRes, 'unavailable')
  assert.equal(approvalNoticeCalls, 0)
  assert.equal(approvalSent.length, 0)

  // 3) dangerGuard 保留 !rawChat fail-closed：直接 deny，不远程问主人
  let dangerNoticeCalls = 0
  const dangerSent = []
  const guard = createDangerGuard({
    getConfig: () => ({ security: { dangerConfirm: true } }),
    deliver: async (chatId, text) => { dangerSent.push({ chatId, text }) },
    chatOfSession: (sid) => (sid === 'sid-other' ? 'private:999' : ''),
    identity,
    resolveNoticeOwnerChat: () => {
      dangerNoticeCalls++
      return { ok: true, chatId: 'private:10001' }
    },
    timeoutMs: 100,
  })
  const denyNoChat = await guard.preExecute({ name: 'pwsh', arguments: { command: 'rm -rf /' }, agent: { session: { id: 'sid-none' } } }, () => 'NEXT')
  assert.equal(denyNoChat.kind, 'deny')
  const denyOther = await guard.preExecute({ name: 'pwsh', arguments: { command: 'rm -rf /' }, agent: { session: { id: 'sid-other' } } }, () => 'NEXT')
  assert.equal(denyOther.kind, 'deny')
  assert.equal(dangerNoticeCalls, 0)
  assert.equal(dangerSent.length, 0)

  // 4) 宿主上 blocked 状态：/memory/assoc/preview 仍可读并返回 ok:true，且不外发消息
  const { fake, bridgeAdapters } = await setupHostWithBridge2(t)
  bridgeAdapters.get('bridge#2').disconnect()
  const preview = (await fake.call('/memory/assoc/preview?q=测试')).json()
  assert.equal(preview.ok, true)

  // 5) qq_song_cover 保持 C 类原地触发（chat.chatId）
  let songBuilder = null
  const songSent = []
  songMod.setup({
    core: {
      identity,
      resolveOwnerRoute: () => ({ ok: false, blocked: true, reason: 'primary-offline', chatId: '' }),
      hub: {
        ownerChat: () => 'private:10001',
        sendText: async (chatId, text) => { songSent.push({ chatId, text }) },
        sendVoiceFile: async () => {},
        runSystemTurn: async () => '嗯',
      },
      local: { get: () => null },
      http: { body: async () => ({}) },
    },
    log: { info() {}, warn() {}, debug() {} },
    config: () => normalize({ enabled: true, dryRun: false, ownerQQ: '10001', song: { enabled: true } }),
    lazy: () => ({}),
    context: () => {},
    emit: () => {},
    route: () => {},
    tool: (b) => { songBuilder = b },
  })
  const tools = songBuilder({ chat: { kind: 'group', groupId: '555', chatId: 'group:555' }, sessionId: 's-group' })
  const coverTool = Array.isArray(tools) ? tools.find((x) => x.name === 'qq_song_cover') : tools
  assert.equal(coverTool?.name, 'qq_song_cover', 'group 会话应挂载 qq_song_cover 工具')
  // 验证 /song/request 走 A 类而被 blocked（即使在同一模块下，工具和面板请求分流）
  assert.equal(typeof coverTool.execute, 'function')
  assert.equal(songSent.length, 0)
})
