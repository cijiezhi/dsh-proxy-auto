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
 *   2. `accept` 与 `block` 都追加，其余类型原样放过（官方两种决定都声明了 additionalContexts）；
 *   3. 任何异常都只记录、按原决定返回 —— 兜底逻辑绝不能影响工具调用本身。
 */

import { randomUUID } from 'node:crypto'

/**
 * 注入上下文的来源标识。
 *
 * 注意：v4 会话格式要求 `source.kind` 是**生产者自有**标识，并硬拒绝已退役的
 * `{ kind: "plugin", plugin }` 包装 —— 宿主 `message-sources.js` 见到 `kind === "plugin"`
 * 会抛 `format v4 message requires a producer-owned source kind`，整个回合随之报废
 * （2026-10-15 真实事故：本插件的兜底注入在 web_fetch 失败时把第 82 轮打死）。
 * 取值依据宿主的 V3→V4 迁移层：第一方插件用裸名（`hooks-claude-code`、`tool-jobs` …），
 * 不在白名单里的第三方插件一律映射为 `plugin:<插件名>`（`producerKind()` 的兜底分支）。
 * 本插件属后者，故取 `plugin:dsh-proxy-auto`。
 */
export const FALLBACK_SOURCE = { kind: 'plugin:dsh-proxy-auto' }

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
 * @returns {{ id: string, role: 'user', content: {type: 'text', text: string}[], source: object }} 可交给 additionalContexts 的**完整**消息
 */
export function buildFallbackContext(url) {
  const where = url === undefined ? '' : ` for ${url}`
  return {
    // 宿主把 additionalContexts 里的对象**当成完整 UserMessage 直接采纳**
    //（user/message 事件要求 id / role / source / content 四者齐全）：
    //   缺 id   → 会话加载时报 "lacks an identified message"（会话被判 corrupt）
    //   缺 role → 送模型报 422 "missing field `role`"，此后每一轮请求都失败
    // 2026-10-15 真实事故：source 修好放行后，这条残缺消息进了会话，把会话写坏。
    id: randomUUID(),
    role: 'user',
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

/** 去重登记名字，最多留这么多个（诊断用，防止无限增长）。 */
const MAX_OBSERVED_NAMES = 15

/**
 * 登记一个名字（工具名）到诊断列表。
 *
 * @param {string[]} list 目标列表
 * @param {unknown} name 候补名字
 */
function observeName(list, name) {
  if (typeof name !== 'string' || name === '') return
  if (list.includes(name) || list.length >= MAX_OBSERVED_NAMES) return
  list.push(name)
}

/**
 * 记录每次钩子调用的**事实**，供快照对外自证"为什么没注入"。
 *
 * 这些字段是诊断设计的核心：装上钩子却没生效时，必须能一眼看出卡在哪一步——
 * 是 `web_fetch` 根本没进钩子（`errorTools` 里没有它），
 * 还是进了钩子但工具名对不上（`errorTools` 里有别的名字），
 * 还是下游决定不是预期类型（`kinds`/`lastDecisionKind`）。
 *
 * @param {object} state 诊断状态
 * @param {{ name?: string } | undefined} exec 执行身份
 * @param {{ isError?: boolean } | undefined} result 执行结果
 * @param {{ kind?: string } | undefined} decision 下游决定
 */
function observe(state, exec, result, decision) {
  observeName(state.tools, exec?.name)
  if (result?.isError === true) observeName(state.errorTools, exec?.name)
  const kind = decision?.kind
  if (typeof kind === 'string') {
    state.kinds[kind] = (state.kinds[kind] ?? 0) + 1
    state.lastDecisionKind = kind
  }
}

/**
 * 注册兜底策略。
 *
 * @param {object} ctx Cordis 上下文
 * @returns {{ state: { installed: boolean, reason?: string | null, injected: number, calls: number,
 *             matched: number, skippedKind: number, tools: string[], errorTools: string[],
 *             kinds: Record<string, number>, lastDecisionKind?: string | null, lastError?: string | null },
 *             dispose: () => void }} 安装结果与卸载函数
 */
export function installFetchFallback(ctx) {
  const state = {
    installed: false,
    reason: null,
    injected: 0,
    calls: 0,
    matched: 0,
    skippedKind: 0,
    tools: [],
    errorTools: [],
    kinds: {},
    lastDecisionKind: null,
    lastError: null,
  }

  if (typeof ctx?.on !== 'function') {
    state.reason = 'event-api-unavailable'
    return { state, dispose: () => {} }
  }

  try {
    const dispose = ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next()
      try {
        state.calls += 1
        observe(state, exec, result, decision)
        if (!shouldInjectFallback(exec, result)) return decision
        state.matched += 1
        // `accept` 与 `block` 都声明了 additionalContexts（见官方 PostToolDecision），
        // 所以两种决定都能带上纠正上下文：block 时只需原样保留它的 feedback。
        // 早先只认 `accept`，若上游把失败定性成 block，纠正提示就永远发不出去。
        if (decision === null || decision === undefined || (decision.kind !== 'accept' && decision.kind !== 'block')) {
          state.skippedKind += 1
          return decision
        }
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
