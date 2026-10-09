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

```powershell
cd <插件目录>
pwsh -File .\install.ps1        # 幂等；-Profile web 换 profile，-Check 只预检，-Uninstall 卸载
```

然后重启 DSH 一次（宿主半边只在启动时加载）。验证：

```powershell
pwsh -File .\verify.ps1         # 一条命令做体检，输出可直接贴出来排查
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
| **诊断快照** | `~/.dsh/dsh-proxy-auto.state.json` 每 3 秒自更新，外部可直接看"此刻走没走代理" |

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
| `noProxy` | `localhost,127.0.0.1,::1,api.deepseek.com` | 直连名单（模型 API 直连 ⇒ 代理挂了对话仍可用） |
| `debug` | false | 每次判定打日志 |

## 开发与验证

```sh
node test/standalone.mjs   # 9 项：零 junction 解析宿主依赖 / schema / 工具契约
node test/selftest.mjs     # 17 项：探测底线 / 官方 seam 装卸 / .env 维护 / dispatcher 切换
```

没装 DSH 的机器上，宿主相关用例会自动 SKIP（CI 即此情形），因此任何人 clone 下来都能跑通。

## 许可

[MIT](LICENSE)
