/**
 * 插件 `Config` 导出。
 *
 * 插件协议要求**同步导出** Config，所以这里在模块加载时就把 schema 建好：
 *   - 正常：用宿主真实的 schemastery（`schema-loader.js` 按绝对路径同步装载，无需 junction）；
 *   - 极端情况（DSH 安装不完整 / 解析不到 schemastery）：导出空 schema 占位，
 *     让插件**其余功能仍然可用**（尤其是能翻墙的抓取工具），只是设置项不出现。
 *     这是降级而不是崩溃——宿主缺依赖不该让整个条目 activate 失败。
 */

import { buildConfigSchema } from './config-schema.js'

const built = buildConfigSchema()

if (built === undefined) {
  console.warn(
    '[dsh-proxy-auto] 未能解析到 @deepseek-ai/schemastery：设置项不可用，其余功能（含 proxy_fetch）照常。'
  )
}

/** 空 schema 占位：同时满足"可调用"与"Standard Schema"两个最小契约。 */
const emptySchema = Object.assign(() => ({}), {
  '~standard': { version: 1, vendor: 'dsh-proxy-auto', validate: (value) => ({ value }) },
})

export default built?.schema ?? emptySchema

/** 诊断用：本次解析到的 schemastery 入口（无则 null）。 */
export const schemaModulePath = built?.schemaModulePath ?? null
