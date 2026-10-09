/**
 * 把宿主的**声明式 schema DSL** 编译成 **JSON Schema** —— 零依赖。
 *
 * 为什么需要它：
 *   宿主有两套工具契约：
 *     1) `defineTool(options)`：作者写声明式 DSL，函数内部编译成 JSON Schema；
 *     2) `tools.register(definition)`：直接吃 JSON Schema 形态的 `ToolDefinition`。
 *   两者产出**必须一致**——否则"有 defineTool 时能注册、没有时注册出坏 schema"，
 *   而插件不该依赖是否装上了 `@deepseek-ai/dsh-tools`。
 *
 *   所以这里自己实现同一套编译（映射关系见宿主 `schema.d.ts` 的接口定义）：
 *     - 参数：隐式**开放对象根**，每个属性是 `ValueSchemaSpec & { required?: true }`，
 *       `required` 是**逐属性**标注，没有对象级 `required: [...]`；
 *     - 值：`type: 'object'` 时必须显式给 `additionalProperties`，`properties` 是同一套映射。
 *
 * 一致性由测试保证：把本文件编译结果与宿主 `defineTool` 的编译结果做**深比较**。
 */

/** 逐属性标注里只有这些键属于 JSON Schema 形态。 */
const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples']

/**
 * 编译一个 `ValueSchemaSpec`。
 *
 * @param {any} spec 声明式值 schema
 * @returns {any} JSON Schema 节点
 */
export function compileValue(spec) {
  if (spec === null || typeof spec !== 'object') return {}
  if (Array.isArray(spec.oneOf)) {
    return { oneOf: spec.oneOf.map((branch) => compileValue(branch)) }
  }
  const out = {}
  if (typeof spec.type === 'string') out.type = spec.type
  if (Array.isArray(spec.enum)) out.enum = [...spec.enum]
  if ('const' in spec) out.const = spec.const
  for (const key of ANNOTATION_KEYS) {
    if (key in spec) out[key] = spec[key]
  }
  if (spec.type === 'array' && 'items' in spec && spec.items !== undefined) {
    out.items = compileValue(spec.items)
  }
  if (spec.type === 'object') {
    // 宿主强制显式声明开放性，这里原样透传。
    out.additionalProperties = spec.additionalProperties === true
    const inner = compileParameters(spec.properties ?? {})
    // 注意：compileParameters 返回的是"对象根"（含 type/properties/required），
    // 这里要取它的 properties 映射，而不是把整个根塞进来（曾经的错法）。
    out.properties = inner.properties
    if (inner.required !== undefined) out.required = inner.required
  }
  return out
}

/**
 * 编译参数映射（`ParameterSchemaSpec`）——包成对象根。
 *
 * @param {Record<string, any>} map 参数属性映射
 * @returns {{ type: 'object', properties: Record<string, any>, required?: string[] }} JSON Schema
 */
export function compileParameters(map) {
  const properties = {}
  const required = []
  for (const [key, value] of Object.entries(map ?? {})) {
    properties[key] = compileValue(value)
    if (value?.required === true) required.push(key)
  }
  const out = { type: 'object', properties }
  if (required.length > 0) out.required = required
  return out
}
