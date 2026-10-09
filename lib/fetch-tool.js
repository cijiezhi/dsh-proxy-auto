/**
 * `proxy_fetch` 工具 —— 抓取任意 URL 的正文，**能翻墙**。
 *
 * 为什么必须有它：
 *   官方 `web_fetch` 用自己的、**固定 IP 的** undici Agent（防 SSRF / DNS rebinding），
 *   刻意绕过全局 dispatcher —— 所以它**永远直连**，墙外站点必失败，任何插件都改不了（官方设计）。
 *   本工具改走**显式 dispatcher** 的通道：
 *     - 有可用代理 → `ProxyAgent`，请求经代理出去；
 *     - 没有       → 裸 `Agent`，直连。
 *
 * 为什么必须"显式"（实测教训）：
 *   若宿主环境里存在 `NODE_USE_ENV_PROXY=1`，Node 会**无视调用方指定的 dispatcher** 并强制读 env 代理；
 *   代理软件一关，请求就被送进那个已消失的端口（连 example.com 都 ECONNREFUSED）。
 *   显式带 dispatcher 可压过该开关：同一进程内实测「显式裸 Agent 直连 200 / 不传 dispatcher ECONNREFUSED」。
 *
 * 另外它做两件必要的事：
 *   1) 用与官方同样的口径**拒绝私网/回环目标**（否则这个工具就是打内网的跳板）；
 *   2) 把 HTML 粗加工为可读文本并按上限截断（避免整页塞进上下文）。
 */

import { PROXY_FETCH_OUTPUT_SCHEMA, PROXY_FETCH_PARAMETERS } from './config-schema.js'
import { compileParameters, compileValue } from './tool-schema.js'

/** 默认返回字符上限（约够读完一篇条目正文）。 */
export const DEFAULT_MAX_CHARS = 12_000
const HARD_MAX_CHARS = 60_000

/**
 * 拒绝私网、回环、链路本地与元数据地址 —— 与官方 `web-fetch-http` 的口径一致。
 *
 * @param {URL} url 待检查的 URL
 * @returns {string | undefined} 拒绝原因；undefined 表示放行
 */
export function privateTargetReason(url) {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost')) return '目标为本机地址'
  if (host === '::1' || host === '0.0.0.0') return '目标为本机地址'
  if (host.endsWith('.local')) return '目标为局域网地址'
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4 !== null) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 127 || a === 0 || a === 10) return '目标为私网/回环地址'
    if (a === 192 && b === 168) return '目标为私网地址'
    if (a === 172 && b >= 16 && b <= 31) return '目标为私网地址'
    if (a === 169 && b === 254) return '目标为链路本地地址'
  }
  return undefined
}

/** 把 HTML 粗加工成可读文本（去脚本/样式/标签、压空白、解常见实体）。 */
export function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .trim()
}

/**
 * 构造 `proxy_fetch` 的 `ToolDefinition`（**JSON Schema 形态**，直接交宿主 `tools.register`）。
 *
 * 为什么不用 `defineTool`：那是"声明式 DSL → JSON Schema"的便利层，会把插件绑到
 * `@deepseek-ai/dsh-tools` 上（换机/升级后依赖不全就装不上）。这里用 `tool-schema.js`
 * 自行完成同一套编译，产物与官方编译结果一致（有测试做深比较）。
 *
 * @param {{ getProxy?: () => string | undefined,
 *           fetchWith?: (url: string, proxyUrl: string | undefined, init: object) => Promise<Response> }} [options]
 * @returns {object} ToolDefinition
 */
export function buildProxyFetchDefinition(options = {}) {
  return {
    name: 'proxy_fetch',
    description:
      'Fetch a web page and return its readable text. Unlike web_fetch, this uses an explicit ' +
      'dispatcher, so it goes through the local proxy when the proxy is running and connects ' +
      'directly when it is not. Use it to read pages found by web_search, including blocked sites.',
    parameters: compileParameters(PROXY_FETCH_PARAMETERS),
    output: {
      schema: compileValue(PROXY_FETCH_OUTPUT_SCHEMA),
      render: (_args, value) => [
        {
          type: 'text',
          text: `URL: ${value.url}\nStatus: ${value.status}${value.truncated ? ' (truncated)' : ''}${
            value.via ? `\nVia: ${value.via}` : ''
          }\n\n${value.content}`,
        },
      ],
    },
    async execute(args, exec) {
      return executeProxyFetch(args, exec, options)
    },
  }
}

/**
 * 注册 `proxy_fetch` 工具。
 *
 * @param {{ register: (definition: unknown) => () => void }} tools 工具注册表（`ctx.tools`）
 * @param {{ getProxy?: () => string | undefined,
 *           fetchWith?: (url: string, proxyUrl: string | undefined, init: object) => Promise<Response> }} [options]
 *   `fetchWith` 必须**显式带 dispatcher**（这是本工具能翻墙、且不被环境开关带偏的唯一原因）。
 * @returns {() => void} 注销函数
 */
export function registerProxyFetchTool(tools, options = {}) {
  return tools.register(buildProxyFetchDefinition(options))
}

/** 真正执行一次抓取（与工具声明分离，便于单测直接调用）。 */
export async function executeProxyFetch(args, exec, options = {}) {
  {
    const input = args
    let url
    try {
      url = new URL(String(input.url))
    } catch {
      throw new Error(`proxy_fetch: 不是合法的绝对 URL：${String(input.url)}`)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`proxy_fetch: 只支持 http/https，收到 ${url.protocol}`)
    }
    const reason = privateTargetReason(url)
    if (reason !== undefined) throw new Error(`proxy_fetch: ${reason}（与官方 web_fetch 同口径拒绝）`)

    const maxChars = Math.min(Math.max(Number(input.max_chars) || DEFAULT_MAX_CHARS, 500), HARD_MAX_CHARS)
    const proxyUrl = options.getProxy?.()
    const init = {
      method: 'GET',
      redirect: 'follow',
      headers: { accept: 'text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8' },
      signal: exec?.signal,
    }
    const response =
      options.fetchWith !== undefined
        ? await options.fetchWith(url.toString(), proxyUrl, init)
        : await globalThis.fetch(url.toString(), init)

    const raw = await response.text()
    const contentType = response.headers.get('content-type') ?? ''
    const isHtml = /html|xml/i.test(contentType) || /^\s*</.test(raw.slice(0, 200))
    const text = isHtml ? htmlToText(raw) : raw.trim()
    const truncated = text.length > maxChars
    return {
      url: response.url || url.toString(),
      status: response.status,
      contentType,
      via: proxyUrl === undefined ? 'direct' : proxyUrl,
      content: truncated ? text.slice(0, maxChars) : text,
      truncated,
    }
  }
}
