/**
 * 从**宿主安装目录**装载 `@deepseek-ai/schemastery`，同时提供**同步**与异步两条路。
 *
 * 为什么需要它（踩过的坑）：
 *   插件不在 profile 内（放在工作区/任意目录）。Node 从插件目录向上找 `node_modules` 时够不到
 *   DSH 安装处，于是 `import '@deepseek-ai/schemastery'` 直接 `MODULE_NOT_FOUND`
 *   —— 插件在启动阶段导入失败，整个条目不激活。
 *   建 junction 能解，但要手工/脚本维护、换机容易忘；**按绝对路径运行时解析**则让插件完全自包含。
 *
 * 为什么必须用**真的** schemastery：
 *   产物要交给 Cordis/DSH 当 Standard Schema 校验并按默认值投影。自制壳一旦契约不完全一致，
 *   表现是"设置界面静默不可用"（官方排障记录的原话），极难定位。所以这里只解决"怎么找到它"。
 *
 * 为什么需要同步版本：
 *   插件必须**同步导出** `Config`，而模块顶层不能 await。因此先用 `createRequire` 走 CJS 入口
 *   同步装载（schemastery 提供 CJS 构建）；装载不到时由调用方降级，插件其余功能照常。
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 收集候选**目录**（全局安装与打包两种形态）。 */
function candidateDirs() {
  const dirs = []
  const explicit = process.env.DSH_PROXY_AUTO_SCHEMASTERY
  if (typeof explicit === 'string' && explicit.trim().length > 0) dirs.push(explicit.trim())
  if (process.env.APPDATA) {
    dirs.push(join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'schemastery'))
  }
  let dir = process.execPath
  for (let i = 0; i < 8 && dir.length > 3; i++) {
    const cut = Math.max(dir.lastIndexOf('\\'), dir.lastIndexOf('/'))
    if (cut <= 2) break
    dir = dir.slice(0, cut)
    dirs.push(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'schemastery'))
    dirs.push(join(dir, 'node_modules', '@deepseek-ai', 'schemastery'))
  }
  // 兜底：工作区里可能建了 junction。
  dirs.push(join(process.cwd(), 'node_modules', '@deepseek-ai', 'schemastery'))
  return [...new Set(dirs)]
}

/** 挑一个可用的入口文件（CJS 优先，便于同步 require）。 */
function pickEntryCandidates(dir) {
  const out = []
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const exp = pkg.exports?.['.']
    const values = []
    if (typeof exp === 'string') values.push(exp)
    else if (exp && typeof exp === 'object') {
      for (const key of ['require', 'node', 'default', 'import']) {
        const v = exp[key]
        if (typeof v === 'string') values.push(v)
      }
    }
    if (typeof pkg.main === 'string') values.push(pkg.main)
    if (typeof pkg.module === 'string') values.push(pkg.module)
    for (const rel of values) out.push(join(dir, rel))
  } catch {
    // package.json 读不到就靠下面的目录扫描。
  }
  const libDir = join(dir, 'lib')
  if (existsSync(libDir)) {
    for (const f of readdirSync(libDir)) {
      if (/^index\.(cjs|mjs|js)$/.test(f)) out.push(join(libDir, f))
    }
  }
  out.push(dir)
  return out
}

let cached

/**
 * 同步装载 schemastery。
 *
 * @returns {{ Schema: any, modulePath: string } | undefined} 找不到时返回 undefined（由调用方降级）
 */
export function tryLoadSchemasterySync() {
  if (cached !== undefined) return cached
  const require = createRequire(join(process.execPath, '..', 'noop.js'))
  for (const dir of candidateDirs()) {
    if (!existsSync(dir)) continue
    for (const entry of pickEntryCandidates(dir)) {
      if (!existsSync(entry)) continue
      try {
        const mod = require(entry)
        const Schema = mod?.default ?? mod?.Schema ?? mod
        if (Schema !== undefined && typeof Schema.object === 'function') {
          cached = { Schema, modulePath: entry }
          return cached
        }
      } catch {
        // 这个入口不行（可能是 ESM-only），试下一个。
      }
    }
  }
  return undefined
}

/**
 * 异步装载（ESM 入口也可用）。同步失败时的第二选择。
 *
 * @returns {Promise<{ Schema: any, modulePath: string }>}
 */
export async function loadSchemastery() {
  const sync = tryLoadSchemasterySync()
  if (sync !== undefined) return sync
  for (const dir of candidateDirs()) {
    if (!existsSync(dir)) continue
    for (const entry of pickEntryCandidates(dir)) {
      if (!existsSync(entry)) continue
      try {
        const mod = await import(pathToFileURL(entry).href)
        const Schema = mod?.default ?? mod?.Schema ?? mod
        if (Schema !== undefined && typeof Schema.object === 'function') {
          cached = { Schema, modulePath: entry }
          return cached
        }
      } catch {
        // 试下一个入口。
      }
    }
  }
  throw new Error(
    '未找到 @deepseek-ai/schemastery：请确认 DSH 安装完整，或用环境变量 DSH_PROXY_AUTO_SCHEMASTERY 指定其目录/入口。'
  )
}

/** 供诊断：已解析到的入口。 */
export function schemaBuilderPath() {
  return cached?.modulePath
}
