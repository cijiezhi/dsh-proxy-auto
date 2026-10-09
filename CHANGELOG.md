# Changelog

本文件记录本插件的对外变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

- 计划：把 `proxy_fetch` 的正文抽取做得更好（当前为轻量 HTML → 文本转换）。

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
