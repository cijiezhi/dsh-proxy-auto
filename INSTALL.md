# INSTALL · dsh-proxy-auto 安装 / 重装手册

> 用途：**换电脑、DSH 升级后插件失效、或想从头重来**时，照着这份从零装回去。
> 设计目标就是"能重装"：插件**不静态依赖任何 `@deepseek-ai/*` 包**，
> `schemastery` 与 `undici` 都在运行时按宿主安装路径解析，所以**不需要 pnpm install、不需要建 junction**。

---

## 0. 前置条件

| 项 | 要求 | 怎么确认 |
|---|---|---|
| DSH 已安装 | 任意 profile 能正常启动 | 能打开 GUI / 能跑 `dsh --version` |
| Node | 与 DSH 同版本（≥22.19） | `node --version` |
| 插件源码 | 本目录（`dsh-proxy-auto/`，约 90 KB） | 目录里有 `lib/index.js`、`cordis.patch.yml` |

---

## 1. 一句话安装（推荐）

在插件目录下执行：

```powershell
pwsh -File .\install.ps1                      # 装到 desktop profile（默认）
pwsh -File .\install.ps1 -Profile web         # 装到 web profile
pwsh -File .\install.ps1 -Uninstall           # 反向：从 profile 摘掉
```

脚本是**幂等**的，可以反复跑。它会：

1. 定位 DSH 安装目录（`%APPDATA%\npm\node_modules\@deepseek-ai\dsh`，必要时用 `npm root -g`）；
2. （可选）为 `@deepseek-ai/schemastery` 建 junction —— **新版插件其实不需要**，留着只是兼容旧布局；
3. 把插件写进 profile 的 `package.json`：`dependencies`（`link:<插件绝对路径>`）+ `dsh.profile.bundles`；
4. 先备份 `package.json`，再写入；最后做 5 项静态自检。

**然后重启 DSH**（宿主半边只在启动时加载）。

---

## 2. 手工安装（脚本不可用时）

### 2.1 改 profile 的 `package.json`

路径：`%USERPROFILE%\.dsh\profiles\<profile>\package.json`（`<profile>` 通常是 `desktop`）

```jsonc
{
  "dependencies": {
    // 关键：用 link: 指向插件目录的绝对路径（Windows 用正斜杠）
    "dsh-proxy-auto": "link:E:/DSH_Project/dsh_main/dsh-proxy-auto"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-proxy-auto"          // ← 加这一行
      ]
    }
  }
}
```

### 2.2 确认插件目录**没有**指向宿主的 junction

不需要（也不建议）建。若目录里残留了 `node_modules/@deepseek-ai/...`，删掉也照样能跑——
测试 `node test/standalone.mjs` 就是专门验证"零 junction"的。

### 2.3 重启 DSH

---

## 3. 装完怎么确认（三步，不需要重启第二次）

**① 看状态快照**（插件每 3 秒自更新一次）：

```powershell
Get-Content "$env:USERPROFILE\.dsh\dsh-proxy-auto.state.json" -Raw
```

关注四个字段：

| 字段 | 期望 | 含义 |
|---|---|---|
| `proxy` | 代理开着时是 `http://127.0.0.1:7890`，关着是 `null` | 现场判定结果 |
| `dispatcherPatched` | 与 `proxy` 同步（有代理 true / 无代理 false） | 全局 fetch 是否已按代理路由 |
| `probe` | 代理开着时应为 `{ok:true,status:200,...}` | **宿主进程内真发请求**的实证 |
| `seamLoaded` | `true` | 官方代理 seam 装载成功 |

**② 让 agent 用 `proxy_fetch` 抓一个墙外页面**（代理开着时）：

```
proxy_fetch https://en.wikipedia.org/wiki/Naruto
```

成功时会显示 `Via: http://127.0.0.1:7890`。

**③ 跑自测**（在插件目录）：

```powershell
node test/standalone.mjs   # 9 项：零 junction 解析 / schema 默认值 / 工具契约（与官方编译深比较）
node test/selftest.mjs     # 17 项：探测底线 / 官方 seam 装卸 / .env 维护 / 全局 dispatcher 切换
```

---

## 4. 故障排查表

