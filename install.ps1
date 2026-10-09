<#
.SYNOPSIS
  安装 / 重装 dsh-proxy-auto 到指定的 DSH profile。

.DESCRIPTION
  这个脚本做四件事（可重复执行，幂等）：
    1. 找到 DSH 的安装目录（全局 npm 安装形态：%APPDATA%\npm\node_modules\@deepseek-ai\dsh）
    2. 给插件建两个 junction：@deepseek-ai/schemastery（配置 schema 必需）
                          —— 插件不在 profile 内，Node 从插件目录向上找不到该依赖，
                             没有这个链接插件会因 "Cannot find package" 直接导入失败。
    3. 把插件写进 profile 的 package.json：dependencies（link: 本地路径）+ dsh.profile.bundles
    4. 打印后续步骤（重启 DSH）

  为什么不用 pnpm：pnpm 会解析整个依赖树 + 可能联网；本脚本只做最小的三处改动，
  离线也能跑，坏了也容易回退（每步都会先备份 package.json）。

.PARAMETER Profile
  目标 profile 名（默认 desktop）。可选 web。

.PARAMETER PluginPath
  插件源码路径。默认取本脚本所在目录（即插件根目录）。

.PARAMETER Uninstall
  反向操作：从 profile 里摘掉插件（不动源码目录）。

.EXAMPLE
  pwsh -File .\install.ps1
  pwsh -File .\install.ps1 -Profile web
  pwsh -File .\install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [string]$Profile = 'desktop',
  [string]$PluginPath = '',
  [switch]$Uninstall,
  [switch]$Check
)

$ErrorActionPreference = 'Stop'
$packageName = 'dsh-proxy-auto'

# `-File` 调用时 param 默认值里的 $PSScriptRoot 不一定就绪，函数体内兜底。
if ([string]::IsNullOrWhiteSpace($PluginPath)) {
  $PluginPath = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
}
$PluginPath = (Resolve-Path $PluginPath).Path

<#
  输出脱敏：本机用户名 / 主目录 / AppData 一律替换后再打印。
  理由：安装与排障的输出经常被贴到 issue 或聊天里，不该顺带暴露账户名与目录结构。
#>
function Mask($text) {
  $out = [string]$text
  if ($env:USERNAME) { $out = $out.Replace($env:USERNAME, '<user>') }
  if ($env:USERPROFILE) { $out = $out.Replace($env:USERPROFILE, '~') }
  if ($env:APPDATA) { $out = $out.Replace($env:APPDATA, '<appdata>') }
  if ($env:LOCALAPPDATA) { $out = $out.Replace($env:LOCALAPPDATA, '<localappdata>') }
  $out = $out -replace '(?i)[A-Z]:\\Users\\[^\\]+', '<home>'
  return $out
}

function Write-Step($text) { Write-Host "==> $(Mask $text)" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "    OK  $(Mask $text)" -ForegroundColor Green }
function Write-Warn2($text) { Write-Host "    !!  $(Mask $text)" -ForegroundColor Yellow }

# ── 1. 定位 DSH 安装与 profile 目录 ──────────────────────────────────────────

# 主目录：Windows 用 USERPROFILE，Unix 用 HOME（直接取 USERPROFILE 会在 Linux/macOS 上抛错）。
$homeDir = if ($env:USERPROFILE) { $env:USERPROFILE } elseif ($env:HOME) { $env:HOME } else { (Get-Location).Path }
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $homeDir '.dsh' }

# 组合路径：基路径为空时返回 $null（调用处用 Where-Object 过滤）。
# 用"返回值"而不是"往数组里追加"，是为了避开 PowerShell 脚本块的作用域陷阱：
# 在脚本块里写 $script:candidates 会落到外层，曾经因此把候选列表清空、-Check 直接失败。
function Combine-IfBase($base, $relative) {
  if ([string]::IsNullOrWhiteSpace($base)) { return $null }
  # 只接受绝对路径：`npm root -g` 在环境变量缺失时会吐出相对路径（甚至含 `${APPDATA}` 字面量），
  # 直接拿来做候选会污染错误信息、也可能误命中当前目录。相对路径一律丢弃。
  if (-not [IO.Path]::IsPathRooted($base)) { return $null }
  return [IO.Path]::Combine($base, $relative)
}

