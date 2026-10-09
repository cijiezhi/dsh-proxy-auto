/**
 * dsh-proxy-auto —— 宿主半边。
 *
 * 一句话：**让 DSH 的联网自动跟随本机代理**（代理开着就走、关着就直连），不需要重启、不写死地址。
 *
 * ── 它到底做了什么（三条腿，各管一件事）──
 *
 * 1) **全局 dispatcher**（`global-dispatcher.js`，主力）
 *    把 undici 的全局 dispatcher 换成 `EnvHttpProxyAgent`。进程内所有 `fetch()` 随之走代理，
 *    并且 `NO_PROXY`（含回环与模型 API）始终保持直连 —— 代理挂掉也不会影响对话。
 *    这是**运行期**切换，所以开/关代理都不需要重启。
 *
 * 2) **官方代理策略**（`proxy-seam.js`，让官方自己的路径也一致）
 *    官方 `@deepseek-ai/dsh-http-proxy` 的策略只在启动时按环境变量装一次；
 *    这里在运行时按探测结果装/卸，保证官方那套判定与当前现实一致。
 *
 * 3) **子进程环境 + 启动一致性**（`env-persist.js`）
 *    把探测结果写进官方 `.env`，供 curl/git 等子进程与**下次启动**使用；
 *    探测不到时该段留空 —— 因此绝不会出现"启动时读到已消失的代理 → 断网"。
 *
 * ── 以及一件刻意**不做**的事 ──
 * 不去改 `web_fetch`。官方明确说明：它用自己的、固定 IP 的 undici Agent（防 SSRF / DNS rebinding），
 * **刻意绕过全局 dispatcher**，所以它不走代理是官方设计，任何插件都改不了。
 * 需要抓墙外页面时，用本插件覆盖的通道（进程内 fetch / 子进程工具）即可。
 *
 * 依赖声明：函数插件必须命名导出 name/inject/Config/apply，且不能有 default export。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { ProxyState, DEFAULT_PROBE_TIMEOUT_MS, DEFAULT_STATE_TTL_MS } from './detect.js'
import { loadProxySeam, createSeamInstaller, describeRoute } from './proxy-seam.js'
import { reconcileEnvFile } from './env-persist.js'
import { createGlobalProxyDispatcher, DEFAULT_NO_PROXY } from './global-dispatcher.js'
import { registerProxyFetchTool } from './fetch-tool.js'

/** 插件名。 */
export const name = 'dsh-proxy-auto'

/**
 * 只声明 `tools`：注册 `proxy_fetch` 需要它。
 * 这是硬依赖而不是可选项——本插件注册的工具是"能翻墙抓页面"这条能力的唯一出口，
 * 缺了它就等于功能没交付，应当 fail loud 而不是静默少一个工具。
 */
export const inject = ['tools']

export { default as Config } from './config.js'

/** 统一日志出口：宿主有 logger 就用它，否则退回 console（插件可能被独立加载）。 */
function createLog(ctx) {
  const logger = ctx?.logger
  const write = (level, message) => {
    if (typeof logger?.[level] === 'function') logger[level](`[dsh-proxy-auto] ${message}`)
    else console[level === 'error' ? 'error' : 'log'](`[dsh-proxy-auto] ${message}`)
  }
  return {
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
  }
}

/**
 * 安装插件。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx 宿主上下文
 * @param {object} config 经 Config schema 校验后的配置
 */