| 现象 | 原因 | 处理 |
|---|---|---|
| 插件没加载，`state.json` 不更新 | profile 未登记 / 路径写错 / 未重启 | 检查 `bundles` 含 `dsh-proxy-auto`；`dependencies` 的 `link:` 路径存在；重启 |
| `state.json` 有 `envSynced` 但无 `dispatcherPatched` | 是旧版插件（<2.0） | 更新到当前目录的代码并重启 |
| `probe.ok=false` 且 `ms≈超时` | 无代理时属正常（墙外站点） | 打开代理软件，3 秒后快照应自动翻转，**无需重启** |
| `probe.ok=false` + `ECONNREFUSED` | 环境里残留指向已关闭端口的代理变量 | 看 `%USERPROFILE%\.dsh\.env` 的托管区块；删掉 `NODE_USE_ENV_PROXY=1`（本插件已不再写它），重启 |
| 设置界面看不到插件设置项 | 找不到 `@deepseek-ai/schemastery` | 设 `DSH_PROXY_AUTO_SCHEMASTERY=<schemastery 目录或入口>`；插件其余功能仍可用 |
| 工具列表没有 `proxy_fetch` | `config.tool=false` 或注册抛错 | 打开 `debug: true` 看日志；确认 `inject: ['tools']` 未报错 |
| 代理关掉后连可达站点都失败 | 进程被 `NODE_USE_ENV_PROXY` 绑死 | 清掉该变量并重启（本插件用显式 dispatcher 已能绕开，但清掉更干净） |

---

## 5. DSH 升级后要做什么

通常**什么都不用做**。若升级后失效，按顺序：

1. 打开 `state.json` 看是否还在更新 → 不在则是**插件未加载**（profile 的 `bundles` 可能被升级重置）；
2. 重跑 `pwsh -File .\install.ps1`（幂等，会把登记补回去）；
3. 重启 DSH；
4. 若 `probe` 一直失败且代理正常，跑 `node test/standalone.mjs`：它失败就说明**插件解析不到宿主依赖**
   （多半是 DSH 安装位置变了），用环境变量显式指定即可：

   ```powershell
   # 指到 schemastery 的目录或入口文件（lib/index.cjs）
   $env:DSH_PROXY_AUTO_SCHEMASTERY = 'C:\path\to\node_modules\@deepseek-ai\schemastery'
   # 如宿主 undici 位置也变了，可显式指定它的入口
   $env:DSH_PROXY_AUTO_UNDICI = 'C:\path\to\node_modules\undici\index.js'
   ```

   这两个变量设进 DSH 的启动环境（或写进 `%USERPROFILE%\.dsh\.env`）后重启即可。

---

## 6. 配置项（全部可选，默认即可工作）

写在 profile 的 `cordis.patch.yml`：

```yaml
- id: dsh-proxy-auto
  config:
    watchIntervalMs: 3000        # 复查代理是否还在的周期
    probeTimeoutMs: 400          # TCP 探活超时
    stateTtlMs: 5000             # 判定缓存时长
    probeUrl: https://en.wikipedia.org/wiki/Naruto   # 自证探针（留空=不探）
    persistToEnv: true           # 维护官方 .env（供子进程 curl/git）
    tool: true                   # 注册 proxy_fetch
    noProxy: localhost,127.0.0.1,::1,api.deepseek.com
    debug: false                 # 每次判定打日志
```

---

## 7. 卸载

```powershell
pwsh -File .\install.ps1 -Uninstall
```

然后重启 DSH；`proxy_fetch` 工具会消失，代理行为回到 DSH 原生（只认启动时的环境变量）。

---

## 8. 附：安装位置速查（按你自己的环境替换）

| 项 | 默认位置 |
|---|---|
| 插件目录 | 你 clone / 解压出来的目录（`install.ps1` 会自动取它自己所在目录） |
| profile 目录 | `%USERPROFILE%\.dsh\profiles\<profile>`（默认 profile 名 `desktop`） |
| DSH 安装目录 | `%APPDATA%\npm\node_modules\@deepseek-ai\dsh`（脚本也会尝试 `npm root -g`） |
| 状态快照 | `%USERPROFILE%\.dsh\dsh-proxy-auto.state.json` |
| 代理软件 | 任意提供 **HTTP 代理端口**的软件（如 Clash 的 `127.0.0.1:7890`）；系统代理开关写在注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings` |
