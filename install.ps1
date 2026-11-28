# AGY Claude Style - Windows One-Liner Installer / Updater / Uninstaller
# Zero external dependencies (no Git or Node.js required on target machine).
# Install / Update:
#   irm https://raw.githubusercontent.com/0DNANCY/agy-claude-style/main/install.ps1 | iex
# Uninstall:
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/0DNANCY/agy-claude-style/main/install.ps1))) -Uninstall
[CmdletBinding()]
param(
  [switch]$Uninstall,
  [switch]$Status,
  [string]$Version = '',
  [string]$InstallDir = '',
  [string]$ArchivePath = '',
  [string]$SourceDir = '',
  [string]$OutFile = '',
  [switch]$Json,
  [switch]$Silent
)

$ErrorActionPreference = 'Stop'
$PluginName = 'agy-claude-style'
$SidecarName = 'agy-claude-style/panel'
$RepoOwner = '0DNANCY'
$RepoName = 'agy-claude-style'
$UninstallRegKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\AgyClaudeStyle'

try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13
} catch {
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
}

function Get-TestSystemRoot {
  $raw = $env:AGY_CS_TEST_SYSTEM_ROOT
  if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
  return [System.IO.Path]::GetFullPath($raw.Trim())
}

function Test-IsSandbox {
  return -not [string]::IsNullOrWhiteSpace((Get-TestSystemRoot))
}

function Resolve-GeminiDir {
  $testRoot = Get-TestSystemRoot
  if ($testRoot) { return (Join-Path $testRoot '.gemini') }
  if (-not [string]::IsNullOrWhiteSpace($env:ANTIGRAVITY_GEMINI_DIR)) {
    return [System.IO.Path]::GetFullPath($env:ANTIGRAVITY_GEMINI_DIR.Trim())
  }
  return (Join-Path $env:USERPROFILE '.gemini')
}

function Get-DefaultInstallDir {
  $g = Resolve-GeminiDir
  return (Join-Path (Join-Path (Join-Path $g 'config') 'plugins') $PluginName)
}

function Get-PluginDataDir {
  $g = Resolve-GeminiDir
  return (Join-Path (Join-Path (Join-Path $g 'antigravity') 'plugin_data') $PluginName)
}

function Get-AntigravityConfigPath {
  $g = Resolve-GeminiDir
  return (Join-Path (Join-Path $g 'config') 'config.json')
}

function Get-LegacyInstallDir {
  $testRoot = Get-TestSystemRoot
  if ($testRoot) {
    return (Join-Path (Join-Path $testRoot 'LegacyLocalAppData') $PluginName)
  }
  return (Join-Path $env:LOCALAPPDATA $PluginName)
}

function Write-Utf8NoBomAtomic([string]$Path, [string]$Content) {
  $dir = [System.IO.Path]::GetDirectoryName($Path)
  if ($dir -and -not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  $tmp = "$Path.tmp.$PID.$([System.Threading.Thread]::CurrentThread.ManagedThreadId)"
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($tmp, $Content, $enc)
  try {
    Move-Item -LiteralPath $tmp -Destination $Path -Force
  } catch {
    [System.IO.File]::Copy($tmp, $Path, $true)
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }
}

function Copy-ConfigStrippingDeprecated([string]$SrcPath, [string]$DestPath) {
  try {
    $raw = [System.IO.File]::ReadAllText($SrcPath, [System.Text.Encoding]::UTF8)
    $obj = $raw | ConvertFrom-Json
    if ($null -eq $obj) { return $false }
    if ($obj.PSObject.Properties['exitOnHostClose']) {
      $obj.PSObject.Properties.Remove('exitOnHostClose')
    }
    $json = ($obj | ConvertTo-Json -Depth 16) + "`n"
    Write-Utf8NoBomAtomic -Path $DestPath -Content $json
    return $true
  } catch {
    return $false
  }
}

function Get-RunningLanguageServers {
  $list = @()
  if (Test-IsSandbox) { return $list }
  $daemonDir = Join-Path (Join-Path (Resolve-GeminiDir) 'antigravity') 'daemon'
  if (-not (Test-Path -LiteralPath $daemonDir)) { return $list }
  Get-ChildItem -LiteralPath $daemonDir -Filter '*.json' -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      $doc = (Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8) | ConvertFrom-Json
      $dpid = [int]$doc.pid
      $port = [int]$doc.httpPort
      $csrf = [string]$doc.csrfToken
      if ($dpid -gt 0 -and $port -gt 0 -and -not [string]::IsNullOrWhiteSpace($csrf)) {
        $proc = Get-Process -Id $dpid -ErrorAction SilentlyContinue
        if ($proc -and -not $proc.HasExited) {
          $list += [pscustomobject]@{ Pid = $dpid; HttpPort = $port; CsrfToken = $csrf }
        }
      }
    } catch {}
  }
  return $list
}

