# dsh-proxy-auto

[![tests](https://github.com/cijiezhi/dsh-proxy-auto/actions/workflows/ci.yml/badge.svg)](https://github.com/cijiezhi/dsh-proxy-auto/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that makes the host
follow this machine's proxy at runtime — and adds a tool that can actually read pages behind it.**

Turn your proxy on or off: DSH follows it within ~3 seconds, **no restart**. Nothing is hard-wired, so a
proxy that disappears can never take the app's connectivity down with it.

[中文说明](README.md) · [Install & troubleshooting](INSTALL.md) · [Changelog](CHANGELOG.md)

---

## Install

**Option 1 — straight from this repository** (for CLI-managed profiles such as `tui` / `web`):

```sh
dsh plugin --profile <profile> add github:cijiezhi/dsh-proxy-auto
```

This plugin has **no build step** (no `prepare` / `postinstall`), so pnpm's `allowBuilds` never blocks it.

**Option 2 — the local installer** (required for the `desktop` profile, which the CLI refuses to manage):

```powershell
cd <plugin-directory>
pwsh -File .\install.ps1        # idempotent; -Profile web, -Check (dry run), -Uninstall
```

**Option 3 — the zip attached to a Release**, extracted, then run `install.ps1` as above.

Then restart DSH once (the host half is loaded at startup). To verify:

```powershell
pwsh -File .\verify.ps1
```

## Why it exists

DSH resolves its outbound proxy policy **once, at launch**, from the proxy environment variables. Two
everyday consequences:

1. Changing your proxy (or its port) means restarting the app, otherwise the stale address keeps being used.
2. Once a proxy is written into the environment, **turning the proxy off breaks everything** — DSH keeps
   dialing a port that no longer exists.

There is also a capability gap: the built-in `web_fetch` tool pins IPs with its own undici `Agent`
(SSRF / DNS-rebinding protection) and therefore **deliberately bypasses the global dispatcher** — it always
connects directly, so blocked pages can never be fetched. That is by design and no plugin can change it.

This plugin closes those gaps: **follow the local proxy, fall back to direct when it disappears, and
provide a fetch tool that can reach blocked sites.**

## What it does

| Ability | Detail |
|---|---|
| **Follows the proxy** | Every 3 s it detects the local proxy (env vars / Windows system-proxy registry + **TCP liveness check**) |
| **No restart to toggle** | Swaps the global `fetch` dispatcher on demand: proxy → `EnvHttpProxyAgent`, none → bare `Agent` |
| **`proxy_fetch` tool** | Fetches readable page text using an **explicit dispatcher**, so it works for blocked sites while the proxy is up |
| **Child processes** | Maintains DSH's official `.env` so `curl` / `git` / `npm` inherit the proxy too |
| **Status snapshot** | `~/.dsh/dsh-proxy-auto.state.json`, refreshed every 3 s — inspect whether traffic is proxied right now |

## What it does NOT do

- **It does not change `web_fetch`** (official design) — use `proxy_fetch` for blocked pages.
- **No SOCKS, no PAC parsing** — such values are treated as "direct" (the official seam only accepts http(s)).
- **On non-Windows it only reads environment variables** (no system-proxy registry).
- No UI, and it never touches your proxy client's own settings.

## Behaviour on failure

Every step is wrapped, and the rule is: **never make a working direct connection worse.**

- A candidate proxy is adopted only after a **TCP liveness check**; unreachable means "no proxy".
- When the proxy disappears, the policy is removed **within ~3 s** and traffic falls back to direct — no
  dangling address is left behind.
- Any setup failure (host package missing, `.env` not writable, …) is logged only; the rest keeps working.
- It never sets `NODE_USE_ENV_PROXY`, which was measured to make Node ignore a caller-supplied dispatcher.

## Usage

Once installed, just let the agent fetch a blocked page (proxy on):

```text
proxy_fetch https://en.wikipedia.org/wiki/Naruto

URL: https://en.wikipedia.org/wiki/Naruto
Status: 200 (truncated)
Via: http://127.0.0.1:<your-proxy-port>
```

## Configuration (all optional)

| Field | Default | Meaning |
|---|---|---|
| `watchIntervalMs` | 3000 | detection interval |
| `probeTimeoutMs` | 400 | TCP liveness timeout |
| `probeUrl` | a wikipedia page | self-check probe (empty = off); result lands in the snapshot's `probe` |
| `persistToEnv` / `envFile` | true / `$DSH_HOME/.env` | child-process environment |
| `tool` | true | register `proxy_fetch` |
| `noProxy` | `localhost,127.0.0.1,::1,api.deepseek.com` | always-direct list (model API stays direct, so a dead proxy never breaks chat) |
| `debug` | false | log every decision |

## Development

```sh
node test/standalone.mjs   # 9 tests: host-package resolution without junctions / schema / tool contract
node test/selftest.mjs     # 17 tests: detection guarantees / official seam install & removal / .env / dispatcher
```

On a machine without DSH, host-dependent cases are skipped automatically (that is the CI case), so anyone
can clone and run them.

## License

[MIT](LICENSE)
