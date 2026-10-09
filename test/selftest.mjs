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
import { tmpdir } from 'node:os'
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

console.log(`\n结果：${passed} 通过，${failed} 失败${skipped > 0 ? `，${skipped} 跳过（无宿主环境）` : ''}`)
restoreProxyEnv()
if (failed > 0) process.exitCode = 1
