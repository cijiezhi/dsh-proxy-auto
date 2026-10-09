# dsh-proxy-auto

[![tests](https://github.com/cijiezhi/dsh-proxy-auto/actions/workflows/ci.yml/badge.svg)](https://github.com/cijiezhi/dsh-proxy-auto/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.19-339933.svg)](package.json)

**让 DeepSeek Harness 自动跟随本机代理，并提供一个能翻墙抓页面的工具。**

代理软件开着就走代理，关掉就直连——**开/关代理都不需要重启**，也不会把代理地址写死
（写死 = 代理一关就断网，这是踩过的坑）。

> **English** — A DSH plugin that makes the host follow your local proxy **at runtime** (no restart when you
> toggle the proxy), plus a `proxy_fetch` tool that **can read blocked pages**.
> Zero static `@deepseek-ai/*` dependencies, so it survives machine moves and upgrades with one idempotent
> script — see **[INSTALL.md](INSTALL.md)**.

---

## 安装

```powershell
cd <插件目录>
pwsh -File .\install.ps1     # 幂等；-Profile web 换 profile，-Check 只预检，-Uninstall 卸载
```

然后重启 DSH 一次（宿主半边只在启动时加载）。细节与排查见 **[INSTALL.md](INSTALL.md)**。

## 它做什么

| 能力 | 说明 |
|---|---|
| **代理跟随** | 每 3 秒检测本机代理（注册表 / 环境变量 + **TCP 探活**），有就切到代理、没有就回落直连 |
| **开关免重启** | 全局 `fetch` 按需换 dispatcher：有代理 → `EnvHttpProxyAgent`，无代理 → 裸 `Agent` |
| **`proxy_fetch` 工具** | 抓网页正文。官方 `web_fetch` **永远直连**（固定 IP 防 SSRF，属官方设计），所以墙外页面要靠它 |
| **子进程同步** | 维护官方 `.env`，让 `curl` / `git` / `npm` 等子进程也用上代理；探测不到代理时留空 |
| **诊断快照** | `~/.dsh/dsh-proxy-auto.state.json` 每 3 秒自更新，外部可直接看"此刻走没走代理" |

## 两个关键设计

- **绝不用没人监听的代理**：候选地址必须通过 TCP 探活才被采用；代理消失 3 秒内卸掉并直连。
- **不写 `NODE_USE_ENV_PROXY`、不靠环境变量切换**：实测该开关会让 Node 无视调用方指定的 dispatcher，
  代理一关整进程请求都会撞死端口。抓取一律**显式带 dispatcher**，因此不依赖启动时的环境。

## 用法

装了插件后，直接让 agent 抓墙外页面即可（代理开着时）：

```
proxy_fetch https://en.wikipedia.org/wiki/Naruto
→ Status: 200 (truncated)
→ Via: http://127.0.0.1:7890
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

## 验证

```sh
node test/standalone.mjs   # 9 项：零 junction 解析宿主依赖 / schema / 工具契约
node test/selftest.mjs     # 17 项：探测底线 / 官方 seam 装卸 / .env 维护 / dispatcher 切换
```

没装 DSH 的机器上，宿主相关用例会自动 SKIP（CI 即此情形，仍能跑完并给出结论）。

## 已知边界

- `web_fetch` 不走代理是官方设计，本插件不改它；请用 `proxy_fetch`。
- 不支持 SOCKS、不解析 PAC（遇到即直连）；非 Windows 只认环境变量。
- 代理开关变化对 `.env`（子进程）需**下次启动**生效；对进程内请求**立即**生效。
