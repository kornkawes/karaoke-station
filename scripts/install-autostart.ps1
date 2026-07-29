$ErrorActionPreference = "Stop"
$projectDir = Split-Path -Parent $PSScriptRoot
$startupDir = [Environment]::GetFolderPath("Startup")
$shortcutPath = Join-Path $startupDir "KaraokeStation.lnk"

if (Test-Path -LiteralPath $shortcutPath) {
    throw "มี shortcut อยู่แล้วที่ $shortcutPath กรุณาตรวจสอบก่อนเพื่อไม่ให้เขียนทับ"
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = "powershell.exe"
$shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$projectDir\scripts\start-kiosk.ps1`""
$shortcut.WorkingDirectory = $projectDir
$shortcut.Description = "Start KaraokeStation in kiosk mode"
$shortcut.Save()

Write-Host "เพิ่ม KaraokeStation ใน Startup แล้ว: $shortcutPath" -ForegroundColor Green