function Resolve-DshInstall {
  $npmRoot = $null
  try { $npmRoot = (& npm root -g 2>$null) } catch { }
  $candidates = @(
    (Combine-IfBase $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh'),
    (Combine-IfBase $env:HOME '.npm-global\lib\node_modules\@deepseek-ai\dsh'),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh',
    '/usr/lib/node_modules/@deepseek-ai/dsh',
    (Combine-IfBase $npmRoot '@deepseek-ai\dsh')
  ) | Where-Object { $_ }

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path (Join-Path $candidate 'package.json'))) { return (Resolve-Path $candidate).Path }
  }
  $isWindowsHost = ($IsWindows -eq $true) -or ($env:OS -eq 'Windows_NT')
  $hint = if ($isWindowsHost) {
    '请确认 DSH 是用 npm 全局安装的，或用 -PluginPath / -Profile 指定。'
  } else {
    '本脚本主要为 Windows 编写；Linux/macOS 请按 INSTALL.md 的「手工安装」一节操作（同样只需改 profile 的 package.json）。'
  }
  throw "找不到 DSH 安装目录。$hint`n已尝试：`n  $($candidates -join "`n  ")"
}

$profileDir = Join-Path $dshHome "profiles\$Profile"
$profilePackage = Join-Path $profileDir 'package.json'
if (-not (Test-Path $profileDir)) { throw "profile 目录不存在：$profileDir" }
if (-not (Test-Path $profilePackage)) { throw "profile 缺少 package.json：$profilePackage" }

$dshInstall = Resolve-DshInstall
Write-Step "DSH 安装：$dshInstall"
Write-Step "目标 profile：$profileDir"
Write-Step "插件目录：$PluginPath"

# ── 2. 读写 profile 的 package.json ─────────────────────────────────────────
$json = Get-Content $profilePackage -Raw | ConvertFrom-Json
if (-not $json.dependencies) { $json | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force }
if (-not $json.dsh) { $json | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) -Force }
if (-not $json.dsh.profile) { $json.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) -Force }
if (-not $json.dsh.profile.bundles) { $json.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @() -Force }

function Save-Profile {
  param($Object)
  if ($Check) { Write-Ok '（-Check 模式：不写盘）本应写入 profile'; return }
  $backup = "$profilePackage.bak-$((Get-Date).ToString('yyyyMMdd-HHmmss'))"
  try {
    Copy-Item $profilePackage $backup -Force
  } catch {
    throw "无法在 profile 目录写备份（$profilePackage）：$($_.Exception.Message)`n请用**管理员/普通用户自己的终端**运行本脚本（沙箱或受限账户会写不进去）。"
  }
  ($Object | ConvertTo-Json -Depth 12) | Set-Content $profilePackage -Encoding UTF8
  Write-Ok "已写入 profile（备份：$([IO.Path]::GetFileName($backup))）"
}

function Get-BundleList($Object) { @($Object.dsh.profile.bundles) }

if ($Uninstall) {
  Write-Step '卸载：从 profile 摘掉插件'
  $deps = $json.dependencies.PSObject.Properties | Where-Object { $_.Name -ne $packageName }
  $newDeps = [pscustomobject]@{}
  foreach ($d in $deps) { $newDeps | Add-Member -NotePropertyName $d.Name -NotePropertyValue $d.Value -Force }
  $json.dependencies = $newDeps
  $json.dsh.profile.bundles = @(Get-BundleList $json | Where-Object { $_ -ne $packageName })
  Save-Profile $json
  Write-Step '完成。重启 DSH 后插件不再加载。'
  exit 0
}

