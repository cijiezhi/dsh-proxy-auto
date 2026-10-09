/**
 * 把 **undici 的全局 dispatcher** 切换成遵守环境变量的代理 dispatcher。
 *
 * 为什么这是"能用"的那条路（本机实测）：
 *   切换后，进程内所有 `fetch()` 都会按 HTTP_PROXY / HTTPS_PROXY / NO_PROXY 路由 ——
 *     https://en.wikipedia.org/wiki/Naruto → 200（经代理）
 *     https://api.deepseek.com/            → 401（NO_PROXY 命中，直连；代理挂了也不影响对话）
 *
 * 为什么必须这么做、而不是只装"代理策略"：
 *   官方 `dsh-web-fetch-http` 用自己的、**固定 IP 的** dispatcher（防 SSRF / DNS rebinding），
 *   刻意绕过全局 dispatcher —— 所以 `web_fetch` 不走代理是**官方设计**，任何插件都改不了。
 *   但官方自己的说明也给出了替代：让 agent 用能走代理的通道去抓（本插件正是把那条通道打通）。
 *
 * 为什么不用"往 process.env 写代理"：实测 Node 内置 fetch 的 env 代理是**启动时**读一次，
 * 运行期改 env 对它无效；而 `EnvHttpProxyAgent` 是在**构造时**读 env，所以
 * "改 env + 换 dispatcher"这个组合能做到**运行期切换**（这正是本插件要的）。
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'

/** 永远直连的地址：回环 + 模型 API（后者保证代理挂掉也不影响对话）。 */
export const DEFAULT_NO_PROXY = 'localhost,127.0.0.1,::1,api.deepseek.com'

