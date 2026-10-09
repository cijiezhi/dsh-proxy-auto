/**
 * 系统代理的「探测」——本插件的安全底线。
 *
 * 教训（用户上次的真实事故）：把代理地址当常量写死之后，代理软件一关，
 * 那个地址就变成黑洞 —— 所有请求都往一个没人监听的端口上撞，于是"整个 DSH 断网"。
 *
 * 因此本模块只有一条铁律：
 *   **绝不返回一个"配了但没人监听"的代理。**
 * 判定方式不是相信配置，而是真去连一下（TCP 三次握手）。连不上 = 当作没有代理。
 *
 * 探测顺序（先显式、后隐式）：
 *   1) 运行环境自带的 HTTPS_PROXY / HTTP_PROXY —— 用户显式设的，最高优先；
 *   2) Windows 注册表 HKCU\...\Internet Settings（代理软件一般写这里）；
 *   3) 其余平台的环境变量（与 1 同源，仅大小写差异）。
 *
 * 本模块不 import 任何 @deepseek-ai/*，只为能被纯 Node 直接跑测试。
 */

import { execFile } from 'node:child_process'
import { connect } from 'node:net'

/** 探测失败时统一的超时上限（本机端口被拒是瞬时的，这个值只兜住"没人应答"的情况）。 */
export const DEFAULT_PROBE_TIMEOUT_MS = 400

/** 一次探测结果的缓存时长。代理软件的启停由看门狗负责及时反映，这里只防抖。 */
export const DEFAULT_STATE_TTL_MS = 5000

/**
 * 把各种写法归一成 undici 能用的绝对 URL。
 *
 * 代理软件里常见三种写法：`127.0.0.1:7890`、`http://127.0.0.1:7890`、`socks5://...`。
 * 前两种归一到 http；socks 协议 undici 的 ProxyAgent 不支持，返回 undefined 让上层直连
 * （宁可不代理，也不能把一个自己处理不了的地址塞进去）。
 *
 * 校验刻意严格：**必须带端口，且主机名形如 IPv4 / [IPv6] / 合法 DNS 名**。
 * 理由是这个函数的返回值会被当真去连，宽松解析会把"随便一段文字"变成一个黑洞地址
 * ——正是上次"写死地址 → 代理关掉 → 断网"的翻版。宁可判定为"没有代理"。
 *
 * @param {string | undefined | null} raw 原始代理字符串
 * @returns {string | undefined} `http://host:port` 形式的 URL，无法安全使用时为 undefined
 */
export function normalizeProxyUrl(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text.length === 0) return undefined

  // 多代理写法（如 "http=host:port;https=host:port"）：取 https，其次取第一段。
  const first = text.includes('=') ? (text.match(/https=([^;]+)/)?.[1] ?? text.split(';')[0].split('=')[1]) : text
  const candidate = (first ?? '').trim()
  if (candidate.length === 0) return undefined

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) ? candidate : `http://${candidate}`
  let url
  try {
    url = new URL(withScheme)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:') return undefined
  if (url.port.length === 0) return undefined
  if (!isPlausibleHost(url.hostname)) return undefined
  return `${url.protocol}//${url.host}`
}

/** 主机名是否像"真实可连的地址"：IPv4、方括号 IPv6、或合法 DNS 名。 */
function isPlausibleHost(hostname) {
  if (hostname.length === 0) return false
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    return hostname.split('.').every((part) => Number(part) <= 255)
  }
  if (/^\[[0-9a-f:]+\]$/i.test(hostname)) return true
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(hostname)
}

/**
 * 读 Windows 注册表里的系统代理设置。
 *
 * 只认 `ProxyEnable=1` 且 `ProxyServer` 非空的情况；PAC（AutoConfigURL）不解析 ——
 * 解析 PAC 需要执行 JavaScript 脚本并实现 FindProxyForURL，代价与风险都不成比例，
 * 遇到 PAC 就直连（诚实降级，而不是猜一个地址）。
 *
 * @param {{ execFileImpl?: typeof execFile }} [options] 测试可注入的 execFile
 * @returns {Promise<{ proxy?: string, source: string }>} 探测到的代理与其来源
 */
export async function readWindowsSystemProxy(options = {}) {
  const run = options.execFileImpl ?? execFile
  const query = async (name) =>
    new Promise((resolve) => {
      try {
        run(
          'reg',
          ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', name],
          { windowsHide: true, timeout: 3000 },
          (error, stdout) => resolve(error ? undefined : String(stdout))
        )
      } catch {
        // execFile 也可能**同步**抛（例如沙箱直接拒绝 spawn → EPERM）。
        // 探测函数不向外冒泡：读不到就当作"没有系统代理"，由上层直连。
        resolve(undefined)
      }
    })

  const enableRaw = await query('ProxyEnable')
  if (enableRaw === undefined) return { source: 'windows-registry-unavailable' }
  if (!/ProxyEnable\s+REG_DWORD\s+0x1/i.test(enableRaw)) return { source: 'windows-registry-disabled' }

  const serverRaw = await query('ProxyServer')
  const proxy = normalizeProxyUrl(serverRaw?.match(/ProxyServer\s+REG_SZ\s+(.+)/i)?.[1])
  if (proxy === undefined) return { source: 'windows-registry-no-server' }
  return { proxy, source: 'windows-registry' }
}

