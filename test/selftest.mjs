/**
 * dsh-proxy-auto 自测（精简版）。
 *
 * 只测两件真正要紧的事，且**不碰外部网络**（秒级完成）：
 *   1) 探测层的安全底线：**绝不返回一个没人监听的代理**（"代理一关就断网"的根治点）；
 *   2) 与官方 seam 的联动：装上去 → 官方判定变 proxied；卸下来 → 回到 direct。
 *
 * 运行：node test/selftest.mjs
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const detect = await import(new URL('../lib/detect.js', import.meta.url).href)
const seamMod = await import(new URL('../lib/proxy-seam.js', import.meta.url).href)

// 测试必须与运行环境隔离：宿主可能已经把代理写进环境变量（那是它的正常运行状态），
// 但本测试要验的是"给定条件下探测层怎么判"，所以先摘掉代理类变量，结束时还原。
const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']
const savedProxyEnv = Object.fromEntries(PROXY_ENV_KEYS.map((key) => [key, process.env[key]]))
for (const key of PROXY_ENV_KEYS) delete process.env[key]
const restoreProxyEnv = () => {
  for (const [key, value] of Object.entries(savedProxyEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

let passed = 0
let failed = 0
let skipped = 0

async function test(label, fn) {
  try {
    await fn()
    passed++
    console.log(`  ✔ ${label}`)
  } catch (error) {
    failed++
    console.log(`  ✘ ${label}\n      ${error.message}`)
  }
}

console.log('detect.js · 归一化')
await test('裸 host:port / http:// / 多代理写法都能归一', () => {
  assert.equal(detect.normalizeProxyUrl('127.0.0.1:7890'), 'http://127.0.0.1:7890')
  assert.equal(detect.normalizeProxyUrl('http://127.0.0.1:7890/'), 'http://127.0.0.1:7890')
  assert.equal(detect.normalizeProxyUrl('http=127.0.0.1:7890;https=127.0.0.1:7891'), 'http://127.0.0.1:7891')
})
await test('socks / 空值 / 乱码一律诚实降级为 undefined（宁可不代理）', () => {
  assert.equal(detect.normalizeProxyUrl('socks5://127.0.0.1:1080'), undefined)
  assert.equal(detect.normalizeProxyUrl(''), undefined)
  assert.equal(detect.normalizeProxyUrl(undefined), undefined)
  assert.equal(detect.normalizeProxyUrl('随便一段不是地址的文字'), undefined)
})

console.log('\ndetect.js · ProxyState（安全底线）')
await test('端口在监听 → 返回该代理', async () => {
  const server = createServer(() => {})
  await new Promise((r) => server.listen(19991, '127.0.0.1', r))
  process.env.DSH_PROXY_AUTO_REGISTRY = 'http://127.0.0.1:19991'
  const state = new detect.ProxyState({ ttlMs: 0, probeTimeoutMs: 300 })
  const proxy = await state.get()
  delete process.env.DSH_PROXY_AUTO_REGISTRY
  server.close()
  assert.equal(proxy, 'http://127.0.0.1:19991')
})
await test('地址存在但没人监听 → 判定为直连（根治"代理一关就断网"）', async () => {
  // 关键：必须把注册表也桩掉。否则若这台机器上真有个活代理（测试机常见），
  // 探测会（正确地）选中它，用例就会因为"环境太真实"而假失败。
  const state = new detect.ProxyState({
    ttlMs: 0,
    probeTimeoutMs: 300,
    platform: 'win32', // 注册表分支只在 win32 执行；注入它让 ubuntu CI 也能跑同一条断言
    execFileImpl: (file, args, options, cb) => {
      if (args.includes('ProxyEnable')) return cb(null, 'ProxyEnable    REG_DWORD    0x1\n')
      return cb(null, 'ProxyServer    REG_SZ    127.0.0.1:19992\n')
    },
  })
  const proxy = await state.get()
  assert.equal(proxy, undefined)
})
await test('代理从"关"到"开" → 重新探测能发现', async () => {
  const server = createServer(() => {})
  await new Promise((r) => server.listen(19993, '127.0.0.1', r))
  let enabled = false
  const state = new detect.ProxyState({
    ttlMs: 0,
    probeTimeoutMs: 300,
    platform: 'win32',
    execFileImpl: (file, args, options, cb) => {
      if (args.includes('ProxyEnable')) return cb(null, `ProxyEnable    REG_DWORD    0x${enabled ? 1 : 0}\n`)
      return cb(null, 'ProxyServer    REG_SZ    127.0.0.1:19993\n')
    },
  })
  const before = await state.get()
  enabled = true
  const after = await state.get()
  server.close()
  assert.equal(before, undefined)
  assert.equal(after, 'http://127.0.0.1:19993')
})
await test('注册表读不到（沙箱/非 Windows）→ 直连，且不抛异常', async () => {
  const saved = process.env.DSH_PROXY_AUTO_REGISTRY
  delete process.env.DSH_PROXY_AUTO_REGISTRY
  const state = new detect.ProxyState({
    ttlMs: 0,
    platform: 'win32',
    execFileImpl: () => {
      throw Object.assign(new Error('spawn EPERM'), { code: 'EPERM' })
    },
  })
  const proxy = await state.get()
  if (saved !== undefined) process.env.DSH_PROXY_AUTO_REGISTRY = saved
  assert.equal(proxy, undefined)
})

console.log('\nproxy-seam.js · 与官方代理 seam 的联动')
const seam = await seamMod.loadProxySeam()
if (!seam) {
  console.log('  ○ 装载官方 @deepseek-ai/dsh-http-proxy\n      SKIP：本机未安装 DSH（CI 环境属正常）')
  console.log('  ○ 官方 seam 装/卸联动\n      SKIP：同上')
} else {
  await test('装载官方 @deepseek-ai/dsh-http-proxy', () => {
    assert.notEqual(seam, null)
  })
  const installer = seamMod.createSeamInstaller({ seam, log: { info: () => {}, warn: () => {} } })
  await test('装上代理策略 → 官方判定变为 proxied', async () => {
    await installer.sync('http://127.0.0.1:7890')
    assert.equal(seamMod.describeRoute(seam, 'https://example.com/'), 'proxied via http://127.0.0.1:7890')
  })
  await test('卸掉代理策略 → 官方判定回到 direct（不会留下悬空地址）', async () => {
    await installer.sync(undefined)
    assert.equal(seamMod.describeRoute(seam, 'https://example.com/'), 'direct')
  })
  await test('dispose 之后仍是 direct', async () => {
    await installer.sync('http://127.0.0.1:7890')
    await installer.dispose()
    assert.equal(seamMod.describeRoute(seam, 'https://example.com/'), 'direct')
  })
}
await test('候选说明符以裸包名开头（否则与 web-fetch-http 不是同一模块实例）', async () => {
  const source = readFileSync(new URL('../lib/proxy-seam.js', import.meta.url), 'utf8')
  const listStart = source.indexOf('function candidateSpecifiers')
  const listBody = source.slice(listStart, source.indexOf('\n}', listStart))
  assert.ok(listBody.includes("'@deepseek-ai/dsh-http-proxy'"), '裸包名必须在候选里')
  assert.ok(
    listBody.indexOf("'@deepseek-ai/dsh-http-proxy'") < listBody.indexOf('join('),
    '裸包名必须排在路径推导之前'
  )
})

console.log('\nenv-persist.js · 官方 .env 的自动维护（"不留死地址"的关键）')
const envMod = await import(new URL('../lib/env-persist.js', import.meta.url).href)
const dir = mkdtempSync(join(tmpdir(), 'dsh-proxy-auto-test-'))
const envFile = join(dir, '.env')
writeFileSync(envFile, 'MDCG_ROOT=x\nHTTP_PROXY=http://stale:9999\n', 'utf8')

await test('探测到代理 → 写入地址，并清掉用户手写的旧值（避免重复定义）', () => {
  envMod.reconcileEnvFile({ proxyUrl: 'http://127.0.0.1:7890', envFile })
  const text = readFileSync(envFile, 'utf8')
  // 必须**每个**键都写上：曾经因为"清理旧值"的正则把刚写的键又删掉，只剩 HTTP_PROXY、
  // 而 HTTPS_PROXY 变成空 —— 表现为 HTTPS 全部不走代理（web_fetch 必然失败）。
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
    assert.ok(text.includes(`${key}=http://127.0.0.1:7890`), `${key} 必须被写入`)
  }
  assert.ok(!text.includes('stale:9999'), '旧的手写值必须清掉')
  assert.ok(text.includes('MDCG_ROOT=x'), '用户其它内容必须保留')
})
await test('代理消失 → 该段留空（= 直连），绝不留下死地址', () => {
  envMod.reconcileEnvFile({ proxyUrl: undefined, envFile })
  const text = readFileSync(envFile, 'utf8')
  assert.ok(!/^\s*https?_proxy\s*=/im.test(text), '不能残留任何代理赋值')
  assert.ok(text.includes('MDCG_ROOT=x'))
})
await test('幂等：内容不变时不重复写', () => {
  envMod.reconcileEnvFile({ proxyUrl: 'http://127.0.0.1:7890', envFile })
  const second = envMod.reconcileEnvFile({ proxyUrl: 'http://127.0.0.1:7890', envFile })
  assert.equal(second.changed, false)
})
rmSync(dir, { recursive: true, force: true })

console.log('\nglobal-dispatcher.js · 运行期切换全局 dispatcher（真正让 fetch 走代理的那条腿）')
const gdMod = await import(new URL('../lib/global-dispatcher.js', import.meta.url).href)
const gd = await gdMod.createGlobalProxyDispatcher({ log: { info: () => {}, warn: () => {} } })
if (gd === undefined) {
  console.log('  ○ 能装载 undici 并拿到 EnvHttpProxyAgent\n      SKIP：本机未安装 DSH（CI 环境属正常）')
} else {
  await test('能装载 undici 并拿到 EnvHttpProxyAgent', () => {
    assert.ok(typeof gd.sync === 'function')
  })
  await test('sync(代理) → 已装代理 dispatcher；sync(undefined) → 回落直连', () => {
    assert.equal(gd.sync('http://127.0.0.1:7890'), true)
    assert.equal(gd.isInstalled(), true)
    assert.equal(gd.sync(undefined), false)
    assert.equal(gd.isInstalled(), false)
  })
  await test('dispose 之后不残留代理 dispatcher', () => {
    gd.sync('http://127.0.0.1:7890')
    gd.dispose()
    assert.equal(gd.isInstalled(), false)
  })
}

console.log('\ndsh-home.js · 数据根目录解析（防"两处各拼路径"漂移）')
const homeMod = await import(new URL('../lib/dsh-home.js', import.meta.url).href)
const savedDshHome = process.env.DSH_HOME
await test('未设 DSH_HOME → 落到 ~/.dsh', () => {
  delete process.env.DSH_HOME
  const home = homeMod.resolveDshHome()
  assert.ok(home.endsWith('.dsh'), `意外路径：${home}`)
  assert.ok(home.startsWith(homedir()), '应在用户主目录下')
})
await test('设了 DSH_HOME → 用它', () => {
  process.env.DSH_HOME = 'X:/custom-home'
  assert.equal(homeMod.resolveDshHome(), 'X:/custom-home')
  assert.equal(homeMod.dshHomePath('.env'), join('X:/custom-home', '.env'))
})
await test('显式配置优先于 DSH_HOME', () => {
  process.env.DSH_HOME = 'X:/custom-home'
  assert.equal(homeMod.resolveDshHome('Y:/explicit'), 'Y:/explicit')
})
await test('空白值视为未设置（否则会悄悄落到当前工作目录）', () => {
  for (const blank of ['', '   ']) {
    process.env.DSH_HOME = blank
    const home = homeMod.resolveDshHome()
    assert.notEqual(home, process.cwd(), '空白 DSH_HOME 不得把 home 解析到工作目录')
    assert.ok(home.endsWith('.dsh'), `空白值应回退到 ~/.dsh，实际：${home}`)
    assert.equal(homeMod.resolveDshHome(blank), home, '显式空白也应回退')
  }
})
await test('派生数据落在 cache/ 下（快照不再散在 home 根）', () => {
  process.env.DSH_HOME = 'X:/custom-home'
  const state = homeMod.dshCachePath('dsh-proxy-auto', 'state.json')
  assert.equal(state, join('X:/custom-home', 'cache', 'dsh-proxy-auto', 'state.json'))
  // 关键回归：以前是 home 根下的 dsh-proxy-auto.state.json，现在必须先经过 cache/
  assert.ok(state.includes('cache'), '快照必须落在 cache 目录内')
})
if (savedDshHome === undefined) { delete process.env.DSH_HOME } else { process.env.DSH_HOME = savedDshHome }

console.log('\nprompt-hint.js · 系统提示词引导段（解决"模型不主动调用工具"）')
const hintMod = await import(new URL('../lib/prompt-hint.js', import.meta.url).href)
await test('注册参数正确：段名 / 段位 / 文案（走 ctx.get，即真实宿主路径）', () => {
  let captured = null
  const fakeCtx = {
    // 官方 SKILL.md：可选服务用 ctx.get(name)（不需要 inject）；ctx.name 才需要 inject。
    get: (name) => (name === 'systemPrompt' ? { section: (section) => { captured = section; return () => {} } } : undefined),
  }
  const result = hintMod.installPromptHint(fakeCtx, hintMod.resolveHintText(''))
  assert.equal(result.registered, true)
  assert.equal(captured.name, hintMod.PROMPT_SECTION_NAME)
  assert.equal(captured.order, hintMod.PROMPT_SECTION_ORDER)
  assert.equal(captured.text, hintMod.DEFAULT_PROMPT_HINT)
  assert.equal(result.chars, hintMod.DEFAULT_PROMPT_HINT.length)
})
await test('ctx.get 拿不到服务 → 降级（不因缺服务而让插件不加载）', () => {
  const result = hintMod.installPromptHint({ get: () => undefined }, hintMod.resolveHintText(''))
  assert.equal(result.registered, false)
  assert.match(result.reason, /unavailable/)
})
await test('属性兜底路径仍可用（ctx.systemPrompt 直接可读时）', () => {
  let captured = null
  const result = hintMod.installPromptHint(
    { systemPrompt: { section: (section) => { captured = section; return () => {} } } },
    'custom'
  )
  assert.equal(result.registered, true)
  assert.equal(captured.text, 'custom')
})
await test('段位夹在官方 web_fetch 段之后（2100 < order < 2200）', () => {
  // 依据 @deepseek-ai/dsh-system-prompt 的 SECTION_ORDERS：
  // TOOL_WEB_FETCH=2100、TOOL_LSP=2200 —— 我们的纠正段必须读在 web_fetch 说明之后。
  assert.ok(hintMod.PROMPT_SECTION_ORDER > 2100, 'order 必须大于 TOOL_WEB_FETCH')
  assert.ok(hintMod.PROMPT_SECTION_ORDER < 2200, 'order 必须小于 TOOL_LSP')
})
await test('服务缺失 → 降级为未注册（绝不因此加载失败）', () => {
  const result = hintMod.installPromptHint({}, hintMod.resolveHintText(''))
  assert.equal(result.registered, false)
  assert.match(result.reason, /unavailable/)
})
await test('注册抛错 / 服务读取抛错 → 都降级不抛', () => {
  const boom = { systemPrompt: { section: () => { throw new Error('duplicate') } } }
  assert.equal(hintMod.installPromptHint(boom, 'x').registered, false)
  const getterBoom = {}
  Object.defineProperty(getterBoom, 'systemPrompt', { get() { throw new Error('no scope') } })
  assert.equal(hintMod.installPromptHint(getterBoom, 'x').registered, false)
})
await test('自定义文案生效；空白回退默认', () => {
  assert.equal(hintMod.resolveHintText('  用 proxy_fetch 抓  '), '用 proxy_fetch 抓')
  assert.equal(hintMod.resolveHintText('   '), hintMod.DEFAULT_PROMPT_HINT)
  assert.equal(hintMod.resolveHintText(undefined), hintMod.DEFAULT_PROMPT_HINT)
})

console.log('\nfetch-fallback.js · web_fetch 失败兜底（B 方案）')
const fbMod = await import(new URL('../lib/fetch-fallback.js', import.meta.url).href)
await test('只对 web_fetch 的失败结果兜底', () => {
  assert.equal(fbMod.shouldInjectFallback({ name: 'web_fetch' }, { isError: true }), true)
  assert.equal(fbMod.shouldInjectFallback({ name: 'web_fetch' }, { isError: false }), false)
  assert.equal(fbMod.shouldInjectFallback({ name: 'proxy_fetch' }, { isError: true }), false)
  assert.equal(fbMod.shouldInjectFallback(undefined, { isError: true }), false)
})
await test('纠正上下文含 URL 且指向 proxy_fetch', () => {
  const built = fbMod.buildFallbackContext('https://blocked.example/a')
  const text = built.content[0].text
  assert.match(text, /proxy_fetch/)
  assert.match(text, /https:\/\/blocked\.example\/a/)
  assert.equal(built.source.kind, 'plugin:dsh-proxy-auto')
  // 宿主把注入对象当完整 UserMessage 采纳：缺 id/role 会写坏会话
  assert.equal(typeof built.id, 'string')
  assert.equal(built.id.length > 0, true)
  assert.equal(built.role, 'user')
  // v4 会话格式硬拒已退役的 plugin 包装：source 只能是生产者自有 kind。
  // 第一方插件用裸名；第三方插件按宿主迁移层约定用 `plugin:<插件名>`。
  assert.equal(built.source.plugin, undefined)
})
await test('post-execute 追加 additionalContexts，且保留原决定', async () => {
  let handler = null
  const { state } = fbMod.installFetchFallback({ on: (_n, fn) => ((handler = fn), () => {}) })
  assert.equal(state.installed, true)
  const decision = await handler(
    { name: 'web_fetch', arguments: { url: 'https://blocked.example/' } },
    { isError: true },
    async () => ({ kind: 'accept' })
  )
  assert.equal(decision.kind, 'accept')
  assert.equal(decision.additionalContexts.length, 1)
  assert.match(decision.additionalContexts[0].content[0].text, /proxy_fetch/)
  assert.equal(state.injected, 1)
})
await test('成功结果 / 其它工具 → 原样返回，不注入', async () => {
  let handler = null
  fbMod.installFetchFallback({ on: (_n, fn) => ((handler = fn), () => {}) })
  const ok = await handler({ name: 'web_fetch', arguments: {} }, { isError: false }, async () => ({ kind: 'accept' }))
  assert.equal(ok.additionalContexts, undefined)
  const other = await handler({ name: 'read', arguments: {} }, { isError: true }, async () => ({ kind: 'accept' }))
  assert.equal(other.additionalContexts, undefined)
})
await test('下游已 block → 仍然注入，且原样保留 feedback', async () => {
  let handler = null
  fbMod.installFetchFallback({ on: (_n, fn) => ((handler = fn), () => {}) })
  const blocked = { kind: 'block', feedback: [{ type: 'text', text: 'x' }] }
  const r = await handler({ name: 'web_fetch', arguments: {} }, { isError: true }, async () => blocked)
  assert.equal(r.kind, 'block')
  assert.equal(r.feedback[0].text, 'x')
  assert.equal(r.additionalContexts.length, 1)
  assert.match(r.additionalContexts[0].content[0].text, /proxy_fetch/)
})
await test('诊断计数：调用数 / 工具名 / 失败工具名 / 命中数 / 决定分布', async () => {
  let handler = null
  const { state } = fbMod.installFetchFallback({ on: (_n, fn) => ((handler = fn), () => {}) })
  await handler(
    { name: 'web_fetch', arguments: { url: 'https://blocked.example/' } },
    { isError: true },
    async () => ({ kind: 'accept' })
  )
  await handler({ name: 'read', arguments: {} }, { isError: false }, async () => ({ kind: 'accept' }))
  assert.equal(state.calls, 2)
  assert.equal(state.matched, 1)
  assert.equal(state.injected, 1)
  assert.equal(state.errorTools.includes('web_fetch'), true)
  assert.equal(state.errorTools.includes('read'), false)
  assert.equal(state.tools.includes('read'), true)
  assert.equal(state.kinds.accept, 2)
  assert.equal(state.lastDecisionKind, 'accept')
  assert.equal(state.skippedKind, 0)
})
await test('已有 additionalContexts → 追加而不覆盖', async () => {
  let handler = null
  fbMod.installFetchFallback({ on: (_n, fn) => ((handler = fn), () => {}) })
  const existing = { content: [{ type: 'text', text: 'existing' }], source: { kind: 'other-plugin' } }
  const decision = await handler(
    { name: 'web_fetch', arguments: {} },
    { isError: true },
    async () => ({ kind: 'accept', additionalContexts: [existing] })
  )
  assert.equal(decision.additionalContexts.length, 2)
  assert.equal(decision.additionalContexts[0].content[0].text, 'existing')
})
await test('没有事件 API → 降级不抛', () => {
  const { state } = fbMod.installFetchFallback({})
  assert.equal(state.installed, false)
  assert.match(state.reason, /event-api-unavailable/)
})

console.log('\nconfig.js + index.js · 宿主投影 config = undefined 时也绝不失效')
// 事故背景（2026-10-16 实测）：DSH 桌面形态下 schemastery 只存在于 app.asar 内，
// schema-loader 拼文件系统路径解析不到 → config.js 走降级壳。旧降级壳只返回 {}，
// 宿主据此投影出 config = undefined，apply 首行读 config.probeTimeoutMs 抛 TypeError，
// 整个条目 "did not activate"（GUI 显示"异常"）：无 proxy_fetch、无引导段、无看门狗。
const cfgMod = await import(new URL('../lib/config.js', import.meta.url).href)
const idxMod = await import(new URL('../lib/index.js', import.meta.url).href)
const schemaMod2 = await import(new URL('../lib/config-schema.js', import.meta.url).href)

await test('降级壳带完整默认值：validate 出来的 config 不是 undefined', () => {
  const std = cfgMod.default?.['~standard']
  assert.ok(std, '导出的 Config 必须是 Standard Schema（带 ~standard）')
  const viaEmpty = std.validate(undefined).value
  const viaObject = std.validate({}).value
  assert.ok(viaEmpty && typeof viaEmpty === 'object', '宿主投影 undefined 时必须回落到默认值')
  assert.equal(viaEmpty.probeTimeoutMs, schemaMod2.DEFAULT_CONFIG.probeTimeoutMs)
  assert.equal(viaObject.watchIntervalMs, schemaMod2.DEFAULT_CONFIG.watchIntervalMs)
  assert.equal(viaObject.promptHint, schemaMod2.DEFAULT_CONFIG.promptHint)
  assert.equal(viaObject.fetchFallback, schemaMod2.DEFAULT_CONFIG.fetchFallback)
})

await test('调用方显式配置优先于降级默认值', () => {
  const value = cfgMod.default['~standard'].validate({ watchIntervalMs: 7000 }).value
  assert.equal(value.watchIntervalMs, 7000)
  assert.equal(value.probeTimeoutMs, schemaMod2.DEFAULT_CONFIG.probeTimeoutMs)
})

await test('apply(undefined / {}) 不抛，proxy_fetch 与引导段照常注册', () => {
  const tmpHome = mkdtempSync(join(tmpdir(), 'pxa-config-'))
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = tmpHome
  const buildCtx = () => {
    const seen = { tools: [], disposers: [] }
    const ctx = {
      logger: { info() {}, warn() {}, error() {} },
      get: (n) => (n === 'systemPrompt' ? { section: (s) => (seen.hint = s, () => {}) } : undefined),
      tools: { register: (def) => (seen.tools.push(def), () => {}) },
      effect: (fn) => { seen.disposers.push(fn()); },
    }
    return { ctx, seen }
  }
  try {
    for (const config of [undefined, {}]) {
      const { ctx, seen } = buildCtx()
      idxMod.apply(ctx, config)
      assert.ok(seen.tools.length > 0, 'config 缺失时 proxy_fetch 仍必须注册')
      assert.ok(seen.hint, 'config 缺失时引导段仍必须注入')
      for (const dispose of seen.disposers) dispose()
    }
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
    try { rmSync(tmpHome, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
  }
})

console.log(`\n结果：${passed} 通过，${failed} 失败${skipped > 0 ? `，${skipped} 跳过（无宿主环境）` : ''}`)
restoreProxyEnv()
if (failed > 0) process.exitCode = 1
