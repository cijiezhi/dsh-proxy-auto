/**
 * B 方案：`web_fetch` 失败时**自动兜底** —— 给下一次模型请求附上"改用 proxy_fetch 重试"。
 *
 * 为什么需要它：A 方案（系统提示词引导段）能让模型**大概率**优先用 `proxy_fetch`，
 * 但 LLM 行为非确定。若它还是先调了官方 `web_fetch`——那个工具按设计永远直连、
 * 对被墙站点必然失败——用户就会看到"抓不到"。这里把"选错工具"这一情形也兜回来。
 *
 * 机制（全部取自官方类型定义，不猜）：
 *
 *   'tools/post-execute'(exec, result, next) → PostToolDecision
 *   PostToolDecision = { kind:'accept', content?, value?, additionalContexts?: UserMessage[] }
 *                    | { kind:'block', feedback, additionalContexts? }
 *
 * 官方对该字段的注释正是我们要的："attach context for the next request"。
 * 所以我们**不动**失败结果本身（保留原始报错，便于排查），只追加一条纠正上下文。
 *
 * 三个约束：
 *   1. 必须先 `await next()`（拿到下游决定），再决定是否追加；
 *   2. 下游若已 `block`，我们不插手（尊重更早的策略）；
 *   3. 任何异常都只记录、按原决定返回 —— 兜底逻辑绝不能影响工具调用本身。
 */

/** 注入上下文的来源标识（与官方工具文档示例一致：`{ kind:'plugin', plugin }`）。 */
export const FALLBACK_SOURCE = { kind: 'plugin', plugin: 'dsh-proxy-auto' }

/** 需要兜底的工具名：官方网页抓取工具。 */
export const FALLBACK_TOOL_NAME = 'web_fetch'

/**
 * 从参数里取 URL（`web_fetch` 的参数字段是 `url`）。
 *
 * @param {unknown} args 已校验的参数
 * @returns {string | undefined} URL
 */
export function urlFromArguments(args) {
  if (args !== null && typeof args === 'object' && typeof args.url === 'string') return args.url
  return undefined
}

/**
 * 该不该兜底：只针对 `web_fetch` 的**失败**结果。
 *
 * @param {{ name?: string } | undefined} exec 执行身份
 * @param {{ isError?: boolean } | undefined} result 执行结果
 * @returns {boolean} 是否需要注入纠正上下文
 */
export function shouldInjectFallback(exec, result) {
  return exec?.name === FALLBACK_TOOL_NAME && result?.isError === true
}

/**
 * 构造给下一次请求的纠正上下文。
 *
 * 措辞要点：说明"为什么它必然失败"（设计如此，不是网络问题）、给出明确动作（同一 URL 换工具）、
 * 并且**不要**让模型把失败当作"站点不可达"的结论。
 *
 * @param {string} [url] 失败的 URL
 * @returns {{ content: {type: 'text', text: string}[], source: object }} 可交给 additionalContexts 的消息
 */
export function buildFallbackContext(url) {
  const where = url === undefined ? '' : ` for ${url}`
  return {
    content: [
      {
        type: 'text',
        text:
          `web_fetch failed${where} — note that web_fetch always connects directly and never uses a proxy ` +
          '(that is by design), so blocked sites fail through it no matter the network. ' +
          'Retry the same URL with the `proxy_fetch` tool: it follows the local proxy when one is running, ' +
          'and does not treat a blocked site as unreachable.',
      },
    ],
    source: FALLBACK_SOURCE,
  }
}

/**
 * 注册兜底策略。
 *
 * @param {object} ctx Cordis 上下文
 * @returns {{ state: { installed: boolean, reason?: string | null, injected: number, lastError?: string },
 *             dispose: () => void }} 安装结果与卸载函数
 */
export function installFetchFallback(ctx) {
  const state = { installed: false, reason: null, injected: 0 }

  if (typeof ctx?.on !== 'function') {
    state.reason = 'event-api-unavailable'
    return { state, dispose: () => {} }
  }

  try {
    const dispose = ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next()
      try {
        if (!shouldInjectFallback(exec, result)) return decision
        // 下游已按自己的策略定性（例如 block 成错误反馈）→ 不插手。
        if (decision === null || decision === undefined || decision.kind !== 'accept') return decision
        const context = buildFallbackContext(urlFromArguments(exec.arguments))
        state.injected += 1
        return {
          ...decision,
          additionalContexts: [...(decision.additionalContexts ?? []), context],
        }
      } catch (error) {
        // 兜底失败绝不能影响工具调用本身
        state.lastError = error instanceof Error ? error.message : String(error)
        return decision
      }
    })
    state.installed = true
    return { state, dispose }
  } catch (error) {
    state.reason = `registration-failed: ${error instanceof Error ? error.message : String(error)}`
    return { state, dispose: () => {} }
  }
}
