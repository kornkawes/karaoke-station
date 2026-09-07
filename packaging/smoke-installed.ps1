param(
  [Parameter(Mandatory = $true)]
  [string]$InstallDir
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$baseUrl = 'http://127.0.0.1:4173'
$resolvedInstallDir = [System.IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
$installRoot = [System.IO.Path]::GetPathRoot($resolvedInstallDir).TrimEnd('\')
if (
  [string]::IsNullOrWhiteSpace($InstallDir) -or
  [string]::IsNullOrWhiteSpace($resolvedInstallDir) -or
  $resolvedInstallDir.Equals($installRoot, [System.StringComparison]::OrdinalIgnoreCase)
) {
  throw 'InstallDir must be a non-root directory'
}
if (-not (Test-Path -LiteralPath $resolvedInstallDir -PathType Container)) {
  throw "InstallDir does not exist: $resolvedInstallDir"
}
$installItem = Get-Item -LiteralPath $resolvedInstallDir -Force
if (($installItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw 'InstallDir must not be a reparse point'
}
$installPrefix = $resolvedInstallDir + '\'

function Resolve-InstalledFile {
  param([string]$RelativePath)
  if (
    [string]::IsNullOrWhiteSpace($RelativePath) -or
    [System.IO.Path]::IsPathRooted($RelativePath)
  ) {
    throw 'Installed file path must be non-empty and relative'
  }
  $candidate = [System.IO.Path]::GetFullPath((Join-Path $resolvedInstallDir $RelativePath))
  if (-not $candidate.StartsWith($installPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Installed file escaped InstallDir: $RelativePath"
  }
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
    throw "Required installed file is missing: $RelativePath"
  }
  return $candidate
}

function Start-Launcher {
  param([string]$Arguments = '')
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $launcherPath
  $startInfo.Arguments = $Arguments
  $startInfo.WorkingDirectory = $resolvedInstallDir
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.EnvironmentVariables['PATH'] = ''
  $process = [System.Diagnostics.Process]::Start($startInfo)
  if ($null -eq $process) {
    throw 'Installed launcher did not start'
  }
  return $process
}

function Wait-Health {
  param([int]$TimeoutSeconds = 30)
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/api/v1/health" -TimeoutSec 1
      if ($response.StatusCode -eq 200) { return }
    } catch {
      Start-Sleep -Milliseconds 250
    }
  } while ([DateTime]::UtcNow -lt $deadline)
  throw 'Installed server health timeout'
}

function Wait-LauncherReady {
  param(
    [string]$LogPath,
    [long]$PreviousLength,
    [int]$TimeoutSeconds = 30
  )
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    if (Test-Path -LiteralPath $LogPath -PathType Leaf) {
      $logText = Get-Content -Raw -LiteralPath $LogPath
      $newText = if ($logText.Length -ge $PreviousLength) {
        $logText.Substring([int]$PreviousLength)
      } else {
        $logText
      }
      if ($newText.Contains('Station ready.')) { return }
    }
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $deadline)
  throw 'Installed launcher did not report ready after starting its Party session'
}

function Wait-PortsClosed {
  param([int]$TimeoutSeconds = 30)
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    $listeners = @(
      Get-NetTCPConnection -State Listen -LocalPort 4173,4174 -ErrorAction SilentlyContinue
    )
    if ($listeners.Count -eq 0) { return }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  throw 'Installed server ports did not close after --shutdown'
}

function Invoke-Shutdown {
  $shutdown = Start-Launcher -Arguments '--shutdown'
  try {
    if (-not $shutdown.WaitForExit(35000)) {
      throw 'Installed launcher --shutdown timed out'
    }
    if ($shutdown.ExitCode -ne 0) {
      throw "Installed launcher --shutdown exited with $($shutdown.ExitCode)"
    }
  } finally {
    $shutdown.Dispose()
  }
}

$launcherPath = Resolve-InstalledFile 'KaraokeStation.exe'
$runtimeArchitecture = if ([Environment]::Is64BitOperatingSystem) { 'win-x64' } else { 'win-x86' }
$bundledNodePath = Resolve-InstalledFile "runtime\$runtimeArchitecture\node.exe"
$sourceServerPath = Join-Path $resolvedInstallDir 'app\server\index.js'
$bundledServerPath = Join-Path $resolvedInstallDir 'app\server\index.cjs'
if (-not (Test-Path -LiteralPath $sourceServerPath -PathType Leaf) -and
    -not (Test-Path -LiteralPath $bundledServerPath -PathType Leaf)) {
  throw 'Installed server entry is missing'
}
$null = Resolve-InstalledFile 'app\dist\index.html'

$guardRejected = $false
try {
  Resolve-InstalledFile '..\outside.txt' | Out-Null
} catch {
  $guardRejected = $true
}
if (-not $guardRejected) {
  throw 'InstallDir containment guard accepted an escaping path'
}

$preExistingListeners = @(
  Get-NetTCPConnection -State Listen -LocalPort 4173,4174 -ErrorAction SilentlyContinue
)
if ($preExistingListeners.Count -ne 0) {
  throw 'Ports 4173/4174 must be free before installed smoke; no process was stopped'
}

$primaryLauncher = $null
$shutdownCompleted = $false
$logPath = Join-Path $env:LOCALAPPDATA 'KaraokeStation\logs\launcher.log'
$logLengthBefore = if (Test-Path -LiteralPath $logPath -PathType Leaf) {
  (Get-Content -Raw -LiteralPath $logPath).Length
} else {
  0
}
try {
  $primaryLauncher = Start-Launcher
  Wait-Health
  Wait-LauncherReady -LogPath $logPath -PreviousLength $logLengthBefore

  $firstParty = (Invoke-RestMethod -Method Get -Uri "$baseUrl/api/v1/party" -TimeoutSec 5).data
  if (
    -not $firstParty.enabled -or
    [string]::IsNullOrWhiteSpace([string]$firstParty.sessionId) -or
    @($firstParty.urls).Count -lt 1
  ) {
    throw 'First launch did not create an active LAN Party session'
  }
  $firstLanUrl = [uri]@($firstParty.urls)[0]
  if (
    $firstLanUrl.Host -in @('127.0.0.1', 'localhost', '::1') -or
    $firstLanUrl.Port -ne 4174 -or
    -not $firstLanUrl.Fragment.StartsWith('#join=')
  ) {
    throw 'First launch did not return a usable LAN fragment URL'
  }
  $firstSessionId = [string]$firstParty.sessionId
  $firstJoinToken = [uri]::UnescapeDataString($firstLanUrl.Fragment.Substring(6))
  if ([string]::IsNullOrWhiteSpace($firstJoinToken)) {
    throw 'First LAN fragment did not contain an in-memory join credential'
  }

  $joinBody = @{
    displayName = 'Installed Smoke'
    joinToken = $firstJoinToken
  } | ConvertTo-Json -Compress
  $joined = (Invoke-RestMethod `
    -Method Post `
    -Uri "$baseUrl/api/v1/party/join" `
    -ContentType 'application/json' `
    -Body $joinBody `
    -TimeoutSec 5).data
  $oldBearer = [string]$joined.token
  if ([string]::IsNullOrWhiteSpace($oldBearer)) {
    throw 'Join did not return an in-memory bearer'
  }

  $secondLauncher = Start-Launcher
  try {
    if (-not $secondLauncher.WaitForExit(35000)) {
      throw 'Second launcher did not exit after rotating the existing station'
    }
    if ($secondLauncher.ExitCode -ne 0) {
      throw "Second launcher exited with $($secondLauncher.ExitCode)"
    }
  } finally {
    $secondLauncher.Dispose()
  }

  $rotationDeadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    $secondParty = (Invoke-RestMethod -Method Get -Uri "$baseUrl/api/v1/party" -TimeoutSec 5).data
    if ([string]$secondParty.sessionId -ne $firstSessionId) { break }
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $rotationDeadline)
  if ([string]$secondParty.sessionId -eq $firstSessionId) {
    throw 'Second launch did not rotate the launch session'
  }

  $oldBearerStatus = 0
  try {
    Invoke-WebRequest `
      -UseBasicParsing `
      -Uri "$baseUrl/api/v1/party/suggestions?q=smoke" `
      -Headers @{ Authorization = "Bearer $oldBearer" } `
      -TimeoutSec 5 | Out-Null
    $oldBearerStatus = 200
  } catch {
    if ($null -ne $_.Exception.Response) {
      $oldBearerStatus = [int]$_.Exception.Response.StatusCode
    } else {
      throw
    }
  }
  if ($oldBearerStatus -ne 401) {
    throw "Old bearer returned HTTP $oldBearerStatus instead of 401"
  }

  $listeners = @(
    Get-NetTCPConnection -State Listen -LocalPort 4173,4174 -ErrorAction Stop
  )
  $port4173 = @($listeners | Where-Object LocalPort -eq 4173)
  $port4174 = @($listeners | Where-Object LocalPort -eq 4174)
  $ownerPids = @($listeners.OwningProcess | Sort-Object -Unique)
  if ($port4173.Count -ne 1 -or $port4174.Count -ne 1 -or $ownerPids.Count -ne 1) {
    throw 'Expected exactly one shared listener owner for ports 4173 and 4174'
  }
  $nodeProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($ownerPids[0])"
  if ($null -eq $nodeProcess) {
    throw 'Unable to inspect the bundled Node listener owner'
  }
  $actualNodePath = [System.IO.Path]::GetFullPath([string]$nodeProcess.ExecutablePath)
  if (-not $actualNodePath.Equals($bundledNodePath, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Ports 4173/4174 are not owned by the installed bundled Node'
  }

  if (-not (Test-Path -LiteralPath $logPath -PathType Leaf)) {
    throw 'Installed launcher log was not created'
  }
  $logText = Get-Content -Raw -LiteralPath $logPath
  foreach ($secretValue in @(
    [string]$firstParty.pin,
    $firstJoinToken,
    $oldBearer,
    [string]$firstParty.joinPath
  )) {
    if (-not [string]::IsNullOrEmpty($secretValue) -and $logText.Contains($secretValue)) {
      throw 'Installed launcher log contains a Party credential'
    }
  }

  Invoke-Shutdown
  $shutdownCompleted = $true
  Wait-PortsClosed
  if (-not $primaryLauncher.WaitForExit(5000)) {
    throw 'Primary installed launcher remained after --shutdown'
  }

  $result = [pscustomobject]@{
    InstallDir = $resolvedInstallDir
    PathWithoutNode = 'PASS'
    FirstLanFragment = 'PASS'
    InMemoryJoin = 'PASS'
    SecondLaunchRotation = 'PASS'
    OldBearerRevoked401 = 'PASS'
    SingleBundledNodeOwner = 'PASS'
    SecretLogScan = 'PASS'
    ShutdownAndPortsClosed = 'PASS'
    ContainmentGuard = 'PASS'
    RuntimeArchitecture = $runtimeArchitecture
  } | ConvertTo-Json
  Write-Output $result
} finally {
  if (-not $shutdownCompleted) {
    try {
      Invoke-Shutdown
      Wait-PortsClosed
    } catch {
      Write-Error 'Installed smoke cleanup could not confirm launcher shutdown'
    }
  }
  if ($null -ne $primaryLauncher) {
    $primaryLauncher.Dispose()
  }
}
