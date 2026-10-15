/**
 * 系统提示词引导段：让模型**主动**用 `proxy_fetch` 去抓被墙页面。
 *
 * 为什么需要它：工具注册 ≠ 模型会调用。`web_fetch` 与 `proxy_fetch` 同时在工具清单里，
 * 而"抓网页"这个意图上模型更倾向名字更直白的 `web_fetch` —— 它按官方设计永远直连
 * （固定 IP 防 SSRF，刻意绕过全局 dispatcher），对被墙站点必然失败。
 * 结果就是用户看到"装了插件没效果"：其实模型压根没调用我们的工具。
 *
 * 官方系统提示词子系统允许插件注册分段（`ctx.systemPrompt.section()`），
 * 官方文档原话："schema 会自动流入系统提示词的组装过程"、"段按 order 升序拼接"。
 * 我们注册一段，紧跟在官方 `web_fetch` 的说明之后，把"何时该改用 proxy_fetch"写清楚。
 *
 * 段位依据（`@deepseek-ai/dsh-system-prompt` 的 SECTION_ORDERS）：
 *
 *   TOOL_WEB_FETCH = 2100   ← 官方 web_fetch 的说明
 *   TOOL_LSP       = 2200
 *
 * 取 2150：正好夹在两者之间，于是模型的阅读顺序是
 * "web_fetch 说明 → 我们这段纠正 → 其余工具说明"，且不与任何官方段位冲突。
 */

/** 段名（同层重名会抛；这个名字只属于本插件）。 */
export const PROMPT_SECTION_NAME = 'dsh-proxy-auto:web-fetch-hint'

/** 段位：紧跟官方 `TOOL_WEB_FETCH`(2100) 之后、`TOOL_LSP`(2200) 之前。 */
export const PROMPT_SECTION_ORDER = 2150

/**
 * 默认引导文案。
 *
 * 写法上只讲事实与动作：官方 `web_fetch` 为何必然失败（设计如此）、何时改用 `proxy_fetch`、
 * 以及**别在试过之前就下结论说站点不可达**（模型常见的过早放弃行为）。
 */
export const DEFAULT_PROMPT_HINT = [
  'Web fetching: the built-in `web_fetch` tool always connects directly — by design it ignores',
  'every proxy, so it fails on sites blocked by the network. When a page may be blocked, or when',
  '`web_fetch` fails or times out, use the `proxy_fetch` tool instead (same URL): it follows the',
  'local proxy when one is running and connects directly otherwise. Do not tell the user that a',
  'blocked site is unreachable before trying `proxy_fetch`.',
].join(' ')

/**
 * 取生效的引导文案（配置留空 = 用默认）。
 *
 * @param {string} [configured] 用户自定义文案
 * @returns {string} 文案
 */
export function resolveHintText(configured) {
  const text = typeof configured === 'string' ? configured.trim() : ''
  return text.length > 0 ? text : DEFAULT_PROMPT_HINT
}

/**
 * 注册引导段（服务不可用/注册失败时**降级**，绝不让插件因此加载不了）。
 *
 * @param {object} ctx Cordis 上下文
 * @param {string} text 生效文案
 * @returns {{ registered: boolean, reason?: string, disposer?: () => void, name: string,
 *             order: number, chars: number }}
 */
export function installPromptHint(ctx, text) {
  const base = {
    registered: false,
    name: PROMPT_SECTION_NAME,
    order: PROMPT_SECTION_ORDER,
    chars: text.length,
  }

  let service
  try {
    // 取服务的正确姿势（官方 cordis-plugin-development/SKILL.md）：
    //   `ctx.get('x')` **不需要 inject**；而 `ctx.x` **需要 inject**，否则 Guard 会抛
    //   `cannot get property "x" without inject`（这正是本插件第一版踩到的坑）。
    // 这里要的是"有就用、没有就降级"，所以用 get 做**可选访问**——
    // 既不把 systemPrompt 变成硬依赖（裁剪过的宿主也能装），又能拿到服务。
    service = typeof ctx?.get === 'function' ? ctx.get('systemPrompt') : undefined
    if (service === undefined || service === null) {
      // 兜底：极少数组合可能把服务直接挂在属性上（那条路通常需要 inject，失败即降级）。
      try {
        service = ctx?.systemPrompt
      } catch {
        service = undefined
      }
    }
  } catch (error) {
    return { ...base, reason: `system-prompt-unreadable: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (service === undefined || service === null || typeof service.section !== 'function') {
    return { ...base, reason: 'system-prompt-service-unavailable' }
  }

  try {
    const disposer = service.section({
      name: PROMPT_SECTION_NAME,
      order: PROMPT_SECTION_ORDER,
      text,
    })
    return { ...base, registered: true, disposer }
  } catch (error) {
    return {
      ...base,
      reason: `section-registration-failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
