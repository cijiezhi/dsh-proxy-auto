/**
 * 经代理的 fetch provider —— 给 DSH 的 `web_fetch` 工具接上代理。
 *
 * 官方文档《在网络代理后面运行 DSH》已明确：DSH 的出站请求（模型调用、web 搜索、页面抓取）
 * 都走标准代理环境变量，**启动时读取一次**。官方的 `dsh-web-fetch-http` 内部调用
 * `proxyRouteFor(url)`：命中代理就走全局 dispatcher，否则直连。
 *
 * 本文件不是"替代它"，而是补上官方缺的那一环：**运行时动态维持代理策略**
 * （代理软件开了就装、关了立刻卸掉，不需要重启 DSH）——因为官方只在启动时读一次 env。
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'

/**
 * 可能的解析位置。
 *
 * **顺序很关键：裸包名排第一。**
 * 理由（踩过）：`dsh-web-fetch-http` 是 `import { proxyRouteFor } from '@deepseek-ai/dsh-http-proxy'`，
 * 它读的是**模块图里那一个实例**的全局 dispatcher。本插件若改用绝对文件路径 import，
 * 拿到的是**另一个副本**——策略装在自己的副本上，`web_fetch` 那边完全看不见
 * （表现为"插件说已走代理、抓页面照样 fetch failed"）。用裸包名让 Node 走同一套解析才能命中同一实例。
 */
function candidateSpecifiers() {
  const candidates = ['@deepseek-ai/dsh-http-proxy']
  const explicit = process.env.DSH_PROXY_AUTO_HTTP_PROXY_PKG
  if (typeof explicit === 'string' && explicit.trim().length > 0) candidates.push(explicit.trim())
  // 已验证的真实落点：全局 npm 安装的 dsh 自带的依赖（本机 `%APPDATA%\npm`）。
  if (process.env.APPDATA) {
    candidates.push(
      join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-http-proxy', 'lib', 'index.js')
    )
  }
  let dir = process.execPath
  for (let i = 0; i < 8 && dir.length > 3; i++) {
    const cut = Math.max(dir.lastIndexOf('\\'), dir.lastIndexOf('/'))
    if (cut <= 2) break
    dir = dir.slice(0, cut)
    candidates.push(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-http-proxy', 'lib', 'index.js'))
    candidates.push(join(dir, 'node_modules', '@deepseek-ai', 'dsh-http-proxy', 'lib', 'index.js'))
  }
  return [...new Set(candidates)]
}

/**
 * 装载官方代理 seam。
 *
 * @returns {Promise<{ install: Function, routeFor: Function } | undefined>} 不可用时返回 undefined
 */
export async function loadProxySeam() {
  for (const specifier of candidateSpecifiers()) {
    try {
      const href = /^[A-Za-z]:[\\/]/.test(specifier) ? `file://${specifier.replace(/\\/g, '/')}` : specifier
      const mod = await import(href)
      if (typeof mod.installProxyFromEnvironment === 'function' && typeof mod.proxyRouteFor === 'function') {
        return {
          install: mod.installProxyFromEnvironment,
          routeFor: mod.proxyRouteFor,
          /** 诊断用：本次实际装载的实现位置，便于与宿主那份比对是否为同一模块实例。 */
          modulePath: import.meta.resolve?.(specifier) ?? specifier,
        }
      }
    } catch {
      // 试下一个候选。
    }
  }
  return undefined
}

/**
 * 让官方 seam 的策略跟随"当前探测结果"。
 *
 * - 探测到活代理 → 安装该代理策略（官方 `web_fetch`、模型调用等立刻改走代理）；
 * - 探测不到 → 安装"空策略"（等价直连），**并保留卸载能力**：
 *   这正是官方静态 env 方案的致命处（代理一关，DSH 连模型都连不上），本模块把这一步动态化。
 *
 * @param {{ seam: { install: Function }, log: {warn:Function, info:Function}, onDecision?: Function }} options
 */
export function createSeamInstaller(options) {
  const { seam, log } = options
  const onDecision = options.onDecision ?? (() => {})
  let disposeCurrent = null
  let currentProxy

  /** 最小 EnvLookup：`get(name) → {value} | undefined`（官方签名如此，不是普通对象）。 */
  const envLookup = (proxyUrl) => ({
    get: (name) =>
      proxyUrl !== undefined && /^(https?|all)_proxy$/i.test(name) ? { value: proxyUrl } : undefined,
  })

  const sync = async (proxyUrl) => {
    if (proxyUrl === currentProxy && disposeCurrent !== null) return true
    try {
      if (disposeCurrent !== null) await disposeCurrent()
    } catch (error) {
      log.warn(`卸载旧代理策略失败（继续安装新的）：${error instanceof Error ? error.message : String(error)}`)
    }
    disposeCurrent = null
    try {
      disposeCurrent = await seam.install(envLookup(proxyUrl), (message) => log.warn(`代理策略：${message}`))
      currentProxy = proxyUrl
      onDecision(proxyUrl === undefined ? 'seam:direct' : 'seam:proxy', proxyUrl ?? 'direct')
      if (proxyUrl !== undefined) log.info(`已把系统代理装进 DSH 官方代理策略：${proxyUrl}（代理关闭时会自动卸掉）`)
      return true
    } catch (error) {
      currentProxy = undefined
      log.warn(`安装代理策略失败，本机将直连：${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  const dispose = async () => {
    if (disposeCurrent === null) return
    try {
      await disposeCurrent()
    } finally {
      disposeCurrent = null
      currentProxy = undefined
    }
  }

  return { sync, dispose }
}

/** 诊断：官方 seam 此刻怎么判定这个 URL（只读）。 */
export function describeRoute(seam, url) {
  try {
    const route = seam.routeFor(new URL(url))
    return route.proxied === true ? `proxied via ${route.proxy}` : 'direct'
  } catch (error) {
    return `判定失败：${error instanceof Error ? error.message : String(error)}`
  }
}
