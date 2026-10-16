/**
 * 宿主依赖探针：由**宿主自己的 Node**执行，验证插件运行期要用的宿主依赖能否解析。
 *
 * 为什么需要它：DSH 桌面形态下依赖在 `resources/app.asar` 内，PowerShell 的 `Test-Path`
 * 一律看不到（不是安装损坏，是 PowerShell 没有 Electron 的 asar 支持）。于是 verify.ps1
 * 只能借宿主运行时来问一句"这些包你到底能不能 require"。
 *
 * 用法（Windows）：
 *   $env:ELECTRON_RUN_AS_NODE = '1'
 *   & "<应用>\DeepSeek Harness.exe" "<本文件路径>"
 * 输出：一行 JSON `{ node, deps: { name: {ok, resolved} } }`
 */

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 与 lib/host-module.js 的锚点推导保持一致（这里独立实现，避免依赖 ESM 图）。 */
function anchors() {
  const out = []
  const push = (p) => { if (typeof p === 'string' && p.length > 0) out.push(p) }
  if (typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0) {
    const r = process.resourcesPath
    // 最关键的一条：DSH 包根。插件的运行期解析正是从这里命中的
    // （…\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\index.js 的 require 树）
    push(join(r, 'app.asar', 'dsh', 'package.json'))
    push(join(r, 'app.asar', 'package.json'))
    push(join(r, 'app', 'dsh', 'package.json'))
    push(join(r, 'app', 'package.json'))
    push(join(r, 'app.asar.unpacked', 'package.json'))
    push(join(r, 'package.json'))
  }
  const argv1 = process.argv?.[1]
  if (typeof argv1 === 'string' && argv1.length > 3 && /[\\/]/.test(argv1)) push(argv1)
  if (process.env.APPDATA) push(join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  let dir = process.execPath
  for (let i = 0; i < 6 && typeof dir === 'string' && dir.length > 3; i++) {
    const cut = Math.max(dir.lastIndexOf('\\'), dir.lastIndexOf('/'))
    if (cut <= 2) break
    dir = dir.slice(0, cut)
    push(join(dir, 'resources', 'app.asar', 'package.json'))
    push(join(dir, 'package.json'))
  }
  return [...new Set(out)]
}

const names = ['@deepseek-ai/schemastery', '@deepseek-ai/dsh-http-proxy', 'undici']
const deps = {}
for (const name of names) {
  let found = { ok: false, resolved: null }
  for (const anchor of anchors()) {
    let req
    try { req = createRequire(anchor) } catch { continue }
    try {
      const resolved = req.resolve(name)
      req(name) // 真 require 一次，避免"路径存在但加载失败"
      found = { ok: true, resolved }
      break
    } catch { /* 换下一个锚点 */ }
  }
  deps[name] = found
}

/** 直接按路径检查（asar 内 undici 的落点），补充 require 解析不到的情况。 */
const pathProbes = []
for (const rel of ['app.asar/dsh/node_modules/undici/index.js', 'app.asar/node_modules/undici/index.js']) {
  if (typeof process.resourcesPath !== 'string') break
  const p = join(process.resourcesPath, ...rel.split('/'))
  pathProbes.push({ path: p, exists: existsSync(p) })
}

process.stdout.write(
  JSON.stringify({
    node: process.version,
    electron: process.versions?.electron ?? null,
    execPath: process.execPath,
    resourcesPath: process.resourcesPath ?? null,
    deps,
    pathProbes,
  }) + '\n'
)
