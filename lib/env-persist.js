/**
 * 把"当前是否有活代理"持久化进官方 `.env`（`~/.dsh/.env`）。
 *
 * 为什么除了运行时安装策略，还要动 `.env`：
 *   1) 官方文档明确 `.env` 是受支持的代理配置入口（启动时读取），覆盖面最全；
 *   2) 运行时安装策略依赖"插件与 `web-fetch-http` 命中同一个模块实例"，这一点在打包形态下
 *      可能不成立（踩过：插件装了自己的副本、`web_fetch` 看不见）。`.env` 不依赖模块身份。
 *
 * **安全前提（针对"代理一关就断网"）**：本模块只在探测到**确实有人监听的代理**时才写入地址；
 * 探测不到就把这段整体写成"已注释/禁用"状态——于是任何一次启动读到的都是与当时现实相符的配置，
 * 绝不会留下一个指向已消失代理的固定地址。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 本模块托管区块的起始标记（用它定位、替换，不动用户其它内容）。 */
export const ENV_BLOCK_START = '# >>> dsh-proxy-auto >>>'
export const ENV_BLOCK_END = '# <<< dsh-proxy-auto <<<'

const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']

/** `.env` 的默认位置（官方约定：`$DSH_HOME/.env`，默认 `~/.dsh`）。 */
export function defaultEnvFile() {
  const home = process.env.DSH_HOME?.trim()
  return join(home && home.length > 0 ? home : join(homedir(), '.dsh'), '.env')
}

/** 去掉托管区块后剩下的原文（同时也去掉用户可能手写过的同名键，避免重复定义）。 */
function stripManaged(text) {
  const start = text.indexOf(ENV_BLOCK_START)
  const end = text.indexOf(ENV_BLOCK_END)
  let body = text
  if (start !== -1 && end !== -1 && end > start) {
    body = text.slice(0, start) + text.slice(end + ENV_BLOCK_END.length)
  }
  // 只清掉**区块之外**残留的同名键：区块本身已经被整段剔除，
  // 若在此处对全文再做一次正则过滤，会把刚写进去的密钥一起删掉（曾因此只留下 HTTP_PROXY、HTTPS_PROXY 变空）。
  return body
    .split(/\r?\n/)
    .filter((line) => !/^\s*(https?|all)_proxy\s*=/i.test(line))
    .join('\n')
    .trim()
}

/**
 * 生成托管区块内容。
 *
 * @param {string | undefined} envTarget 要写进 `.env` 的代理地址（供**子进程** curl/git 等使用）。
 *   undefined = 当前没有可用代理（此时该段留空 = 直连）。
 * @returns {string} 区块文本（永远以换行结束）
 */
export function buildEnvBlock(envTarget) {
  const lines = [
    ENV_BLOCK_START,
    '# 由 dsh-proxy-auto 自动维护：本段的地址由插件每次探测后重写。',
    '# 作用范围是**子进程**（curl / git / npm / python 等会自己读这些变量）。',
    '# 探测不到可用代理时留空 —— 因此不会出现"启动时读到已消失的代理 → 断网"。',
  ]
  if (envTarget === undefined) {
    lines.push('# 当前没有可用代理：以下变量留空（直连）。')
  } else {
    for (const key of PROXY_KEYS) lines.push(`${key}=${envTarget}`)
  }
  lines.push('# 刻意不写 NODE_USE_ENV_PROXY：它会让 Node **无视调用方指定的 dispatcher**，')
  lines.push('# 于是代理软件一关，整个进程的 fetch 都会被强制送进那个已消失的端口（实测：连 example.com 都 ECONNREFUSED）。')
  lines.push('# 进程内的代理跟随由本插件在运行时用 dispatcher 完成，不需要这个开关。')
  lines.push(ENV_BLOCK_END)
  return `${lines.join('\n')}\n`
}

/**
 * 让 `.env` 与当前探测结果一致。
 *
 * @param {{ proxyUrl: string | undefined, envFile?: string,
 *           readFile?: (path: string) => string, writeFile?: (path: string, text: string) => void }} options
 * @returns {{ changed: boolean, envFile: string }} 是否改动了文件
 */
export function reconcileEnvFile(options) {
  const envFile = options.envFile?.trim() || defaultEnvFile()
  const read = options.readFile ?? ((path) => readFileSync(path, 'utf8'))
  const write = options.writeFile ?? ((path, text) => writeFileSync(path, text, 'utf8'))

  let current = ''
  try {
    current = read(envFile)
  } catch {
    current = ''
  }

  const next = `${stripManaged(current)}${stripManaged(current).length > 0 ? '\n\n' : ''}${buildEnvBlock(options.proxyUrl)}`
  if (current === next) return { changed: false, envFile }
  write(envFile, next)
  return { changed: true, envFile }
}
