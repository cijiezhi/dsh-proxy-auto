/**
 * 插件 `Config` 导出。
 *
 * 插件协议要求**同步导出** Config，所以这里在模块加载时就把 schema 建好：
 *   - 正常：用宿主真实的 schemastery（`schema-loader.js` 按绝对路径同步装载，无需 junction）；
 *   - 极端情况（DSH 安装不完整 / 解析不到 schemastery）：导出**带默认值**的降级 schema，
 *     让插件其余功能仍然可用（尤其是能翻墙的抓取工具），只是设置项不出现。
 *     这是降级而不是崩溃——宿主缺依赖不该让整个条目 activate 失败。
 */

import { buildConfigSchema, DEFAULT_CONFIG } from './config-schema.js'

const built = buildConfigSchema()

if (built === undefined) {
  console.warn(
    '[dsh-proxy-auto] 未能解析到 @deepseek-ai/schemastery：设置项不可用，其余功能（含 proxy_fetch）照常。'
  )
}

/**
 * 降级 schema：同时满足"可调用"与"Standard Schema"两个最小契约。
 *
 * **必须带默认值**：宿主会按 schema 投影出 `config` 再调用 `apply`。早先这里只返回 `{}`，
 * 宿主投影出 `undefined`，`apply` 首行读 `config.probeTimeoutMs` 即抛 TypeError，
 * 整个条目 `did not activate` —— 插件彻底失效（GUI 里显示"异常"）。
 * 契约只要求 `validate` 返回 `{ value }`，所以这里返回完整默认值即可（并保留调用方给的覆盖）。
 */
const fallbackSchema = Object.assign(() => DEFAULT_CONFIG, {
  '~standard': {
    version: 1,
    vendor: 'dsh-proxy-auto',
    validate: (value) => ({ value: { ...DEFAULT_CONFIG, ...(value ?? {}) } }),
  },
})

export default built?.schema ?? fallbackSchema

/** 诊断用：本次解析到的 schemastery 入口（无则 null）。 */
export const schemaModulePath = built?.schemaModulePath ?? null
