/**
 * 插件 Config schema + `proxy_fetch` 工具契约 —— 全部**零外部依赖**。
 *
 * 两个目标：
 *   1. **自包含**：插件拷到任何目录/机器都能用，不需要 junction、不需要 profile 里有它的依赖。
 *   2. **契约正确**：设置 schema 必须是**真的** Standard Schema（Cordis/DSH 会用它校验并按默认值投影）。
 *      假壳的典型后果是"设置界面静默不可用"，所以这里用宿主真实的 schemastery，
 *      只是通过 `schema-loader.js` 按绝对路径找到它。
 *
 * 工具契约同样不依赖 `@deepseek-ai/dsh-tools`：直接给 `ToolDefinition` 对象
 * （宿主 `tools.register(definition)` 接受它；`defineTool` 只是"把声明式 schema 编译成 JSON Schema"的便利层）。
 */

import { tryLoadSchemasterySync } from './schema-loader.js'

/**
 * 默认值表的**唯一真相源**：schema 的 `.default()` 与降级壳（`config.js`）共用同一份字面量。
 *
 * 为什么要抽出来：降级壳必须给出与 schema 一致的默认值，否则宿主会投影出 `undefined`，
 * `apply` 首行即抛（曾导致整个条目 not activate）。两处各写一份必然漂移，所以集中在这里。
 */
export const DEFAULT_CONFIG = Object.freeze({
  watchIntervalMs: 3000,
  probeTimeoutMs: 400,
  stateTtlMs: 5000,
  debug: false,
  probeUrl: 'https://en.wikipedia.org/wiki/Naruto',
  probeRequestTimeoutMs: 4000,
  persistToEnv: true,
  envFile: '',
  tool: true,
  noProxy: 'localhost,127.0.0.1,::1,api.deepseek.com',
  promptHint: true,
  promptHintText: '',
  fetchFallback: true,
  stateFile: '',
})

/**
 * 构建插件 Config schema（**同步**）。
 *
 * 为什么必须同步：插件协议要求同步导出 `Config`，模块顶层不能 await。
 * schemastery 有 CJS 构建，`createRequire` 能同步装载它；解析失败时返回 undefined，
 * 由调用方降级（插件其余功能——尤其是能翻墙的抓取工具——仍然可用，只是设置项不出现）。
 *
 * @returns {{ schema: any, schemaModulePath: string } | undefined}
 */
export function buildConfigSchema() {
  const loaded = tryLoadSchemasterySync()
  if (loaded === undefined) return undefined
  const { Schema, modulePath } = loaded

  const schema = Schema.object({
    /** 看门狗周期（毫秒）：多久复查一次"代理是否还在"。 */
    watchIntervalMs: Schema.number().min(500).max(60000).default(DEFAULT_CONFIG.watchIntervalMs),

    /** 单次 TCP 探活的超时（毫秒）。本机端口被拒是瞬时的，取小值即可。 */
    probeTimeoutMs: Schema.number().min(50).max(5000).default(DEFAULT_CONFIG.probeTimeoutMs),

    /** 判定结果缓存时长（毫秒）。到期后下一次心跳重新探活。 */
    stateTtlMs: Schema.number().min(500).max(60000).default(DEFAULT_CONFIG.stateTtlMs),

    /** 诊断日志：每次判定都记录"结果 + 依据"。 */
    debug: Schema.boolean().default(DEFAULT_CONFIG.debug),

    /**
     * 自证探针地址（留空 = 不探）。
     * 每次判定都在宿主进程内用真实网络打一次，结果写进诊断快照的 `probe` 字段——
     * 这是把"我判定要走代理"与"宿主里真能出去"分开的唯一实证手段。
     */
    probeUrl: Schema.string().default(DEFAULT_CONFIG.probeUrl),

    /** 自证探针的单次超时（毫秒）。失败只写快照，不影响任何业务请求。 */
    probeRequestTimeoutMs: Schema.number().min(500).max(30000).default(DEFAULT_CONFIG.probeRequestTimeoutMs),

    /** 是否把判定结果同步进官方 `.env`（供子进程 curl/git 使用）。 */
    persistToEnv: Schema.boolean().default(DEFAULT_CONFIG.persistToEnv),

    /** 官方 `.env` 路径（留空 = `$DSH_HOME/.env`）。 */
    envFile: Schema.string().default(DEFAULT_CONFIG.envFile),

    /** 是否注册 `proxy_fetch` 工具。 */
    tool: Schema.boolean().default(DEFAULT_CONFIG.tool),

    /**
     * NO_PROXY：始终直连的名单。
     * 回环必须排除；`api.deepseek.com` 也排除，于是**代理挂掉时对话仍然可用**。
     */
    noProxy: Schema.string().default(DEFAULT_CONFIG.noProxy),

    /**
     * 是否注入"系统提示词引导段"：告诉模型抓被墙页面该用 `proxy_fetch`。
     *
     * 为什么默认开：工具注册 ≠ 模型会调用。官方 `web_fetch` 与 `proxy_fetch` 同时在工具清单里，
     * 模型更可能选名字更直白的 `web_fetch`——它按官方设计永远直连，对被墙站点必然失败，
     * 于是用户会觉得"装了插件没效果"。注入一段引导可显著提高自调用率。
     */
    promptHint: Schema.boolean().default(DEFAULT_CONFIG.promptHint),

    /** 自定义引导文案（留空 = 内置默认文案）。 */
    promptHintText: Schema.string().default(DEFAULT_CONFIG.promptHintText),

    /**
     * 是否启用"失败兜底"（B 方案）：当官方 `web_fetch` 失败时，自动给下一次模型请求附上
     * "改用 `proxy_fetch` 重试同一个 URL"的纠正上下文。
     *
     * 与 `promptHint` 的分工：引导段让模型**大概率**选对工具；兜底保证即使选错也能被纠正。
     * 不动原始失败结果（保留报错便于排查），只追加一条上下文。
     */
    fetchFallback: Schema.boolean().default(DEFAULT_CONFIG.fetchFallback),

    /**
     * 诊断快照文件路径。
     * 留空 = `$DSH_HOME/cache/dsh-proxy-auto/state.json`
     * （派生数据放 cache：它每 3 秒重写、丢了会自动重建）。
     */
    stateFile: Schema.string().default(DEFAULT_CONFIG.stateFile),
  })

  return { schema, schemaModulePath: modulePath }
}

/**
 * `proxy_fetch` 的参数 schema。
 *
 * 形态由宿主 DSL 决定（**不是** JSON Schema）：`ParameterSchemaSpec` 本身就是"隐式开放对象根"，
 * 每个属性是 `ValueSchemaSpec & { required?: true }` —— 也就是说 **required 写在每个属性上**，
 * 没有对象级 `required: [...]`（官方 `dsh-tool-web` 的写法亦然）。
 */
export const PROXY_FETCH_PARAMETERS = {
  url: { type: 'string', required: true, description: 'Absolute http(s) URL to fetch.' },
  max_chars: { type: 'number', description: 'Max characters to return (default 12000).' },
}

/** `proxy_fetch` 的输出 schema（canonical value 的 ValueSchemaSpec）。 */
export const PROXY_FETCH_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    url: { type: 'string', required: true },
    status: { type: 'integer', required: true },
    content: { type: 'string', required: true },
    truncated: { type: 'boolean', required: true },
    via: { type: 'string' },
    contentType: { type: 'string' },
  },
}
