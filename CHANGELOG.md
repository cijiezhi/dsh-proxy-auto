# Changelog

本文件记录本插件的对外变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

- 计划：把 `proxy_fetch` 的正文抽取做得更好（当前为轻量 HTML → 文本转换）。

## [2.0.7] — 2026-10-16

### 修复（DSH 桌面应用下插件整条不激活）

- **降级壳必须提供默认值**。`Config` 解析不到 `@deepseek-ai/schemastery` 时会走降级壳，
  而旧降级壳的 `validate` 返回 `{}`、不提供任何默认值，宿主据此投影出 `config = undefined`，
  `apply` 第一行读 `config.probeTimeoutMs` 即抛 `TypeError` → 条目 `did not activate`：
  `proxy_fetch` 未注册、提示词引导段未注入、看门狗没启动（GUI 里显示"1 异常"）。
  现在 `config-schema.js` 导出 `DEFAULT_CONFIG` 作为默认值唯一真相源，降级壳据此补齐；
  `apply(ctx, config = {})` 另加一层兜底。**这是既有缺陷**（自 2.0 首发就在），
  只在"宿主依赖不可见 + schemastery 解析失败"时暴露。

### 修复（宿主依赖解析：DSH 桌面应用把依赖打进 app.asar）

- **新增 `lib/host-module.js`**：以 **`resources/app.asar` 自身为锚点**建
  `createRequire`，用 **CJS `require`** 加载（Electron 的 asar 支持打在 CJS loader 上，
  对 asar 内文件做 ESM 动态 `import()` 长期有问题）。`undici` 与 `dsh-http-proxy`
  两条腿都改走它，于是全局 dispatcher 与官方代理 seam 在桌面形态下恢复工作。
- 背景：DSH 桌面 0.2.0-rc.2 把 `undici` / `schemastery` / `dsh-http-proxy` 全部打包进
  `resources/app.asar`，文件系统不可见；插件又不在宿主 `node_modules` 树内。于是
  `import('undici')` 找不到包、拼绝对路径普通 `fs` 看不见 asar 内容 →
  `dispatcherModule: null`、`proxy_fetch` 报 `reading 'fetchWith'`、seam 报 `reading 'routeFor'`。

### 修复（诊断与容错）

- **装载诊断落盘**：`loadUndici` / `loadProxySeam` 全过程诊断写入快照
  （`dispatcherError` / `seamError` / `initError`），能直接区分"没找到包"与"找到了但契约变了"。
  早先失败时直接 `return undefined`，把诊断一起丢了，快照只剩 `null`，排查时极易被误导。
- `describeRoute` 全面容错：`routeFor` 缺失、返回 `undefined/null`、`proxied` 字段缺失都不抛。
  旧写法读 `route.proxied` 抛错后又被 catch 包装成"函数不存在"，把排查方向带偏过。
- 装载结果 `?? null` 归一：原先 `undefined` 赋给初值 `null` 的变量，`=== null` 判断会漏掉它，
  把"未找到 seam"错报成"已装载"。
- `fetchWith` 回调在 dispatcher 不可用时退回宿主 `fetch`，不再直接抛。

### 修复（体检脚本）

- **`install.ps1` / `verify.ps1` 支持 DSH 桌面形态**。原先只认 npm 全局安装
  （`%APPDATA%\npm\node_modules\@deepseek-ai\dsh`），桌面版上 `verify.ps1` 第一段就
  throw，四段体检全跑不到。新增 `lib/resolve-dsh-install.ps1`：显式环境变量（`DSH_APP_DIR` /
  `DSH_INSTALL_DIR`）/ 桌面形态 / npm 形态 / 可执行文件上行 四类候选。
- **新增 `lib/probe-host-deps.mjs`**：PowerShell 的 `Test-Path` 看不到 asar 内部
  （不是安装损坏），所以改为借**宿主自己的运行时**（`ELECTRON_RUN_AS_NODE=1` + 宿主 exe）
  真实 `require` 一次三个宿主依赖。`verify.ps1` 新增 1.5 节展示实测结果。
- `verify.ps1` 第 2 节不再误报"未在默认位置找到 DSH"，改报已探测到的安装路径。

### 验证

- 本机（DSH 桌面 0.2.0-rc.2 / electron 44.0.0 / node 24）：`selftest` 36 通过 0 失败、
  `standalone` 3 通过 0 失败；快照 `dispatcherPatched:true`、
  `seamRoute: proxied via http://127.0.0.1:7890`；`proxy_fetch` 实测 200 且 `Via` 为代理；
  代理开↔关各在 5 秒内跟随、全程未重启 DSH；`verify.ps1` 首次完整跑完并输出"体检通过"。

## [2.0.6] — 2026-10-15

### 变更

