/**
 * DSH 数据根目录（home）与派生路径的**唯一**解析处。
 *
 * 为什么单独一个模块：踩过的坑是"两处各自拼路径，其中一处漏了 `$DSH_HOME`"，
 * 于是同一条事实有两个实现并发生漂移（快照被写到错的地方）。
 * 官方架构笔记 `single-harness-home-resolver` 正是为消灭这类重复而在 harness 内部做了合并；
 * 插件侧同理——只留这一个解析器，谁都别自己拼。
 *
 * 优先级（与官方 `@deepseek-ai/dsh-home-paths` 一致）：
 *
 *   显式配置  >  `$DSH_HOME`  >  `~/.dsh`
 *
 * 空白值一律视为"未设置"：否则 `join('')` 会把 home 悄悄落到当前工作目录，
 * 这正是"插件数据跑到工作区"那类事故的成因。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 解析 DSH 数据根目录。
 *
 * @param {string} [configured] 显式配置的 home（最高优先级；空白忽略）
 * @returns {string} 绝对路径
 */
export function resolveDshHome(configured) {
  const explicit = typeof configured === 'string' ? configured.trim() : ''
  if (explicit.length > 0) return explicit
  const fromEnv = process.env.DSH_HOME?.trim()
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  return join(homedir(), '.dsh')
}

/**
 * `$DSH_HOME/<segments...>`：home 根下的路径（如官方 `.env`）。
 *
 * @param {...string} segments 子路径段
 * @returns {string} 绝对路径
 */
export function dshHomePath(...segments) {
  return join(resolveDshHome(), ...segments)
}

/**
 * `$DSH_HOME/cache/<segments...>`：**可重新生成的派生数据**（快照、缓存）。
 *
 * 判据是"丢了能不能自动重建"，而不是"重不重要"：
 * 能重建的放 cache（清缓存不该丢持久数据），权威持久数据请走 `ctx.storageDomain`。
 *
 * @param {...string} segments 子路径段
 * @returns {string} 绝对路径
 */
export function dshCachePath(...segments) {
  return join(resolveDshHome(), 'cache', ...segments)
}
