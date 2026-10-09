# Changelog

本文件记录本插件的对外变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

- 计划：把 `proxy_fetch` 的正文抽取做得更好（当前为轻量 HTML → 文本转换）。

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
