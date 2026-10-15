# dsh-proxy-auto

[![tests](https://github.com/cijiezhi/dsh-proxy-auto/actions/workflows/ci.yml/badge.svg)](https://github.com/cijiezhi/dsh-proxy-auto/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.19-339933.svg)](package.json)

**让 DeepSeek Harness 自动跟随本机代理，并提供一个能抓取墙外页面的工具。**

代理软件开着就走代理，关掉就直连——**开/关代理都不需要重启**，也不会把代理地址写死
（写死 = 代理一关就断网，这是踩过的坑）。

[English](README.en.md) · [安装/排障手册](INSTALL.md) · [更新日志](CHANGELOG.md)

---

## 安装

**方式一：从仓库直接安装**（CLI 管理的 profile，如 `tui` / `web`）

```sh
dsh plugin --profile <profile> add github:cijiezhi/dsh-proxy-auto
```

本插件**没有任何构建步骤**（无 `prepare`/`postinstall`），因此不会被 pnpm 的 `allowBuilds` 拦住。

**方式二：本地安装脚本**（`desktop` profile 只能用这种，CLI 不允许操作 desktop）

```powershell
cd <插件目录>
pwsh -File .\install.ps1        # 幂等；-Profile web 换 profile，-Check 只预检，-Uninstall 卸载
```

**方式三：下载 Release 里的 zip**，解压后执行上面的 `install.ps1`。

装完**重启 DSH 一次**（宿主半边只在启动时加载）。验证：

```powershell
pwsh -File .\verify.ps1         # 体检：宿主依赖 / 自测 / 运行快照 / 仓库完整性，输出已脱敏可直接贴出
```

## 为什么需要它

DSH 的出站代理策略**只在启动时读一次**环境变量。于是有两个日常麻烦：

1. 代理开关一变（或换了端口）就得重启，否则老地址一直用着；
2. 把代理写进环境变量之后，**代理软件一关，DSH 就整片卡死**（一直去连那个已经不存在的端口）。

还有一个能力缺口：官方 `web_fetch` 工具用固定 IP 的 undici Agent（防 SSRF / DNS rebinding），
**刻意绕过全局 dispatcher**，所以它永远直连——墙外页面必然抓不到。这是官方设计，插件改不了。

本插件补的是这三件事：**跟随本机代理、关掉就回落直连、另给一个能翻墙的抓取工具**。

## 它做什么

| 能力 | 说明 |
|---|---|
| **跟随代理** | 每 3 秒检测本机代理（环境变量 / Windows 系统代理注册表 + **TCP 探活**） |
| **开关免重启** | 全局 `fetch` 按需换 dispatcher：有代理 → `EnvHttpProxyAgent`，无代理 → 裸 `Agent` |
| **`proxy_fetch` 工具** | 抓网页正文，走**显式 dispatcher**，因此代理开着时能读墙外站点 |
| **子进程同步** | 维护官方 `.env`，让 `curl` / `git` / `npm` 等子进程也用上代理 |
| **诊断快照** | `$DSH_HOME/cache/dsh-proxy-auto/state.json` 每 3 秒自更新，外部可直接看"此刻走没走代理" |

## 模型会自动用它吗？

这是最容易踩的一点：**工具注册 ≠ 模型会调用**。官方 `web_fetch` 与 `proxy_fetch` 同时在工具清单里，
而"抓网页"这个意图上模型更可能选名字更直白的 `web_fetch`（它按设计永远直连，对被墙站点必然失败），
于是用户会以为"装了插件没效果"。本插件用两件事解决自调用：

1. **注入系统提示词引导段**（段位 2150，紧跟官方 `web_fetch` 说明之后）：写明官方 `web_fetch`
   永远直连、这类页面应改用 `proxy_fetch`，并明确**不要在试过之前就告诉用户站点不可达**。
   可用 `promptHint: false` 关掉，或用 `promptHintText` 换成自己的话。
2. **强化工具自身的描述**（模型可见的唯一元数据）：目标可能被墙时优先用它；`web_fetch`
   失败或超时后，用同一 URL 重试。

怎么确认它真的注入了：看快照里的 `promptHint` 字段。

```jsonc
"promptHint": { "registered": true, "name": "dsh-proxy-auto:web-fetch-hint", "order": 2150, "chars": 429 }
```

`registered: false` 会带 `reason`（例如服务不可用）；此时工具仍可用，只是需要模型自行选择它。

**失败兜底（B 方案）**：即使模型还是先调了官方 `web_fetch`（对被墙站点必然失败），插件会在
`tools/post-execute` 事件上给这次调用**追加一条纠正上下文**——"`web_fetch` 按设计永远直连，
同一 URL 改用 `proxy_fetch` 重试"。原始报错保持不变；官方 `accept` 与 `block` 两种决定都会追加
（`block` 的 `feedback` 原样保留）；可用 `fetchFallback: false` 关掉。

怎么确认它真的触发了：看快照里的 `fetchFallback`，它同时回答"装没装上"和"为什么一次都没注入"。

```jsonc
"fetchFallback": { "installed": true, "injected": 1, "calls": 4, "matched": 1, "skippedKind": 0,
                   "tools": ["pwsh", "web_fetch"], "errorTools": ["web_fetch"],
                   "kinds": { "accept": 4 }, "lastDecisionKind": "accept", "lastError": null }
```

`injected` 是累计纠正次数；`calls` / `matched` / `skippedKind` / `kinds` 用来定位"一次都没注入"：
`calls: 0` = 钩子没接上；`matched: 0` = 工具名或失败标志不符（看 `errorTools`）；
`skippedKind > 0` = 下游决定类型不符（看 `kinds`）。

**A 与 B 的分工**：A（引导段）让模型**大概率**一开始就选对工具；B（兜底）保证即使选错也能被拉回来。

## 它不做什么

- **不改 `web_fetch`**：那是官方设计；要读墙外页面请用 `proxy_fetch`。
- **不支持 SOCKS、不解析 PAC**：遇到就直连（官方 seam 只接受 http(s) 代理）。
- **非 Windows 只认环境变量**：没有系统代理注册表可读。
- 不做界面、不接管你的代理软件设置。

## 失败时的行为

所有环节都包了兜底，原则是**绝不让原本可用的直连变差**：

- 候选代理必须先通过 **TCP 探活**才会被采用；探不到就当作没有代理；
- 代理消失后 **3 秒内**卸掉策略并回落直连，不留悬空地址；
- 适配/解析失败（找不到宿主依赖、`.env` 写不进去等）只记日志，插件其余功能照常；
- 不写 `NODE_USE_ENV_PROXY`——实测该开关会让 Node 无视调用方指定的 dispatcher。

## 用法

装了插件后，直接让 agent 抓墙外页面（代理开着时）：

```text
proxy_fetch https://en.wikipedia.org/wiki/Naruto

URL: https://en.wikipedia.org/wiki/Naruto
Status: 200 (truncated)
Via: http://127.0.0.1:<你的代理端口>
```

状态快照示例（代理关 / 开）：

```jsonc
// 代理关着 → 直连
{ "proxy": null, "source": "windows-registry-disabled", "dispatcherPatched": false }

// 代理开着 → 经代理
{ "proxy": "http://127.0.0.1:<port>", "source": "windows-registry", "dispatcherPatched": true,
  "probe": { "ok": true, "status": 200, "ms": 691 } }
```

## 配置（全部可选）

| 字段 | 默认 | 说明 |
|---|---|---|
| `watchIntervalMs` | 3000 | 检测周期 |
| `probeTimeoutMs` | 400 | TCP 探活超时 |
| `probeUrl` | wikipedia 条目 | 自证探针（留空=不探），结果写进快照 `probe` |
| `persistToEnv` / `envFile` | true / `$DSH_HOME/.env` | 子进程环境维护 |
| `tool` | true | 是否注册 `proxy_fetch` |
| `promptHint` | true | 是否注入**系统提示词引导段**（让模型主动用 `proxy_fetch`，见下节） |
| `promptHintText` | 空 | 自定义引导文案（留空 = 内置默认） |
| `fetchFallback` | true | **失败兜底**：官方 `web_fetch` 失败时自动提示模型改用 `proxy_fetch` 重试 |
| `noProxy` | `localhost,127.0.0.1,::1,api.deepseek.com` | 直连名单（模型 API 直连 ⇒ 代理挂了对话仍可用） |
| `debug` | false | 每次判定打日志 |

## 开发与验证

```sh
node test/standalone.mjs   # 9 项：零 junction 解析宿主依赖 / schema / 工具契约
node test/selftest.mjs     # 37 项：探测底线 / 官方 seam 装卸 / .env 维护 / dispatcher 切换 / 提示词引导段 / 失败兜底
```

没装 DSH 的机器上，宿主相关用例会自动 SKIP（CI 即此情形），因此任何人 clone 下来都能跑通。

## 许可

[MIT](LICENSE)
