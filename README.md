# dsh-proxy-auto · 让 DSH 自动跟随本机代理，并给我一个能翻墙的抓取工具

**一句话**：代理软件开着，DSH 的一切出网就走代理；关掉就立刻直连。**开关代理都不需要重启**，
也不往任何地方写死代理地址（写死 = 代理一关就断网，这是踩过的坑）。

外加一个官方给不了的能力：**`proxy_fetch` 工具**——能抓被墙页面（官方 `web_fetch` 做不到，见下）。

> 安装 / 重装 / 升级后修复：见 **[INSTALL.md](INSTALL.md)**（含一键脚本 `install.ps1`）。
> 本插件**不静态依赖任何 `@deepseek-ai/*` 包**：`schemastery` 与 `undici` 都在运行时按宿主安装路径解析，
> 所以换电脑、换目录、DSH 升级后重装都**不需要 pnpm install、不需要建 junction**。

---

## 它做什么（三条腿，各管一段）

| 腿 | 文件 | 作用 |
|---|---|---|
| **全局 dispatcher** | [global-dispatcher.js](lib/global-dispatcher.js) | 换掉 `globalThis.fetch`，每次请求**显式带 dispatcher**：有代理→`EnvHttpProxyAgent`，无代理→裸 `Agent`（不读 env，不会撞死端口） |
| **官方代理策略** | [proxy-seam.js](lib/proxy-seam.js) | 运行时装卸 `@deepseek-ai/dsh-http-proxy` 的策略，让官方自己的判定与当前现实一致 |
| **子进程 + 启动一致性** | [env-persist.js](lib/env-persist.js) | 维护官方 `.env` 托管区块（供 curl/git/npm 等子进程）；探测不到代理就留空 |

加两个交付物：

- **`proxy_fetch` 工具**（[fetch-tool.js](lib/fetch-tool.js)）—— 能翻墙抓正文；
- **诊断快照** `~/.dsh/dsh-proxy-auto.state.json` —— 每 3 秒自更新，外部可直接判断"此刻走没走代理"。

## 为什么需要 `proxy_fetch`（官方 `web_fetch` 为什么改不了）

