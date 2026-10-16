# dsh-proxy-auto · 宿主安装目录探测（install.ps1 与 verify.ps1 共用）
#
# 为什么抽出来：两个脚本各写一份必然漂移，而这里恰好踩过坑 —— 原实现只认
# 「npm 全局安装形态」（%APPDATA%\npm\node_modules\@deepseek-ai\dsh），
# 而 DSH 桌面应用（Electron，nightly 通道）把包放在 resources\app.asar 内，
# 于是 verify.ps1 第一段就 throw，后面四段全跑不到。
#
# 关键实测（2026-10-16）：
#   · Test-Path 对 app.asar 内路径一律 False（PowerShell 没有 Electron 的 asar 支持）
#   · 因此判据必须是「应用根存在 + resources\app.asar 文件存在」，
#     不能靠 Test-Path 去 app.asar 里逐个查文件
#   · 真实落点（Electron 内部可见的路径）：
#       resources\app.asar\dsh\node_modules\undici
#       resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-http-proxy
#
# 用法：两个脚本都 dot-source 本文件，然后调用 Resolve-DshInstall。

# 组合路径：基路径为空时返回 $null（调用处用 Where-Object 过滤）。
# 用"返回值"而不是"往数组里追加"，是为了避开 PowerShell 脚本块的作用域陷阱。
function Combine-IfBase($base, $relative) {
  if ([string]::IsNullOrWhiteSpace($base)) { return $null }
  # 只接受绝对路径：`npm root -g` 在环境变量缺失时会吐出相对路径（甚至含 `${APPDATA}` 字面量）。
  if (-not [IO.Path]::IsPathRooted($base)) { return $null }
  return [IO.Path]::Combine($base, $relative)
}

<#
  候选是否可用。
  · 真实目录：Test-Path 直接为真
  · asar 内路径（…\resources\app.asar\dsh）：PowerShell 的 Test-Path **永远看不到**，
    改用"asar 文件 + app.asar 目录都在"作判据 —— 这是 Electron 桌面形态的可靠特征。
#>
function Test-DshCandidate($candidate) {
  if (Test-Path $candidate) { return $true }
  if ($candidate -notmatch 'app\.asar') { return $false }
  $asar = $candidate.Substring(0, $candidate.IndexOf('app.asar') + 'app.asar'.Length)
  return (Test-Path $asar) -and (Test-Path (Split-Path $asar -Parent))
}

<#
  探测 DSH 安装（即 DSH 包根目录，其下应有 node_modules）。
  返回：字符串路径，或 $null。**不抛异常** —— 由调用方决定怎么报错。
#>
function Resolve-DshInstall {
  $candidates = @()

  # ① 显式指定（最高优先，便于自定义安装）
  if (-not [string]::IsNullOrWhiteSpace($env:DSH_INSTALL_DIR)) { $candidates += $env:DSH_INSTALL_DIR }
  if (-not [string]::IsNullOrWhiteSpace($env:DSH_PROXY_AUTO_DSH_DIR)) { $candidates += $env:DSH_PROXY_AUTO_DSH_DIR }

  # ② Electron 桌面应用形态：从「本脚本所在盘」与「已知应用目录」推导 resources
  $roots = @()
  if ($PSCommandPath) { $roots += (Split-Path (Split-Path (Split-Path $PSCommandPath -Parent) -Parent) -Parent) }
  if ($env:DSH_APP_DIR) { $roots += $env:DSH_APP_DIR }
  if ($env:LOCALAPPDATA) { $roots += (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness') }
  if ($env:ProgramFiles) { $roots += (Join-Path $env:ProgramFiles 'DeepSeek Harness') }
  if (${env:ProgramFiles(x86)}) { $roots += (Join-Path ${env:ProgramFiles(x86)} 'DeepSeek Harness') }
  # 本机实际落点（换机也能靠上面几条推出来）
  $roots += 'E:\DeepSeek Harness'

  foreach ($root in ($roots | Where-Object { $_ } | Select-Object -Unique)) {
    $resources = Join-Path $root 'resources'
    # 判据：app.asar 文件本身可见（Test-Path 对 asar **文件**有效，对其内部路径无效）
    if (Test-Path (Join-Path $resources 'app.asar')) {
      $candidates += (Join-Path $resources 'app.asar\dsh')
    }
    $candidates += (Join-Path $resources 'app\dsh')
    $candidates += (Join-Path $resources 'app')
  }

  # ③ npm 全局安装形态（历史落点）
  if ($env:APPDATA) { $candidates += (Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh') }
  if ($env:HOME) { $candidates += (Join-Path $env:HOME '.npm-global\lib\node_modules\@deepseek-ai\dsh') }

  # ④ 可执行文件逐级向上（老形态兜底）
  $exe = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
  if (-not $exe) { $exe = $PSHOME }
  $dir = $exe
  for ($i = 0; $i -lt 5; $i++) {
    if ([string]::IsNullOrWhiteSpace($dir)) { break }
    $parent = Split-Path $dir -Parent
    if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $dir) { break }
    $dir = $parent
    $candidates += (Join-Path $dir 'node_modules\@deepseek-ai\dsh')
    $candidates += (Join-Path $dir 'resources\app.asar\dsh')
    $candidates += (Join-Path $dir 'resources\app\dsh')
  }

  foreach ($candidate in ($candidates | Where-Object { $_ } | Select-Object -Unique)) {
    if (-not (Test-DshCandidate $candidate)) { continue }
    # asar 内的路径不能走 Resolve-Path（PowerShell 解析不到），原样返回即可
    if ($candidate -match 'app\.asar' -and -not (Test-Path $candidate)) { return $candidate }
    $resolved = Resolve-Path $candidate -ErrorAction SilentlyContinue
    if ($resolved) { return $resolved.Path }
    return $candidate
  }
  return $null
}

<#
  给"找不到 DSH"时的可读提示（脱敏交给调用方）。
  $tried 为候选列表，便于用户一眼看出脚本找过哪儿。
#>
function Get-DshInstallHint($tried) {
  $lines = @(
    '找不到 DSH 安装目录。已尝试：'
  )
  foreach ($t in $tried) { $lines += "  $t" }
  $lines += @(
    ''
    '若 DSH 是**桌面应用安装**（Electron），请在应用根目录下找 resources\app.asar；'
    '若装在自定义位置，用环境变量指定：'
    '  $env:DSH_APP_DIR = "D:\apps\DeepSeek Harness"      # 应用根（含 resources）'
    '  $env:DSH_INSTALL_DIR = "…\resources\app.asar\dsh"   # 或直接给 DSH 包根'
    '（注意：PowerShell 的 Test-Path 看不到 app.asar 内部，属正常现象，不要据此判断安装损坏。）'
  )
  return ($lines -join "`n")
}