export function apply(ctx, config) {
  const log = createLog(ctx)
  const state = new ProxyState({
    probeTimeoutMs: config.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    ttlMs: config.stateTtlMs ?? DEFAULT_STATE_TTL_MS,
  })

  // ── 诊断快照：把"此刻的判定"落成一个小 JSON，供外部直接查看（排障时唯一可靠的窗口）──
  const stateFile = config.stateFile?.trim() || join(homedir(), '.dsh', 'dsh-proxy-auto.state.json')
  let dispatcher = null
  let seam = null
  let installer = null
  let envFile
  let envSynced
  let lastProbe = null
  let lastWritten = ''
  let writes = 0

  // ── 交付"能翻墙抓页面"的工具 ──
  // 官方 `web_fetch` 用自己的固定 IP Agent（防 SSRF），刻意不过全局 dispatcher —— 墙外站点必失败，
  // 任何插件都改不了（官方设计）。本工具走**显式 dispatcher**：有代理走代理、没代理直连。
  // 注意必须放在 `dispatcher` 声明之后：它的回调会读这个变量（放前面会 TDZ 抛错）。
  if (config.tool !== false) {
    // 同步注册：schema 编译由插件自带的 tool-schema.js 完成，不依赖宿主的 defineTool。
    try {
      registerProxyFetchTool(ctx.tools, {
        getProxy: () => state.proxy,
        fetchWith: (url, proxyUrl, init) => {
          // dispatcher 尚未装载时（初始化瞬间）退回宿主 fetch，工具不会因为时序而不可用。
          if (dispatcher === null) return globalThis.fetch(url, init)
          return dispatcher.fetchWith(url, proxyUrl, init)
        },
      })
      log.info('已注册 proxy_fetch 工具（显式 dispatcher：有代理走代理、没代理直连）。')
    } catch (error) {
      log.error(`注册 proxy_fetch 失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const writeState = (reason) => {
    const snapshot = {
      plugin: name,
      at: new Date().toISOString(),
      reason,
      proxy: state.proxy ?? null,
      source: state.source,
      dispatcherPatched: dispatcher?.isInstalled?.() ?? false,
      dispatcherModule: dispatcher?.modulePath ?? null,
      seamLoaded: seam !== null,
      seamRoute: seam === null ? null : describeRoute(seam, 'https://example.com/'),
      envFile: envFile ?? null,
      envSynced: envSynced ?? null,
      probe: lastProbe ?? null,
      platform: process.platform,
      health: {
        processUptimeSec: Math.round(process.uptime()),
        stateFileWrites: writes,
        lastRegistrySource: state.lastRegistrySource ?? null,
      },
    }
    const text = JSON.stringify(snapshot, null, 2)
    if (text === lastWritten) return
    try {
      mkdirSync(dirname(stateFile), { recursive: true })
      writeFileSync(stateFile, text, 'utf8')
      lastWritten = text
      writes++
    } catch (error) {
      log.warn(`诊断快照写入失败（不影响联网）：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * 自证探针：在宿主进程内部真发一个请求，结果写进快照的 `probe` 字段。
   * 它是"我说要走代理"与"宿主进程里真能出去"之间唯一的实证；失败绝不影响业务请求。
   */
  const probeSelf = async () => {
    const url = typeof config.probeUrl === 'string' ? config.probeUrl.trim() : ''
    if (url.length === 0) return
    const startedAt = Date.now()
    try {
      const signal =
        typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(config.probeRequestTimeoutMs ?? 4000) : undefined
      const response = await globalThis.fetch(url, { method: 'GET', signal, redirect: 'manual' })
      lastProbe = { at: new Date().toISOString(), url, ok: true, status: response.status, ms: Date.now() - startedAt }
      try {
        await response.body?.cancel()
      } catch {
        // 关响应体失败无所谓：探针只关心"能不能到"。
      }
    } catch (error) {
      lastProbe = {
        at: new Date().toISOString(),
        url,
        ok: false,
        ms: Date.now() - startedAt,
        error: error?.cause?.code ?? error?.code ?? error?.name ?? error?.message ?? 'unknown',
      }
    }
    writeState('probe')
  }

  /** 判定一次，并让三条腿同步到同一个事实。任何调用方都汇聚到这里 —— 只有一处真相。 */
  const refresh = async () => {
    const proxy = await state.get()

    // ① 全局 dispatcher：运行期切换，开/关代理都不需要重启。
    if (dispatcher !== null) {
      const patched = dispatcher.sync(proxy)
      if (config.debug === true) log.info(`全局 dispatcher：${patched ? `经 ${proxy}` : '直连'}`)
    }

    // ② 官方策略：让官方自己的判定（以及未来基于它的工具）与当前现实一致。
    if (installer !== null) await installer.sync(proxy)

    // ③ 子进程环境与启动一致性：写官方 .env（探测不到就留空 = 直连）。
    if (config.persistToEnv !== false) {
      try {
        const result = reconcileEnvFile({ proxyUrl: proxy, envFile: config.envFile })
        envFile = result.envFile
        envSynced = proxy ?? null
      } catch (error) {
        log.warn(`同步 .env 失败（不影响运行时）：${error instanceof Error ? error.message : String(error)}`)
      }
    }

    if (config.debug === true) log.info(`代理判定：${proxy ?? '直连'}（依据：${state.source}）`)
    void probeSelf()
    writeState('refresh')
    return proxy
  }

  // 初始化：装载 undici（切 dispatcher 的能力）与官方 seam。
  const ready = (async () => {
    dispatcher = await createGlobalProxyDispatcher({ log, noProxy: config.noProxy || DEFAULT_NO_PROXY })
    seam = await loadProxySeam()
    if (seam === null) {
      log.warn('未找到 @deepseek-ai/dsh-http-proxy：官方策略无法运行时维护（全局 dispatcher 仍生效）。')
    } else {
      installer = createSeamInstaller({ seam, log })
    }
    await refresh()
  })().catch((error) => {
    // 失败必须响亮，但绝不能拖停宿主：退化为"不维护联网通道"。
    log.error(`初始化失败，联网通道将不被维护：${error instanceof Error ? error.message : String(error)}`)
  })

  ctx.effect(() => {
    let stopped = false

    const tick = async () => {
      if (stopped) return
      try {
        await refresh()
      } catch (error) {
        log.warn(`代理探测异常，本次按直连处理：${error instanceof Error ? error.message : String(error)}`)
        state.invalidate()
      }
    }

    const timer = setInterval(() => void tick(), config.watchIntervalMs ?? 3000)
    timer.unref?.()
    const heartbeat = setInterval(() => writeState('heartbeat'), 30000)
    heartbeat.unref?.()

    return () => {
      stopped = true
      clearInterval(timer)
      clearInterval(heartbeat)
      // 卸载时必须还原：dispatcher 还回去、官方策略卸掉、.env 回到"当前真实状态"。
      void ready
        .then(async () => {
          installer?.dispose?.()
          dispatcher?.dispose?.()
          if (config.persistToEnv !== false) reconcileEnvFile({ proxyUrl: state.proxy, envFile: config.envFile })
        })
        .catch(() => {})
      writeState('disposed')
    }
  }, 'dsh-proxy-auto: network channel watchdog')

  log.info('已接管联网通道：现场判定「全局 dispatcher 是否经代理」，代理关闭时自动回落直连。')
}