/** 候选 specifier：裸包名优先，其次按安装形态推导路径。 */
function undiciCandidates() {
  const candidates = ['undici']
  const explicit = process.env.DSH_PROXY_AUTO_UNDICI
  if (typeof explicit === 'string' && explicit.trim().length > 0) candidates.push(explicit.trim())
  if (process.env.APPDATA) {
    candidates.push(join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', 'undici', 'index.js'))
  }
  let dir = process.execPath
  for (let i = 0; i < 8 && dir.length > 3; i++) {
    const cut = Math.max(dir.lastIndexOf('\\'), dir.lastIndexOf('/'))
    if (cut <= 2) break
    dir = dir.slice(0, cut)
    candidates.push(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', 'undici', 'index.js'))
  }
  try {
    candidates.push(createRequire(process.execPath).resolve('undici'))
  } catch {
    // 交给其它候选。
  }
  return [...new Set(candidates)]
}

/**
 * 装载 undici 并取出切换 dispatcher 需要的能力。
 *
 * @returns {Promise<{ getGlobalDispatcher: Function, setGlobalDispatcher: Function, EnvHttpProxyAgent: any, modulePath: string } | undefined>}
 */
export async function loadUndici() {
  for (const specifier of undiciCandidates()) {
    try {
      const href = /^[A-Za-z]:[\\/]/.test(specifier) ? `file://${specifier.replace(/\\/g, '/')}` : specifier
      const mod = await import(href)
      if (
        typeof mod.setGlobalDispatcher === 'function' &&
        typeof mod.getGlobalDispatcher === 'function' &&
        typeof mod.EnvHttpProxyAgent === 'function'
      ) {
        return {
          getGlobalDispatcher: mod.getGlobalDispatcher,
          setGlobalDispatcher: mod.setGlobalDispatcher,
          EnvHttpProxyAgent: mod.EnvHttpProxyAgent,
          /** 没代理时用的裸 Agent。 */
          Agent: mod.Agent,
          /** 显式带 dispatcher 的抓取入口（`proxy_fetch` 依赖它）。 */
          fetch: mod.fetch,
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
 * 清空代理类环境变量。
 *
 * 为什么必须清（踩过）：Node **内置 fetch 自带 env 代理**（它自己那份 undici 的 EnvHttpProxyAgent）。
 * 只要 `HTTPS_PROXY` 还留在进程环境里，哪怕代理软件已经关掉，内置 fetch 仍会把请求送去那个死端口
 * —— 表现就是"代理一关，连 example.com 都抓不到"。把变量清成'显式空'（而不是删掉）最稳：
 * undici 只在有值时才走 env 代理，空串即"已知没有代理"。
 */
function clearProxyEnv() {
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy']) {
    process.env[key] = ''
  }
}

/** 记录本次安装前的 dispatcher，卸载时原样还回去。 */
function createGlobalProxySwitch(undici, log) {
  const original = undici.getGlobalDispatcher()
  let installed = false

  return {
    /**
     * 按当前是否有可用代理，切换全局 dispatcher。
     *
     * @param {string | undefined} proxyUrl 可用代理；undefined = 直连
     * @param {string} noProxy NO_PROXY 内容
     * @returns {boolean} 本次是否处于"已装代理 dispatcher"状态
     */
    sync(proxyUrl, noProxy) {
      if (proxyUrl === undefined) {
        if (installed) {
          undici.setGlobalDispatcher(original)
          installed = false
        }
        clearProxyEnv()
        return false
      }
      // EnvHttpProxyAgent 在构造时读环境变量：先写 env，再构造，才能保证读到当前值。
      // 大小写都写：Node 与 curl 对两者的优先级理解不一致，写全最稳。
      process.env.HTTP_PROXY = proxyUrl
      process.env.HTTPS_PROXY = proxyUrl
      process.env.http_proxy = proxyUrl
      process.env.https_proxy = proxyUrl
      process.env.NO_PROXY = noProxy
      process.env.no_proxy = noProxy
      try {
        undici.setGlobalDispatcher(new undici.EnvHttpProxyAgent())
        installed = true
        return true
      } catch (error) {
        log?.warn?.(`切换全局 dispatcher 失败：${error instanceof Error ? error.message : String(error)}`)
        return installed
      }
    },
    /** 卸载：把 dispatcher 还回去（env 留给调用方决定，因为子进程还会用到）。 */
    dispose() {
      if (!installed) return
      undici.setGlobalDispatcher(original)
      installed = false
    },
    isInstalled: () => installed,
  }
}

/**
 * 创建"全局联网通道开关"。
 *
 * 它做两件事，缺一不可：
 *
 * 1) **换掉 `globalThis.fetch`**（关键）。
 *    Node 内置 fetch 自带 env 代理，且**在模块加载时就把 `HTTPS_PROXY` 烘进了它的 dispatcher**，
 *    之后改 env 对它毫无影响（实测）。于是只要历史上设过一次代理变量，**代理一关它就会去撞死端口**
 *    —— 这正是"关代理就断网"的真身。
 *    修法不是清 env（无效），而是**不再使用内置那一个**：换成我们自己的 fetch，每次请求显式带上
 *    dispatcher。
 *
 * 2) **dispatcher 按需切换**。
 *    有代理 → `EnvHttpProxyAgent`（唯一遵守 NO_PROXY 的实现）；
 *    没代理 → 裸 `Agent`（不读 env，因此**绝不会**再把请求送去一个已消失的代理）。
 *
 * @param {{ log: { info: Function, warn: Function }, noProxy?: string }} options
 * @returns {Promise<{ sync: (proxyUrl: string | undefined) => boolean, dispose: () => void, isInstalled: () => boolean, modulePath: string } | undefined>}
 */
export async function createGlobalProxyDispatcher(options) {
  const undici = await loadUndici()
  if (undici === undefined) {
    options.log?.warn?.('未能装载 undici：无法接管全局 fetch（将沿用宿主原有实现）。')
    return undefined
  }
  if (typeof undici.fetch !== 'function') {
    // 宁可 fail loud：抓取工具依赖它，缺了就等于功能没交付，不能让它在运行期才炸。
    options.log?.error?.('undici 副本缺少 fetch 导出：抓取通道不可用。')
    return undefined
  }
  const noProxy = options.noProxy ?? DEFAULT_NO_PROXY
  const originalFetch = globalThis.fetch
  const originalDispatcher = undici.getGlobalDispatcher()
  /** 没代理时用的裸 Agent：不读 env，也不会误送到死地址。 */
  const directDispatcher = new undici.Agent()
  let patched = false
  let activeDispatcher = null

  const proxiedFetch = async (input, init) => {
    const dispatcher = activeDispatcher ?? directDispatcher
    return undici.fetch(input, { ...init, dispatcher })
  }

  const restoreFetch = () => {
    if (patched) {
      globalThis.fetch = originalFetch
      patched = false
    }
    activeDispatcher = null
  }

  return {
    /**
     * 按当前是否有可用代理切换通道。
     *
     * @param {string | undefined} proxyUrl 可用代理；undefined = 直连
     * @returns {boolean} 是否处于"已装代理 dispatcher"状态
     */
    sync(proxyUrl) {
      if (proxyUrl === undefined) {
        restoreFetch()
        return false
      }
      // EnvHttpProxyAgent 在构造时读环境变量，所以先写 env 再构造。
      process.env.HTTP_PROXY = proxyUrl
      process.env.HTTPS_PROXY = proxyUrl
      process.env.http_proxy = proxyUrl
      process.env.https_proxy = proxyUrl
      process.env.NO_PROXY = noProxy
      process.env.no_proxy = noProxy
      try {
        const agent = new undici.EnvHttpProxyAgent()
        agent[installedMarker] = true
        activeDispatcher = agent
        if (!patched) {
          globalThis.fetch = proxiedFetch
          patched = true
        }
        return true
      } catch (error) {
        options.log?.warn?.(`构造代理 dispatcher 失败：${error instanceof Error ? error.message : String(error)}`)
        restoreFetch()
        return false
      }
    },
    /** 卸载：把 fetch 与 dispatcher 都还原成宿主原本的样子。 */
    dispose() {
      restoreFetch()
      undici.setGlobalDispatcher(originalDispatcher)
    },
    isInstalled: () => patched && activeDispatcher?.[installedMarker] === true,
    /**
     * 供 `proxy_fetch` 使用：**显式带 dispatcher** 的抓取。
     *
     * 与 `globalThis.fetch` 的区别正是本插件的保命细节：显式 dispatcher 能压过
     * `NODE_USE_ENV_PROXY`，因此即使宿主环境被代理变量污染，抓取仍按"当前有没有代理"走。
     *
     * @param {string} url 完整 URL
     * @param {string | undefined} proxyUrl 当前可用代理；undefined = 直连
     * @param {object} init fetch 选项
     * @returns {Promise<Response>}
     */
    fetchWith(url, proxyUrl, init) {
      const dispatcher = proxyUrl === undefined ? directDispatcher : activeDispatcher ?? directDispatcher
      return undici.fetch(url, { ...init, dispatcher })
    },
    modulePath: undici.modulePath,
  }
}

/** 标记"这是我们装的代理 dispatcher"，供诊断读取。 */
const installedMarker = Symbol.for('dsh-proxy-auto.proxiedDispatcher')