# ── 3. （可选）建依赖链接 ───────────────────────────────────────────────────
# 2.0 起插件**不再需要**链接：schemastery/undici 都由插件在运行时按宿主安装路径解析。
# Windows 上顺手建 junction 只是为了兼容更老/更特殊的环境；非 Windows 用符号链接，
# 建不了就跳过（完全不影响功能）。-Check 模式不写盘。
Write-Step '依赖链接（可选，2.0 起非必需）'
$pluginModules = Join-Path $PluginPath 'node_modules/@deepseek-ai'
$linkTargets = @{
  'schemastery' = Join-Path $dshInstall 'node_modules/@deepseek-ai/schemastery'
}
if ($Check) {
  foreach ($name in $linkTargets.Keys) {
    $exists = Test-Path (Join-Path $pluginModules $name)
    Write-Ok "@deepseek-ai/$name：$(if ($exists) { '已有链接' } else { '无链接（也不需要）' })"
  }
} else {
  if (-not (Test-Path $pluginModules)) { New-Item -ItemType Directory -Force -Path $pluginModules | Out-Null }
  foreach ($name in $linkTargets.Keys) {
    $target = $linkTargets[$name]
    $link = Join-Path $pluginModules $name
    if (-not (Test-Path $target)) { Write-Warn2 "宿主缺少 @deepseek-ai/$name（跳过）：$target"; continue }
    if (Test-Path $link) {
      Write-Ok "@deepseek-ai/$name 链接已存在（无需处理）"
    } else {
      # Windows 用 junction，Unix 用符号链接；建不了就跳过——插件本身不依赖它。
      try {
        if ($IsWindows -or $env:OS -eq 'Windows_NT') {
          New-Item -ItemType Junction -Path $link -Target $target | Out-Null
        } else {
          New-Item -ItemType SymbolicLink -Path $link -Target $target | Out-Null
        }
        Write-Ok "@deepseek-ai/$name → $target"
      } catch {
        Write-Warn2 "@deepseek-ai/$name 建链接失败（不影响功能，可忽略）：$($_.Exception.Message)"
      }
    }
  }
}

# ── 4. 写入 profile ─────────────────────────────────────────────────────────
Write-Step '登记到 profile'
$linkSpec = "link:$($PluginPath -replace '\\','/')"
$json.dependencies | Add-Member -NotePropertyName $packageName -NotePropertyValue $linkSpec -Force
$bundles = Get-BundleList $json
if ($bundles -notcontains $packageName) { $json.dsh.profile.bundles = @($bundles + $packageName) }
else { $json.dsh.profile.bundles = $bundles }
Save-Profile $json

# ── 5. 自检 ────────────────────────────────────────────────────────────────
# 路径一律用正斜杠：Windows 与 Unix 都接受，避免跨平台时 Test-Path 假失败。
Write-Step '自检'
$patchFile = Join-Path $PluginPath 'cordis.patch.yml'
$patchText = if (Test-Path $patchFile) { Get-Content $patchFile -Raw } else { '' }
$insertBlocks = ([regex]::Matches($patchText, '(?m)^\s*-\s*insert\s*:')).Count
$checks = @()
$checks += @{ name = '插件入口存在'; ok = (Test-Path (Join-Path $PluginPath 'lib/index.js')) }
$checks += @{ name = 'cordis.patch.yml 存在'; ok = (Test-Path $patchFile) }
$checks += @{ name = 'patch 只有一个 insert 块（多块会 duplicate entry id）'; ok = ($insertBlocks -le 1) }
$checks += @{ name = '宿主有 schemastery（运行时解析用）'; ok = (Test-Path (Join-Path $dshInstall 'node_modules/@deepseek-ai/schemastery/package.json')) }
$checks += @{ name = '宿主有 dsh-http-proxy（官方代理 seam）'; ok = (Test-Path (Join-Path $dshInstall 'node_modules/@deepseek-ai/dsh-http-proxy/package.json')) }
$checks += @{ name = '宿主有 undici（全局 dispatcher 用）'; ok = (Test-Path (Join-Path $dshInstall 'node_modules/undici/package.json')) }
$checks += @{ name = 'profile bundles 含插件'; ok = (@(Get-BundleList $json) -contains $packageName) }
$checkFailures = 0
foreach ($c in $checks) {
  if ($c.ok) { Write-Ok $c.name } else { Write-Warn2 $c.name; $checkFailures++ }
}
if (-not $Check) {
  Write-Host '   提示：跑一遍自测最快验证插件本身：' -ForegroundColor Gray
  Write-Host "     cd `"$(Mask $PluginPath)`"; node test/standalone.mjs; node test/selftest.mjs" -ForegroundColor Gray
}

Write-Host ''
Write-Step '完成。请重启 DSH（宿主半边只在启动时加载）。'
Write-Host '   重启后看这个文件确认状态：' -ForegroundColor Gray
Write-Host "     $(Mask (Join-Path $dshHome 'dsh-proxy-auto.state.json'))" -ForegroundColor Gray
Write-Host '   其中 proxy / dispatcherPatched / probe 三个字段即可判断是否生效。' -ForegroundColor Gray

# 显式退出码：0 = 一切正常；1 = 自检有失败项。
# 必须显式设置——父脚本（verify.ps1）会读 $LASTEXITCODE，否则会拿到上一条外部命令的残留值而误判。
if ($checkFailures -gt 0) { exit 1 } else { exit 0 }
