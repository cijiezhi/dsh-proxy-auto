/**
 * 宿主依赖装载器（node 半边通用）—— 解决"插件在 profile 里、宿主依赖打包在 app.asar 里"。
 *
 * 为什么需要它（2026-10-16 实测，DSH 桌面 0.2.0-rc.2 暴露）：
 *   DSH 桌面应用把 `undici` / `dsh-http-proxy` / `schemastery` 全部打进 `resources/app.asar`，
 *   文件系统里根本没有这些目录。插件又不在宿主的 `node_modules` 树内，于是：
 *     · `import('undici')`（裸名）→ 从插件位置向上找不到 → ERR_MODULE_NOT_FOUND
 *     · 拼绝对路径 `resources/app.asar/node_modules/undici/index.js` → 普通 fs 看不见 asar 内容
 *   结果 dispatcher / seam 两条腿全断（快照里只留 `dispatcherModule: null`）。
 *
 * 成熟做法（Electron 官方与社区一致）：
 *   ① 用 **asar 自身当锚点**建 `createRequire(join(resourcesPath, 'app.asar', 'package.json'))`，
 *      让 Node 的正常解析算法在 asar 内找包（`req.resolve('undici')` 能命中）；
 *   ② 用 **CJS `require`** 加载，不要用 ESM `import()` —— Electron 的 asar 支持打在 CJS 的
 *      `Module._load` 上，而对 asar 内文件做 ESM 动态 `import()` 长期有问题
 *      （electron/electron#40211）。
 *   ③ asar 关闭 / 解包安装时同一锚点也成立（那时 resources/app 是真实目录）。
 *
 * 本文件只解决"怎么找到它"，不猜任何业务契约；失败时返回 undefined 并把每个锚点/候选的
 * 结果写进 `diagnostics`，让快照能直接回答"是没找到，还是找到了但契约不符"。
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'

/** Electron 桌面形态的候选 anchor（require 解析起点）。 */
export function hostAnchors() {
  const anchors = []
  const push = (p) => {
    if (typeof p === 'string' && p.length > 0) anchors.push(p)
  }
  // ① 打包形态：resources/app.asar（最可靠；进程内取值，不依赖 cwd）
  if (typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0) {
    const resources = process.resourcesPath
    push(join(resources, 'app.asar', 'package.json'))
    push(join(resources, 'app', 'package.json'))
    push(join(resources, 'app.asar.unpacked', 'package.json'))
    push(join(resources, 'package.json'))
  }
  // ② Electron 常在 argv[1] 里给出 app 路径（dev 形态）
  const argv1 = process.argv?.[1]
  if (typeof argv1 === 'string' && argv1.length > 3 && /[\\/]/.test(argv1)) {
    push(argv1)
    push(join(argv1, 'package.json'))
  }
  // ③ npm 全局安装形态
  if (process.env.APPDATA) {
    push(join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    push(join(process.env.APPDATA, 'npm', 'node_modules', 'package.json'))
  }
  // ④ 可执行文件同级/向上（老形态兜底）
  let dir = process.execPath
  for (let i = 0; i < 6 && typeof dir === 'string' && dir.length > 3; i++) {
    const cut = Math.max(dir.lastIndexOf('\\'), dir.lastIndexOf('/'))
    if (cut <= 2) break
    dir = dir.slice(0, cut)
    push(join(dir, 'resources', 'app.asar', 'package.json'))
    push(join(dir, 'package.json'))
  }
  return [...new Set(anchors)]
}

const requireCache = new Map()

/** 为一个 anchor 建（并缓存）`createRequire`；anchor 非法时返回 undefined。 */
function requireFor(anchor) {
  if (requireCache.has(anchor)) return requireCache.get(anchor)
  let req
  try {
    req = createRequire(anchor)
  } catch {
    req = undefined
  }
  requireCache.set(anchor, req)
  return req
}

function short(error) {
  const text = error instanceof Error ? error.message : String(error)
  return text.split('\n')[0].slice(0, 200)
}

/**
 * 装载宿主依赖。
 *
 * **成功与失败都携带 `diagnostics`**（失败时也返回 `{ ok: false, diagnostics }`）——
 * 早先失败时直接 `return undefined`，把辛苦收集的诊断一起丢了，快照里只剩
 * `dispatcherModule: null`，根本看不出是"没找到包"还是"找到了但契约变了"。
 *
 * @param {string[]} specifiers 候选包名/路径，按优先级排列
 * @param {(mod: any) => boolean} accept 判断"这个模块是否可用"
 * @returns {Promise<{ ok: true, module: any, specifier: string, resolved: string, diagnostics: string[] }
 *                 | { ok: false, diagnostics: string[] }>}
 */
export async function loadHostModule(specifiers, accept) {
  const diagnostics = []
  const anchors = hostAnchors()
  diagnostics.push(`anchors=${anchors.length}${anchors.length > 0 ? `；首个=${anchors[0]}` : '（无可用锚点）'}`)

  for (const specifier of specifiers) {
    // ① 绝对路径候选：直接 require（Electron 的 CJS loader 认 asar 内路径）
    if (/^[A-Za-z]:[\\/]/.test(specifier)) {
      try {
        const mod = requireFor(join(specifier, '..', 'package.json'))?.(specifier)
        if (mod !== undefined && accept(mod)) {
          diagnostics.push(`路径命中：${specifier}`)
          return { ok: true, module: mod, specifier, resolved: specifier, diagnostics }
        }
        diagnostics.push(`路径 ${specifier} → 模块不符`)
      } catch (error) {
        diagnostics.push(`路径 ${specifier} → ${short(error)}`)
      }
      continue
    }

    // ② 包名：逐个 anchor 解析 + require
    for (const anchor of anchors) {
      const req = requireFor(anchor)
      if (req === undefined) continue
      try {
        const resolved = req.resolve(specifier)
        const mod = req(specifier)
        if (mod !== undefined && accept(mod)) {
          diagnostics.push(`${specifier} ← ${anchor}（${resolved}）`)
          return { ok: true, module: mod, specifier, resolved, diagnostics }
        }
        diagnostics.push(`${specifier} ← ${anchor} 命中 ${resolved}，但模块不符`)
      } catch (error) {
        diagnostics.push(`${specifier} ← ${anchor}：${short(error)}`)
      }
    }

    // ③ 兜底：ESM 动态 import（老形态下可用；asar 下可能失败，所以放最后）
    try {
      const mod = await import(specifier)
      if (mod !== undefined && accept(mod)) {
        diagnostics.push(`${specifier} ← ESM import`)
        return { ok: true, module: mod, specifier, resolved: specifier, diagnostics }
      }
      diagnostics.push(`${specifier} ← ESM import 到但模块不符`)
    } catch (error) {
      diagnostics.push(`${specifier} ← ESM import：${short(error)}`)
    }
  }
  return { ok: false, diagnostics }
}