- **`block` 决定现在也会追加纠正上下文**。官方 `PostToolDecision` 的 `accept` 与 `block` 两种形态
  都声明了 `additionalContexts`，而 2.0.5 只处理 `accept`，等于放弃了一半的注入路径。现在 `block`
  也追加（原样保留它的 `feedback`），其余决定类型仍原样放过。

### 新增（诊断）

- `fetchFallback` 快照新增 6 个自证字段，回答"装了却一次都没注入"到底卡在哪一步：
  `calls`（钩子被调用次数）、`matched`（命中兜底条件次数）、`skippedKind`（被决定类型挡下的次数）、
  `tools` / `errorTools`（见过的工具名 / 以失败结束过的工具名）、`kinds` 与 `lastDecisionKind`
  （下游决定的类型分布）。有了它们，一次触发即可区分"钩子没接上""工具名不符""决定类型不符"
  三种情形，不必再靠推断。

### 修复（CI 与安装）

- CI 的 `node --check` 列表补上 `lib/dsh-home.js`、`lib/prompt-hint.js`、`lib/fetch-fallback.js`：
  这三个 2.0.3～2.0.5 新增的核心文件此前不在语法检查内，写错语法 CI 不会报。
- `package.json` 的 `files` 白名单纳入 `test/`：此前发布包不含测试，而 `verify.ps1` 会无条件运行自测，
  从仓库或 npm 安装的用户会看到"自测未通过"的假失败。
- `verify.ps1` 的自测步骤增加存在性判断：测试文件缺失时显示"跳过"而非"未通过"（手工打的 zip
  漏带 `test/` 时同样安全）；`install.ps1` 的同类提示也只在测试确实存在时才打印。

## [2.0.5] — 2026-10-15

### 新增

- **`web_fetch` 失败兜底（B 方案）**：在官方 `tools/post-execute` 事件上注册策略 ——
  当官方 `web_fetch` 以失败结束时，给它**追加一条纠正上下文**（`PostToolDecision.additionalContexts`，
  官方字段语义正是 "attach context for the next request"）：说明 `web_fetch` 按设计永远直连、
  被墙站点必然失败，并提示"同一 URL 改用 `proxy_fetch` 重试"。

  与引导段（A）的分工：A 让模型**大概率**选对工具；B 保证即使选错也能被纠正。
  不动原始失败结果（保留报错便于排查）；下游策略已 `block` 时一律不插手；
  任何异常只记录、按原决定返回 —— 兜底逻辑绝不影响工具调用本身。配置项 `fetchFallback`（默认开）。

### 诊断

- 快照新增 `fetchFallback` 字段（`installed` / `reason` / `injected` / `lastError`）：
  直接看"兜底装没装上、已经纠正过几次"——排查"用户说装了没效果"的第二步。

## [2.0.4] — 2026-10-15

### 新增

- **系统提示词引导段**：注册 `ctx.systemPrompt.section(...)`，让模型**主动**在抓被墙页面时选用
  `proxy_fetch`。段位取 **2150** —— 夹在官方 `TOOL_WEB_FETCH`（2100）与 `TOOL_LSP`（2200）之间，
  所以模型的阅读顺序是"官方 web_fetch 说明 → 本段纠正 → 其余工具说明"。
  文案说明三件事：官方 `web_fetch` 为何必然失败（设计如此）、何时改用 `proxy_fetch`、
  以及**别在试过之前就告诉用户站点不可达**。配置项 `promptHint`（默认开）/ `promptHintText`（自定义文案）。
  服务缺失或注册失败一律降级，绝不让插件因此加载不了。

- **强化 `proxy_fetch` 的工具描述**（模型可见的唯一元数据）：明确写出"目标可能被墙时优先用它、
  `web_fetch` 失败或超时后用同一 URL 重试"。

### 诊断

- 快照新增 `promptHint` 字段（`registered` / `reason` / `name` / `order` / `chars`），
  外部可直接确认引导段有没有注入成功——这是排查"用户说装了没效果"的第一步。

### 为什么做这个

工具注册 ≠ 模型会调用。官方 `web_fetch` 与 `proxy_fetch` 同时在工具清单里，而"抓网页"这个意图上
模型更可能选名字更直白的 `web_fetch`（它按设计永远直连，对被墙站点必然失败），
于是用户会以为"插件没用"。引导段把选择条件写进系统提示，从机制上解决自调用问题。

## [2.0.3] — 2026-10-15

### 修复

- **诊断快照改放 `$DSH_HOME/cache/dsh-proxy-auto/state.json`**（原来散在 home 根的
  `~/.dsh/dsh-proxy-auto.state.json`）。它是派生数据——每 3 秒重写、丢了会自动重建——
  按官方约定应落在 `cache/`（`dshCachePath()` 的用途就是"可重新生成的数据"），
  而不是污染 home 根。旧的顶层文件可以直接删除，首次运行会自动在新位置重建。