function Invoke-LsRpc($Daemon, [string]$Method, $BodyObj) {
  try {
    $uri = "http://127.0.0.1:$($Daemon.HttpPort)/exa.language_server_pb.LanguageServerService/$Method"
    $headers = @{
      'Connect-Protocol-Version' = '1'
      'x-codeium-csrf-token'     = $Daemon.CsrfToken
      'x-antigravity-csrf-token' = $Daemon.CsrfToken
    }
    $jsonBody = ($BodyObj | ConvertTo-Json -Depth 8 -Compress)
    $null = Invoke-RestMethod -Uri $uri -Method Post -Headers $headers -ContentType 'application/json' -Body $jsonBody -TimeoutSec 3
    return $true
  } catch {
    return $false
  }
}

function Set-LsPluginState($Daemons, [bool]$Enabled) {
  if (-not $Daemons -or $Daemons.Count -eq 0) { return $false }
  $body = @{
    plugins  = @{ $PluginName  = @{ enabled = $Enabled } }
    sidecars = @{ $SidecarName = @{ enabled = $Enabled } }
  }
  $anyOk = $false
  foreach ($d in $Daemons) {
    if (Invoke-LsRpc -Daemon $d -Method 'JetboxWriteState' -BodyObj $body) { $anyOk = $true }
  }
  return $anyOk
}

function Remove-LsPlugin($Daemons) {
  if (-not $Daemons -or $Daemons.Count -eq 0) { return $false }
  $anyOk = $false
  foreach ($d in $Daemons) {
    if (Invoke-LsRpc -Daemon $d -Method 'DeletePlugin' -BodyObj @{ pluginName = $PluginName }) { $anyOk = $true }
  }
  return $anyOk
}

function Read-PluginEnabledState {
  $cfgPath = Get-AntigravityConfigPath
  if (-not (Test-Path -LiteralPath $cfgPath)) { return $false }
  try {
    $doc = ([System.IO.File]::ReadAllText($cfgPath, [System.Text.Encoding]::UTF8)) | ConvertFrom-Json
    if ($null -eq $doc -or -not $doc.PSObject.Properties['plugins']) { return $false }
    $plugins = $doc.plugins
    if ($null -eq $plugins -or -not $plugins.PSObject.Properties[$PluginName]) { return $false }
    $entry = $plugins.$PluginName
    if ($entry -is [bool]) { return $entry }
    if ($null -ne $entry -and $entry.PSObject.Properties['enabled']) { return [bool]$entry.enabled }
    return $true
  } catch {
    return $false
  }
}