/**
 * TCP 探测：这个代理地址后面真的有东西在监听吗？
 *
 * 这是"绝不返回死代理"的执行者。连接成功即认为代理活着（代理协议握手留给真正的请求去谈）。
 *
 * @param {{ host: string, port: number }} target 目标地址
 * @param {number} timeoutMs 超时上限
 * @returns {Promise<boolean>} 端口是否接受连接
 */
export function probeTcp(target, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = connect({ host: target.host, port: target.port })
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

/** 把代理 URL 拆成 probeTcp 需要的 host/port。 */
export function toTcpTarget(proxyUrl) {
  const url = new URL(proxyUrl)
  const port = url.port.length > 0 ? Number(url.port) : 80
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host.length === 0) return undefined
  return { host, port }
}

/**
 * 维护「当前这台机器有没有可用代理」的状态。
 *
 * 对外只暴露一个 `get()`：拿到的一定是**活着**的代理，或者 undefined（= 直连）。
 * 缓存只为省掉重复探测，看门狗负责及时性；任何一次网络失败都可以 `invalidate()` 立刻重探。
 */
export class ProxyState {
  /**
   * @param {{ probeTimeoutMs?: number, ttlMs?: number, execFileImpl?: typeof execFile, now?: () => number,
   *           platform?: string }} [options]
   *   `platform` 是**测试缝**：注册表探测只在 win32 分支执行，注入它就能在 Linux/macOS 上
   *   完整测到那条分支（CI 里 ubuntu 与 windows 跑同一套断言，而不是各自跳过）。
   */
  constructor(options = {}) {
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
    this.ttlMs = options.ttlMs ?? DEFAULT_STATE_TTL_MS
    this.execFileImpl = options.execFileImpl
    this.now = options.now ?? Date.now
    this.platform = options.platform ?? process.platform
    /** @type {string | undefined} 当前确认可用的代理 */
    this.proxy = undefined
    /** @type {string} 最近一次判定结果来自哪里（诊断用） */
    this.source = 'uninitialized'
    /** @type {string | undefined} 最近一次注册表读取的结论（用于"为什么没走代理"的诊断） */
    this.lastRegistrySource = undefined
    this.checkedAt = 0
    this.inFlight = null
  }

  /** 上一次判定是否已经过期。 */
  get stale() {
    return this.now() - this.checkedAt >= this.ttlMs
  }

  /** 强制下一次 get() 重新探测（网络失败后调用）。 */
  invalidate() {
    this.checkedAt = 0
  }

  /**
   * 取当前可用代理；过期或首次调用时会重新探测。
   * 并发调用共享同一次探测（inFlight）。
   *
   * @returns {Promise<string | undefined>} 可用代理 URL，或 undefined 表示直连
   */
  async get() {
    if (!this.stale) return this.proxy
    if (this.inFlight !== null) return this.inFlight
    this.inFlight = this.#refresh().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  /** 真正做一次「收集候选 → 逐个探活」的判定。 */
  async #refresh() {
    /** @type {Array<{ proxy: string, source: string }>} */
    const candidates = []

    // 显式指定候选代理（也作为测试缝）：注册表读不到的环境（沙箱、WSL）可以直接给一个。
    // 它同样要过 TCP 探活，所以"指定了但没人监听"依然是安全的直连。
    const forced = normalizeProxyUrl(process.env.DSH_PROXY_AUTO_REGISTRY)
    if (forced !== undefined) candidates.push({ proxy: forced, source: 'registry-override' })

    const envProxy = normalizeProxyUrl(
      process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
    )
    if (envProxy !== undefined) candidates.push({ proxy: envProxy, source: 'env' })

    if (this.platform === 'win32') {
      let registry
      try {
        registry = await readWindowsSystemProxy({ execFileImpl: this.execFileImpl })
      } catch (error) {
        // 读注册表本身失败（权限、被沙箱挡住、reg 不存在）绝不能让探测抛错 ——
        // 记下具体错误类型（如 EPERM / ENOENT），继续直连。"代理为什么没生效"靠这个串定位。
        registry = { source: `windows-registry-error:${error?.code ?? error?.message ?? 'unknown'}` }
      }
      if (registry.proxy !== undefined) candidates.push({ proxy: registry.proxy, source: registry.source })
      else if (candidates.length === 0) this.lastRegistrySource = registry.source
    }

    if (candidates.length === 0) {
      this.#publish(undefined, this.lastRegistrySource ?? 'none')
      return undefined
    }

    // 并发探活，取第一个真的有人监听的。这样"env 里留着已失效的地址"不会挡住注册表里那个活的。
    const probes = await Promise.all(
      candidates.map(async (candidate) => {
        const target = toTcpTarget(candidate.proxy)
        const alive = target !== undefined && (await probeTcp(target, this.probeTimeoutMs))
        return { ...candidate, alive }
      })
    )
    const alive = probes.find((probe) => probe.alive)
    if (alive !== undefined) {
      this.#publish(alive.proxy, alive.source)
      return alive.proxy
    }
    this.#publish(undefined, `${probes[0].source}-probe-failed`)
    return undefined
  }

  /** 记录一次判定结果。 */
  #publish(proxy, source) {
    this.proxy = proxy
    this.source = source
    this.checkedAt = this.now()
  }
}