- **修掉一处路径派生缺陷**：快照路径原来用 `os.homedir() + '.dsh'` 拼，**忽略了 `$DSH_HOME`**，
  于是用户把 home 设到别处时，快照会被写到错的地方。现在新增 `lib/dsh-home.js` 作为**唯一**解析处
  （优先级与官方 `@deepseek-ai/dsh-home-paths` 一致：显式配置 > `$DSH_HOME` > `~/.dsh`；
  空白值一律视为未设置，避免把 home 悄悄落到当前工作目录），`.env` 与快照都经它派生。
  这一类"两处各拼路径、随后漂移"的重复，正是官方架构笔记
  `single-harness-home-resolver` 在 harness 内部合并掉的问题，插件侧同理。

### 测试

- `test/selftest.mjs` 新增 5 条断言：三层优先级、显式覆盖、空白值回退、派生数据必须落在 `cache/`。
  自测总数 17 → 22。

## [2.0.2] — 2026-10-09

### 新增

- `verify.ps1` 新增**仓库完整性检查**：确认 `.git/HEAD|config|index|objects|refs` 齐全、`git` 能识别该仓库、
  与 `origin/main` 是否同步。

  起因是实测到：在 GUI 里从 GitHub 安装**同名**插件时（profile 里原本是 `link:` 指向同一目录），
  替换/回滚路径可能削掉 `.git/HEAD|config|index`，使 `git` 突然报 `fatal: not a git repository`。
  现在跑一次体检即可提前发现，并给出重建步骤（**工作区文件不会丢，提交都已在远端**）。
  从 zip 解压安装（没有 `.git`）不会误报，只提示一句"非 git 检出，属正常"。

## [2.0.1] — 2026-10-09

### 文档

- README 按惯例重排（安装 → 为什么需要 → 做什么 / 不做什么 → 失败行为 → 用法 → 配置 → 验证），
  并新增 `README.en.md`（英文版）、`CHANGELOG.md`、`verify.ps1`（一条命令体检）。
- 补充**从仓库直接安装**的方式：`dsh plugin --profile <profile> add github:<owner>/<repo>`
  （适用于 CLI 管理的 profile；`desktop` 由应用独占管理，请用脚本）。

### 修复

- `install.ps1` 在非 Windows / 环境变量缺失时不再抛错：`USERPROFILE` 缺失时退回 `HOME`，
  `APPDATA` 判空，依赖链接在 Unix 上用符号链接（建不了就跳过，功能不受影响）。
- `install.ps1` 现在**显式设置退出码**（0=正常，1=自检有失败项），避免父脚本读到残留的 `$LASTEXITCODE` 而误判。
- 只接受**绝对路径**作为候选安装目录：`npm root -g` 在环境变量缺失时会输出相对路径（甚至含
  `${APPDATA}` 字面量），此前会污染错误信息。
- 两个脚本的输出做**脱敏**（用户名 → `<user>`、主目录 → `~`、AppData → `<appdata>`），
  便于把排障输出直接贴到 issue 而不泄露本机信息。

## [2.0.0] — 2026-10-09

首个公开版本。

### 新增

- **运行时跟随本机代理**：每 3 秒检测环境变量 / Windows 系统代理注册表，并通过 TCP 探活确认可用性。
- **开关免重启**：按需切换全局 `fetch` 的 dispatcher（有代理 → `EnvHttpProxyAgent`，无代理 → 裸 `Agent`）。
- **`proxy_fetch` 工具**：使用显式 dispatcher 抓取网页正文，可读取被墙站点；拒绝私网/回环目标。
- **子进程环境同步**：维护 DSH 官方 `.env` 托管区块，供 `curl` / `git` / `npm` 等使用。
- **诊断快照**：`~/.dsh/dsh-proxy-auto.state.json`，含宿主进程内的自证探针结果。
- **零 junction 安装**：`schemastery` / `undici` 在运行时按宿主安装路径解析；`install.ps1` 幂等安装。

### 设计取舍（都来自实测）

- 候选代理必须通过 TCP 探活才会被采用 —— 避免"地址存在但没人监听"导致的断网。
- 代理消失后 3 秒内卸载策略并回落直连，绝不留下悬空地址。
- **不写** `NODE_USE_ENV_PROXY`：该开关会让 Node 无视调用方指定的 dispatcher，代理一关整进程请求都会撞死端口。

### 已知边界

- `web_fetch` 不走代理属官方设计，本插件不改它（请用 `proxy_fetch`）。
- 不支持 SOCKS、不解析 PAC；非 Windows 平台只读环境变量。
- 代理开关的变化对 `.env`（子进程）需下次启动生效；对进程内请求立即生效。
