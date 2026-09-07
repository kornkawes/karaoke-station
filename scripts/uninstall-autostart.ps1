$ErrorActionPreference = "Stop"
$startupDir = [Environment]::GetFolderPath("Startup")
$shortcutPath = Join-Path $startupDir "KaraokeStation.lnk"

if (Test-Path -LiteralPath $shortcutPath) {
    Remove-Item -LiteralPath $shortcutPath
    Write-Host "นำ KaraokeStation ออกจาก Startup แล้ว" -ForegroundColor Green
} else {
    Write-Host "ไม่พบ KaraokeStation ใน Startup จึงไม่มีสิ่งที่ต้องลบ" -ForegroundColor Yellow
}