function Set-PluginEnabledInConfig([bool]$Enable) {
  $cfgPath = Get-AntigravityConfigPath
  if (-not $Enable -and -not (Test-Path -LiteralPath $cfgPath)) { return }
  $doc = $null
  if (Test-Path -LiteralPath $cfgPath) {
    try {
      $doc = ([System.IO.File]::ReadAllText($cfgPath, [System.Text.Encoding]::UTF8)) | ConvertFrom-Json
    } catch { $doc = $null }
  }
  if ($null -eq $doc) { $doc = New-Object psobject }
  if (-not $doc.PSObject.Properties['plugins'] -or $null -eq $doc.plugins) {
    $doc | Add-Member -MemberType NoteProperty -Name 'plugins' -Value (New-Object psobject) -Force
  }
  if ($Enable) {
    $entry = $null
    if ($doc.plugins.PSObject.Properties[$PluginName]) {
      $existing = $doc.plugins.$PluginName
      if ($existing -is [psobject]) { $entry = $existing }
    }
    if ($null -eq $entry) { $entry = New-Object psobject }
    $entry | Add-Member -MemberType NoteProperty -Name 'enabled' -Value $true -Force
    $doc.plugins | Add-Member -MemberType NoteProperty -Name $PluginName -Value $entry -Force
  } else {
    if ($doc.plugins.PSObject.Properties[$PluginName]) {
      $doc.plugins.PSObject.Properties.Remove($PluginName)
    }
  }
  $json = ($doc | ConvertTo-Json -Depth 16) + "`n"
  Write-Utf8NoBomAtomic -Path $cfgPath -Content $json
}

