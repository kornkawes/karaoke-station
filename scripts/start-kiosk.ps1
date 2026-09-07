$ErrorActionPreference = "Stop"
$projectDir = Split-Path -Parent $PSScriptRoot
$appUrl = "http://127.0.0.1:4173"
$healthUrl = "$appUrl/api/v1/health"
$logDir = if ($env:LOCALAPPDATA) {
    Join-Path $env:LOCALAPPDATA "KaraokeStation\logs"
} else {
    Join-Path $projectDir "data\logs"
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$serverReady = $false
try {
    $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
    $serverReady = $health.data.status -eq "ok"
} catch {
    $serverReady = $false
}

if (-not $serverReady) {
    $stdoutPath = Join-Path $logDir "server.log"
    $stderrPath = Join-Path $logDir "server-error.log"
    Start-Process -FilePath "node" `
        -ArgumentList "server/index.js" `
        -WorkingDirectory $projectDir `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath

    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Seconds 1
        try {
            $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
            if ($health.data.status -eq "ok") {
                $serverReady = $true
                break
            }
        } catch {
            $serverReady = $false
        }
    }
}

if (-not $serverReady) {
    throw "KaraokeStation server ไม่พร้อม กรุณาดู log ที่ $logDir"
}

$browserCandidates = @(
    (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"),
    (Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe"),
    (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe")
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

if ($browserCandidates.Count -gt 0) {
    Start-Process -FilePath $browserCandidates[0] `
        -ArgumentList "--app=$appUrl", "--start-fullscreen", "--disable-session-crashed-bubble"
} else {
    Start-Process $appUrl
}

