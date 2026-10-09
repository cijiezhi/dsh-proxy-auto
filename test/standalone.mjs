/**
 * 独立包自检：验证"零 junction 依赖"这条路真的成立。
 *
 * 覆盖三件在换机/升级后最容易坏的事：
 *   1) 能在**没有 junction** 的情况下按绝对路径找到宿主的 schemastery；
 *   2) 用它构建出的 Config schema 是**真的 Standard Schema**（能被解析出默认值）；
 *   3) 抓取工具的定义形态正确（参数/输出 schema 齐全、必填声明合法）。
 *
 * 运行：node test/standalone.mjs
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * 动态定位宿主的 `dsh-tools`（**不写死任何机器路径**）。
 * 找不到时调用方跳过对应用例——这个对比只是"锦上添花"，不该让整个自测在别人机器上失败。
 */
async function loadHostDefineTool() {
  const candidates = []
  if (process.env.APPDATA) {
    candidates.push(join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'))
  }
  let dir = process.execPath
  for (let i = 0; i < 8 && dir.length > 3; i++) {
    const cut = Math.max(dir.lastIndexOf('\\'), dir.lastIndexOf('/'))
    if (cut <= 2) break
    dir = dir.slice(0, cut)
    candidates.push(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'))
  }
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      const mod = await import(pathToFileURL(candidate).href)
      if (typeof mod.defineTool === 'function') return mod.defineTool
    } catch {
      // 试下一个。
    }
  }
  // 最后试裸包名（若恰好可解析）。
  try {
    const mod = await import('@deepseek-ai/dsh-tools')
    if (typeof mod.defineTool === 'function') return mod.defineTool
  } catch {
    // 忽略。
  }
  return undefined
}

const loader = await import(new URL('../lib/schema-loader.js', import.meta.url).href)
const configSchemaMod = await import(new URL('../lib/config-schema.js', import.meta.url).href)
const fetchToolMod = await import(new URL('../lib/fetch-tool.js', import.meta.url).href)

let passed = 0
let failed = 0
let skipped = 0
const test = async (label, fn) => {
  try {
    await fn()
    passed++
    console.log(`  ✔ ${label}`)
  } catch (error) {
    failed++
    console.log(`  ✘ ${label}\n      ${error.message}`)
  }
}
/** 跳过用例：用于"这台机器没装 DSH"的场景（例如 CI），保证自测仍能跑完并给出结论。 */
const skip = (label, why) => {
  skipped++
  console.log(`  ○ ${label}\n      SKIP：${why}`)
}

console.log('schema-loader.js · 零 junction 解析宿主 schemastery')
const hostSchema = loader.tryLoadSchemasterySync()
if (hostSchema === undefined) {
  skip('能同步解析到 schemastery', '本机未安装 DSH（CI 环境属正常）')
  skip('不依赖工作区里的 junction', '同上')
} else {
  await test('能同步解析到 schemastery（不需要插件目录里有 node_modules）', () => {
    assert.equal(typeof hostSchema.Schema.object, 'function')
    console.log(`      入口：${hostSchema.modulePath}`)
  })
  await test('不依赖工作区里的 junction（解析结果指向 DSH 安装目录）', () => {
    assert.ok(/AppData|npm|node_modules/i.test(hostSchema.modulePath), `意外路径：${hostSchema.modulePath}`)
  })
}

console.log('\nconfig-schema.js · 真 Standard Schema（能被解析出默认值）')
const built = configSchemaMod.buildConfigSchema()
if (built === undefined) {
  skip('同步构建成功', '本机未安装 DSH：拿不到 schemastery（CI 环境属正常）')
  skip('带默认值 / 约束生效 / 默认集完整', '同上')
} else {
  await test('同步构建成功（插件要求同步导出 Config）', () => {
    assert.equal(typeof built.schema, 'function')
  })
}
if (built !== undefined) {
  const { schema, schemaModulePath } = built
  await test('带默认值', () => {
    assert.equal(typeof schema, 'function', 'schema 应当是 Standard Schema 的可调用对象')
    const resolved = schema({})
    assert.equal(resolved.watchIntervalMs, 3000)
    assert.equal(resolved.probeTimeoutMs, 400)
    assert.equal(resolved.tool, true)
    assert.equal(resolved.persistToEnv, true)
    assert.match(resolved.noProxy, /127\.0\.0\.1/)
    assert.equal(schemaModulePath, loader.tryLoadSchemasterySync()?.modulePath)
  })
  await test('约束生效（越界值应被拒绝）', () => {
    assert.throws(() => schema({ watchIntervalMs: 10 }))
    assert.throws(() => schema({ probeTimeoutMs: 999999 }))
  })
  await test('空对象也能得到完整默认集（设置界面不会缺项）', () => {
    const resolved = schema({})
    for (const key of ['stateFile', 'envFile', 'probeUrl', 'probeRequestTimeoutMs', 'stateTtlMs', 'debug']) {
      assert.ok(key in resolved, `缺少默认值：${key}`)
    }
  })
}

console.log('\nfetch-tool.js · 工具定义形态')
let captured = null
await test('能注册；定义已是 JSON Schema 形态（插件自己编译，不依赖 defineTool）', () => {
  fetchToolMod.registerProxyFetchTool({ register: (def) => ((captured = def), () => {}) })
  assert.notEqual(captured, null, '注册未产生工具定义')
  assert.equal(captured.name, 'proxy_fetch')
  // defineTool 会把声明式 schema 编译成 JSON Schema，因此这里应当看到编译后的对象根。
  assert.equal(captured.parameters.type, 'object')
  assert.ok(captured.parameters.properties.url, '参数缺少 url')
  for (const key of ['url', 'status', 'content', 'truncated']) {
    assert.ok(key in captured.output.schema.properties, `输出缺少 ${key}`)
  }
  assert.equal(typeof captured.output.render, 'function')
  assert.equal(typeof captured.execute, 'function')
})
await test('源契约能被宿主的 defineTool 编译通过，且**与我们自己的编译结果一致**（深比较）', async () => {
  const defineTool = await loadHostDefineTool()
  if (defineTool === undefined) {
    console.log('      （未找到宿主的 dsh-tools，跳过——该项只用于与官方编译结果对比）')
    return
  }
  const compiled = defineTool({
    name: 'proxy_fetch',
    description: 'contract check',
    parameters: configSchemaMod.PROXY_FETCH_PARAMETERS,
    output: { schema: configSchemaMod.PROXY_FETCH_OUTPUT_SCHEMA, render: () => [] },
    execute: async () => ({ url: 'x', status: 200, content: '', truncated: false }),
  })
  assert.equal(compiled.name, 'proxy_fetch')
  // 我们自己编译的产物必须与官方一致——否则"没有 defineTool 时"注册出的 schema 就是坏的。
  assert.deepEqual(captured.parameters, compiled.parameters, '参数编译结果与官方不一致')
  assert.deepEqual(captured.output.schema, compiled.output.schema, '输出 schema 编译结果与官方不一致')
})
await test('私网目标被拒（与官方 web_fetch 同口径）', () => {
  for (const host of ['http://127.0.0.1/x', 'http://192.168.1.1/', 'http://10.1.2.3/', 'http://localhost:8080/']) {
    assert.notEqual(fetchToolMod.privateTargetReason(new URL(host)), undefined, `${host} 应当被拒`)
  }
  assert.equal(fetchToolMod.privateTargetReason(new URL('https://en.wikipedia.org/')), undefined)
})

console.log(`\n结果：${passed} 通过，${failed} 失败`)
if (failed > 0) process.exitCode = 1