function Clear-LegacyArtifacts([string]$TargetInstallDir) {
  $cleaned = $false
  $testRoot = Get-TestSystemRoot

  if (-not (Test-IsSandbox)) {
    try {
      Get-Process -Name 'agy-claude-style-watcher' -ErrorAction SilentlyContinue | ForEach-Object {
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
        $cleaned = $true
      }
    } catch {}
    try {
      if (Test-Path -LiteralPath $UninstallRegKey) {
        Remove-Item -LiteralPath $UninstallRegKey -Recurse -Force -ErrorAction SilentlyContinue
        $cleaned = $true
      }
    } catch {}
  }

  $shortcuts = @()
  if ($testRoot) {
    $shortcuts += (Join-Path (Join-Path $testRoot 'Startup') 'AGY-Claude-Style.lnk')
    $shortcuts += (Join-Path (Join-Path $testRoot 'StartMenu') 'Antigravity (AGY Claude Style).lnk')
    $shortcuts += (Join-Path (Join-Path $testRoot 'Desktop') 'Antigravity (AGY Claude Style).lnk')
  } else {
    $startup = [Environment]::GetFolderPath('Startup')
    $programs = [Environment]::GetFolderPath('Programs')
    $desktop = [Environment]::GetFolderPath('DesktopDirectory')
    if ($startup) { $shortcuts += (Join-Path $startup 'AGY-Claude-Style.lnk') }
    if ($programs) {
      $shortcuts += (Join-Path (Join-Path $programs 'Antigravity') 'Antigravity (AGY Claude Style).lnk')
      $shortcuts += (Join-Path $programs 'Antigravity (AGY Claude Style).lnk')
    }
    if ($desktop) { $shortcuts += (Join-Path $desktop 'Antigravity (AGY Claude Style).lnk') }
  }
  foreach ($lnk in $shortcuts) {
    if ($lnk -and (Test-Path -LiteralPath $lnk)) {
      Remove-Item -LiteralPath $lnk -Force -ErrorAction SilentlyContinue
      $cleaned = $true
    }
  }

  $legacyDir = Get-LegacyInstallDir
  if ($legacyDir -and (Test-Path -LiteralPath $legacyDir)) {
    $a = [System.IO.Path]::GetFullPath($legacyDir).TrimEnd('\')
    $b = [System.IO.Path]::GetFullPath($TargetInstallDir).TrimEnd('\')
    if (-not [string]::Equals($a, $b, [System.StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $legacyDir -Recurse -Force -ErrorAction SilentlyContinue
      $cleaned = $true
    }
  }

  $oldUninstaller = Join-Path (Get-PluginDataDir) 'agy-claude-style-uninstaller.exe'
  if (Test-Path -LiteralPath $oldUninstaller) {
    Remove-Item -LiteralPath $oldUninstaller -Force -ErrorAction SilentlyContinue
    $cleaned = $true
  }

  if (Test-Path -LiteralPath $TargetInstallDir) {
    foreach ($f in @('agy-claude-style-watcher.exe', 'agy-claude-style-installer.exe', 'manifest.json', '.install-mode', '.watch.pid', 'Antigravity (AGY Claude Style).lnk')) {
      $p = Join-Path $TargetInstallDir $f
      if (Test-Path -LiteralPath $p) {
        Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
        $cleaned = $true
      }
    }
  }
  return $cleaned
}

function Read-InstalledVersion([string]$TargetInstallDir) {
  $pj = Join-Path $TargetInstallDir 'plugin.json'
  if (-not (Test-Path -LiteralPath $pj)) { return $null }
  try {
    return (([System.IO.File]::ReadAllText($pj, [System.Text.Encoding]::UTF8)) | ConvertFrom-Json).version
  } catch {
    return $null
  }
}

function Expand-PluginZipSafe([string]$ZipPath, [string]$DestDir) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  if (-not (Test-Path -LiteralPath $DestDir)) {
    New-Item -ItemType Directory -Path $DestDir -Force | Out-Null
  }
  $fullDest = [System.IO.Path]::GetFullPath($DestDir).TrimEnd('\') + '\'
  $archive = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
  try {
    $entries = @($archive.Entries | Where-Object { -not [string]::IsNullOrEmpty($_.Name) })
    $hasRootPluginJson = $false
    $firstSegments = New-Object 'System.Collections.Generic.HashSet[string]'
    foreach ($e in $entries) {
      $norm = $e.FullName.Replace('\', '/').TrimStart('/')
      if ($norm -eq 'plugin.json') { $hasRootPluginJson = $true }
      $idx = $norm.IndexOf('/')
      if ($idx -gt 0) { [void]$firstSegments.Add($norm.Substring(0, $idx)) }
    }
    $stripPrefix = ''
    if (-not $hasRootPluginJson -and $firstSegments.Count -eq 1) {
      foreach ($s in $firstSegments) { $stripPrefix = "$s/" }
    }
    $count = 0
    foreach ($e in $entries) {
      $norm = $e.FullName.Replace('\', '/').TrimStart('/')
      if ($stripPrefix -and $norm.StartsWith($stripPrefix, [System.StringComparison]::Ordinal)) {
        $norm = $norm.Substring($stripPrefix.Length)
      }
      if ([string]::IsNullOrWhiteSpace($norm)) { continue }
      if ($norm -match '^installer(/|$)' -or $norm -match '^\.git(/|$)' -or $norm -eq 'config.json') { continue }
      $rel = $norm.Replace('/', '\')
      $target = [System.IO.Path]::GetFullPath((Join-Path $DestDir $rel))
      if (-not $target.StartsWith($fullDest, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Unsafe zip entry path: $($e.FullName)"
      }
      $parent = [System.IO.Path]::GetDirectoryName($target)
      if ($parent -and -not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
      }
      $srcStream = $e.Open()
      try {
        $dstStream = [System.IO.File]::Create($target)
        try { $srcStream.CopyTo($dstStream) } finally { $dstStream.Dispose() }
      } finally {
        $srcStream.Dispose()
      }
      $count++
    }
    return $count
  } finally {
    $archive.Dispose()
  }
}

function Copy-SourceDirectory([string]$SrcDir, [string]$DestDir) {
  $fullSrc = [System.IO.Path]::GetFullPath($SrcDir).TrimEnd('\') + '\'
  $fullDest = [System.IO.Path]::GetFullPath($DestDir).TrimEnd('\') + '\'
  $skipTop = @('.git', 'dist', 'node_modules', 'installer', 'test')
  $count = 0
  Get-ChildItem -LiteralPath $SrcDir -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($fullSrc.Length).Replace('\', '/')
    $first = ($rel.Split('/'))[0]
    if ($skipTop -contains $first) { return }
    if ($_.Name -in @('.DS_Store', 'Thumbs.db', '.watch.pid', 'watch.log', 'config.json')) { return }
    $target = [System.IO.Path]::GetFullPath((Join-Path $DestDir $rel.Replace('/', '\')))
    if (-not $target.StartsWith($fullDest, [System.StringComparison]::OrdinalIgnoreCase)) { return }
    $parent = [System.IO.Path]::GetDirectoryName($target)
    if ($parent -and -not (Test-Path -LiteralPath $parent)) {
      New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    [System.IO.File]::Copy($_.FullName, $target, $true)
    $count++
  }
  return $count
}

function Resolve-DownloadZipUrl([string]$RequestedVersion) {
  $headers = @{ 'User-Agent' = 'agy-claude-style-installer/4.0.0' }
  if (-not [string]::IsNullOrWhiteSpace($RequestedVersion)) {
    $tag = if ($RequestedVersion.StartsWith('v')) { $RequestedVersion } else { "v$RequestedVersion" }
    $clean = $tag.TrimStart('v')
    return "https://github.com/$RepoOwner/$RepoName/releases/download/$tag/agy-claude-style-v$clean.zip"
  }
  try {
    $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$RepoOwner/$RepoName/releases/latest" -Headers $headers -TimeoutSec 10
    if ($rel -and $rel.assets) {
      $asset = $rel.assets | Where-Object { $_.name -match '^agy-claude-style-v.*\.zip$' } | Select-Object -First 1
      if ($asset -and $asset.browser_download_url) {
        return [string]$asset.browser_download_url
      }
    }
  } catch {}
  return "https://github.com/$RepoOwner/$RepoName/archive/refs/heads/main.zip"
}

$targetDir = if ([string]::IsNullOrWhiteSpace($InstallDir)) { Get-DefaultInstallDir } else { [System.IO.Path]::GetFullPath($InstallDir) }
$dataDir = Get-PluginDataDir
$res = $null

if ($Status) {
  $res = [ordered]@{
    ok               = $true
    mode             = 'status'
    installed        = (Test-Path -LiteralPath (Join-Path $targetDir 'plugin.json'))
    installedVersion = Read-InstalledVersion $targetDir
    pluginEnabled    = Read-PluginEnabledState
    installDir       = $targetDir
    pluginDataDir    = $dataDir
    hasConfig        = (Test-Path -LiteralPath (Join-Path $dataDir 'config.json'))
    hasWallpapersDir = (Test-Path -LiteralPath (Join-Path $dataDir 'wallpapers'))
  }
} elseif ($Uninstall) {
  $daemons = Get-RunningLanguageServers
  $lsStopped = Remove-LsPlugin $daemons
  if (-not $lsStopped) { $lsStopped = Set-LsPluginState $daemons $false }
  if ($lsStopped) { Start-Sleep -Milliseconds 350 }
  Set-PluginEnabledInConfig $false
  $legacyCleaned = Clear-LegacyArtifacts $targetDir
  if (Test-Path -LiteralPath $targetDir) {
    Remove-Item -LiteralPath $targetDir -Recurse -Force -ErrorAction SilentlyContinue
  }
  $res = [ordered]@{
    ok            = $true
    mode          = 'uninstall'
    installDir    = $targetDir
    pluginDataDir = $dataDir
    legacyCleaned = $legacyCleaned
    pluginEnabled = Read-PluginEnabledState
    lsHotReloaded = $lsStopped
  }
} else {
  if (-not (Test-Path -LiteralPath $dataDir)) {
    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
  }
  $activeCfg = Join-Path $dataDir 'config.json'
  $legacyCfg = Join-Path (Get-LegacyInstallDir) 'config.json'
  $preserved = $false
  $migrated = $false
  if (Test-Path -LiteralPath $activeCfg) {
    $null = Copy-ConfigStrippingDeprecated $activeCfg $activeCfg
    $preserved = $true
  } elseif (Test-Path -LiteralPath $legacyCfg) {
    $migrated = Copy-ConfigStrippingDeprecated $legacyCfg $activeCfg
    if ($migrated) { $preserved = $true }
  }

  $daemons = Get-RunningLanguageServers
  $paused = Set-LsPluginState $daemons $false
  if ($paused) { Start-Sleep -Milliseconds 350 }
  $legacyCleaned = Clear-LegacyArtifacts $targetDir

  $tmpZip = $null
  $fileCount = 0
  try {
    if (-not [string]::IsNullOrWhiteSpace($SourceDir)) {
      $fileCount = Copy-SourceDirectory ([System.IO.Path]::GetFullPath($SourceDir)) $targetDir
    } else {
      $zipToUse = $ArchivePath
      if ([string]::IsNullOrWhiteSpace($zipToUse)) {
        $url = Resolve-DownloadZipUrl $Version
        $tmpZip = Join-Path ([System.IO.Path]::GetTempPath()) ("agy-cs-" + [guid]::NewGuid().ToString('N') + ".zip")
        if (-not $Silent) { Write-Host "[*] Downloading AGY Claude Style from $url ..." }
        Invoke-WebRequest -Uri $url -OutFile $tmpZip -UseBasicParsing -TimeoutSec 60
        $zipToUse = $tmpZip
      }
      $fileCount = Expand-PluginZipSafe ([System.IO.Path]::GetFullPath($zipToUse)) $targetDir
    }
  } finally {
    if ($tmpZip -and (Test-Path -LiteralPath $tmpZip)) {
      Remove-Item -LiteralPath $tmpZip -Force -ErrorAction SilentlyContinue
    }
  }

  if (-not (Test-Path -LiteralPath $activeCfg)) {
    $exCfg = Join-Path $targetDir 'config.example.json'
    if (Test-Path -LiteralPath $exCfg) {
      [System.IO.File]::Copy($exCfg, $activeCfg, $false)
    }
  }

  Set-PluginEnabledInConfig $true
  $lsEnabled = Set-LsPluginState $daemons $true
  $ver = Read-InstalledVersion $targetDir

  $res = [ordered]@{
    ok                      = $true
    mode                    = 'install'
    version                 = $ver
    installDir              = $targetDir
    pluginDataDir           = $dataDir
    configPath              = $activeCfg
    preservedExistingConfig = $preserved
    migratedLegacyConfig    = $migrated
    legacyCleaned           = $legacyCleaned
    pluginEnabled           = Read-PluginEnabledState
    lsHotReloaded           = $lsEnabled
    fileCount               = $fileCount
  }
}

if (-not [string]::IsNullOrWhiteSpace($OutFile)) {
  Write-Utf8NoBomAtomic -Path ([System.IO.Path]::GetFullPath($OutFile)) -Content (($res | ConvertTo-Json -Depth 8) + "`n")
}

if (-not $Silent) {
  if ($Json) {
    Write-Output ($res | ConvertTo-Json -Depth 8)
  } elseif ($res.mode -eq 'status') {
    $state = if ($res.installed) { "v$($res.installedVersion) (enabled=$($res.pluginEnabled))" } else { 'not installed' }
    Write-Host "AGY Claude Style: $state"
    Write-Host "  Plugin Dir: $($res.installDir)"
    Write-Host "  Data Dir:   $($res.pluginDataDir)"
  } elseif ($res.mode -eq 'uninstall') {
    Write-Host "[OK] Uninstalled AGY Claude Style from $($res.installDir)"
    Write-Host "     User data preserved at $($res.pluginDataDir)"
  } else {
    Write-Host "[OK] Installed AGY Claude Style v$($res.version) ($($res.fileCount) files) -> $($res.installDir)"
    if ($res.lsHotReloaded) {
      Write-Host "     Hot-enabled via running Antigravity Language Server."
    } else {
      Write-Host "     Enabled in Antigravity config.json (takes effect on Antigravity launch)."
    }
  }
}
