<#
.SYNOPSIS
  dsh-proxy-auto 体检脚本：确认插件装好了、宿主依赖齐全、自测通过。

.DESCRIPTION
  一条命令给出可贴出来的结论，适合装完/升级后/出问题时先跑这个：

    1. 定位 DSH 安装与 profile（不写盘：内部用 install.ps1 -Check）
    2. 静态自检：插件文件齐全、patch 结构正确、宿主依赖存在、profile 已登记
    3. 运行两套自测（无 DSH 的机器上宿主相关用例会自动 SKIP）
    4. 打印诊断快照的关键字段（若插件已在运行）

.PARAMETER Profile
  要检查的 profile（默认 desktop）。

.PARAMETER SkipTests
  跳过自测（只做静态检查，最快）。

.EXAMPLE
  pwsh -File .\verify.ps1
  pwsh -File .\verify.ps1 -Profile web -SkipTests
#>
[CmdletBinding()]
param(
  [string]$Profile = 'desktop',
  [switch]$SkipTests
)

$ErrorActionPreference = 'Continue'
$root = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
# DSH_HOME → 否则用平台对应的主目录（USERPROFILE 只在 Windows 有；HOME 覆盖 Unix）。
$homeDir = if ($env:USERPROFILE) { $env:USERPROFILE } elseif ($env:HOME) { $env:HOME } else { (Get-Location).Path }
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $homeDir '.dsh' }
$statePath = Join-Path $dshHome 'dsh-proxy-auto.state.json'
$failures = 0

function Section($title) { Write-Host ""; Write-Host "== $title" -ForegroundColor Cyan }

<#
  输出脱敏：本机用户名 / 主目录 / AppData 一律替换后再打印。
  理由：这份输出最常被贴到 issue 或聊天里求助，不该顺带暴露账户名与目录结构。
#>
function Mask($text) {
  $out = [string]$text
  if ($env:USERNAME) { $out = $out.Replace($env:USERNAME, '<user>') }
  if ($env:USERPROFILE) { $out = $out.Replace($env:USERPROFILE, '~') }
  if ($dshHome) { $out = $out.Replace($dshHome, '~/.dsh') }
  if ($env:APPDATA) { $out = $out.Replace($env:APPDATA, '<appdata>') }
  if ($env:LOCALAPPDATA) { $out = $out.Replace($env:LOCALAPPDATA, '<localappdata>') }
  $out = $out -replace '(?i)[A-Z]:\\Users\\[^\\]+', '<home>'
  return $out
}

function Ok($text) { Write-Host "  [OK]   $(Mask $text)" -ForegroundColor Green }
function Bad($text) { Write-Host "  [FAIL] $(Mask $text)" -ForegroundColor Red; $script:failures++ }
function Info($text) { Write-Host "  [info] $(Mask $text)" -ForegroundColor Gray }

Section '1. 静态自检（含 profile 登记）'
$checkScript = Join-Path $root 'install.ps1'
if (Test-Path $checkScript) {
  # *>&1：把信息流也纳入管道——子脚本用 Write-Host 打印的内容同样要过脱敏（它不走管道是踩过的坑）。
  & $checkScript -Profile $Profile -Check *>&1 | ForEach-Object { Write-Host "  $(Mask $_)" }
  if ($LASTEXITCODE -ne 0) { Bad 'install.ps1 -Check 报告异常' }
} else {
  Bad "缺少 install.ps1（$checkScript）"
}

Section '2. 运行环境'
Info "PowerShell : $($PSVersionTable.PSVersion)"
Info "平台       : $([System.Environment]::OSVersion.Platform)（$($PSVersionTable.Platform)）"
Info "Node       : $(try { (& node --version) } catch { '未找到' })"
# 注意：APPDATA 只在 Windows 存在；直接 Join-Path 会在 Linux/macOS 上抛错（曾经就这么崩）。
if ($env:APPDATA) {
  $dshPkg = Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\package.json'
  if (Test-Path $dshPkg) { Ok "DSH 安装：$(Split-Path $dshPkg -Parent)" } else { Info '未在默认位置找到 DSH（自定义安装属正常）' }
} else {
  Info '非 Windows：跳过系统代理注册表与默认安装位置检查（插件仍可用，走环境变量探测）'
}

if (-not $SkipTests) {
  Section '3. 自测'
  Push-Location $root
  try {
    & node test/standalone.mjs
    if ($LASTEXITCODE -ne 0) { Bad 'test/standalone.mjs 未通过' } else { Ok 'test/standalone.mjs 通过' }
    & node test/selftest.mjs
    if ($LASTEXITCODE -ne 0) { Bad 'test/selftest.mjs 未通过' } else { Ok 'test/selftest.mjs 通过' }
  } finally {
    Pop-Location
  }
}

Section '4. 运行状态（插件已加载时才有）'
if (Test-Path $statePath) {
  try {
    $state = Get-Content $statePath -Raw | ConvertFrom-Json
    Info "快照时间   : $($state.at)"
    Info "代理判定   : $(if ($state.proxy) { $state.proxy } else { '直连' })（依据：$($state.source)）"
    Info "dispatcher : $(if ($state.dispatcherPatched) { '已按代理路由' } else { '直连' })"
    Info "官方 seam  : $(if ($state.seamLoaded) { $state.seamRoute } else { '未装载' })"
    if ($state.probe) {
      $probeText = if ($state.probe.ok) { "成功 HTTP $($state.probe.status) / $($state.probe.ms) ms" } else { "失败（$($state.probe.error)）" }
      Info "自证探针   : $probeText"
    }
  } catch {
    Bad "快照无法解析：$statePath"
  }
} else {
  Info "尚无快照（$statePath）——插件可能未加载，或还没跑过一个检测周期"
}

Section '结论'
if ($failures -eq 0) {
  Write-Host "  体检通过。若代理开着但抓不到墙外页面，请把上面第 4 节的内容贴出来排查。" -ForegroundColor Green
} else {
  Write-Host "  有 $failures 项失败，请看上面的 [FAIL] 行。" -ForegroundColor Red
}
exit $failures