官方文档《[在网络代理后面运行 DSH](https://deepseek-harness.github.io/deepseek-harness/guide/network-proxy)》说明：
DSH 出站请求经标准代理环境变量，**启动时读取一次**。而 `web_fetch` 用自己的、**固定 IP 的** undici Agent
（防 SSRF / DNS rebinding），**刻意绕过全局 dispatcher** —— 所以它永远直连，墙外站点必然失败。
**这是设计，不是缺陷，任何插件都改不了。**

`proxy_fetch` 走的不是那条路，而是**显式 dispatcher**：

```
proxy_fetch <url>
  ├─ 探测到可用代理 → ProxyAgent（经代理出去）
  └─ 没有代理       → 裸 Agent（直连；不会把请求送进已消失的端口）
```

## 与同类插件的差别（发布前特意核对过）

这个方向已有人在做（`dsh-plugin-proxy-env`、`dsh-local-proxy`、`dsh-plugin-proxy`、`dsh-proxy-pro` 等）。
对照他们的 README，本插件的差异点是**三件被实测证实的事**：

| 差异 | 别人的常见做法 | 本插件 |
|---|---|---|
| **`web_fetch` 到底能不能改** | 多份 README 声称"网页抓取也走代理"（靠换全局 dispatcher，或写 env） | **改不了**：官方 `web-fetch-http` 用固定 IP 的 Agent 防 SSRF/DNS rebinding，**刻意绕过**全局 dispatcher。所以这里**另外提供 `proxy_fetch` 工具**，而不是宣称已覆盖 |
| **代理被关掉时会不会断网** | 写 `NODE_USE_ENV_PROXY=1` / 固定 env → 代理一关，Node 会**无视调用方 dispatcher**，全进程请求撞死端口 | **不写这个开关**；抓取一律**显式带 dispatcher**（有代理→ProxyAgent，无代理→裸 Agent）；候选地址必须 **TCP 探活**才被采用 |
| **装到别人机器上能不能跑** | 依赖 `pnpm add` / 需要建 junction 才能解析 `@deepseek-ai/*` | **零静态依赖**：`schemastery`、`undici` 运行时按宿主安装路径解析；一键脚本幂等安装（换机只拷目录 + 跑一次脚本） |

另外两点工程细节：诊断快照（外部可直接判断"此刻走没走代理"，含**宿主进程内自证探针**）；
以及工具 schema 由插件自行编译，且与官方 `defineTool` 的编译结果**深比较一致**。

> 参考：官方说明《在网络代理后面运行 DSH》；
> `dsh-plugin-proxy-env` 的 README 也确认了 `web_fetch` 的这一限制（其建议是改用 shell 里的 node/python 抓）。

## 三条工程约束（都来自真实事故）

| 约束 | 为什么 |
|---|---|
| **绝不使用没人监听的代理** | 曾经把地址写死成环境变量，代理软件一关就成了黑洞 → 整机断网。现在候选地址必须通过 TCP 探活才被采用。 |
| **代理消失立刻回落直连** | 官方静态 env 方案的问题：值还在、代理没了 → 请求全失败。本插件 3 秒内卸掉并直连。 |
| **不写 `NODE_USE_ENV_PROXY`、不靠 env 切换** | 实测：该开关会让 Node **无视调用方指定的 dispatcher**，代理一关整进程 fetch 全废（连 `example.com` 都 ECONNREFUSED）。 |

## 实测证据（本机）

| 场景 | 结果 |
|---|---|
| 代理关 → 可达站点 | `proxy_fetch example.com` → `200 / Via: direct` |
| 代理关 → 墙外站点 | 失败（本该如此） |
| **代理开（未重启）** | 快照自动翻为 `dispatcherPatched: true`、`probe: ok/200/691ms`；`proxy_fetch wikipedia` → `200 / Via: http://127.0.0.1:7890` |
| `.env` 维护 | 四键写入 / 幂等 / 代理消失后清空（不留死地址） |
| 契约一致性 | 插件自编译的工具 schema 与宿主 `defineTool` 编译结果**深比较一致** |

## 配置（全部可选，默认即可工作）

| 字段 | 默认 | 说明 |
|---|---|---|
| `watchIntervalMs` | 3000 | 复查周期 |
| `probeTimeoutMs` | 400 | TCP 探活超时 |
| `stateTtlMs` | 5000 | 判定缓存时长 |
| `probeUrl` | wikipedia 火影条目 | 自证探针（留空=不探）；结果写进快照 `probe` |
| `persistToEnv` / `envFile` | true / `$DSH_HOME/.env` | 子进程环境维护 |
| `tool` | true | 是否注册 `proxy_fetch` |
| `noProxy` | `localhost,127.0.0.1,::1,api.deepseek.com` | 直连名单（模型 API 直连 ⇒ 代理挂了对话仍可用） |
| `debug` | false | 每次判定打日志 |

## 验证

```sh
node test/standalone.mjs   # 9 项：零 junction 解析宿主依赖 / schema 默认值 / 工具契约（与官方深比较）
node test/selftest.mjs     # 17 项：探测底线 / 官方 seam 装卸 / .env 维护 / dispatcher 切换
```

## 已知边界

1. **不改 `web_fetch`**（官方设计，见上）；要读墙外页面请用 `proxy_fetch`。
2. **不解析 PAC**、**不支持 SOCKS**（官方 seam 只吃 http(s)）——遇到即直连。
3. **非 Windows 只认环境变量**（没有注册表可读）。
4. 代理开关状态的变化对 `.env`（子进程）要**下次启动**才生效；对进程内请求是**立即**生效。
