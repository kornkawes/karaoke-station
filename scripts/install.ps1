$ErrorActionPreference = "Stop"
$projectDir = Split-Path -Parent $PSScriptRoot

Write-Host "KaraokeStation - installing dependencies" -ForegroundColor Cyan

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    throw "ไม่พบ Node.js กรุณาติดตั้ง Node.js 20.19 หรือใหม่กว่า แล้วรันสคริปต์อีกครั้ง"
}

$nodeVersionText = (& node -p "process.versions.node").Trim()
$nodeMajor = [int]($nodeVersionText.Split(".")[0])
if ($nodeMajor -lt 20) {
    throw "Node.js $nodeVersionText เก่าเกินไป ต้องใช้ 20.19 หรือใหม่กว่า"
}

Push-Location $projectDir
try {
    if (-not (Test-Path -LiteralPath (Join-Path $projectDir ".env"))) {
        Copy-Item -LiteralPath (Join-Path $projectDir ".env.example") -Destination (Join-Path $projectDir ".env")
        Write-Host "สร้าง .env แล้ว — ใส่ YOUTUBE_API_KEY เมื่อต้องการค้นหาเพลง" -ForegroundColor Yellow
    }
    & npm ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm ci ไม่สำเร็จ" }
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build ไม่สำเร็จ" }
    & npm run test:server
    if ($LASTEXITCODE -ne 0) { throw "backend tests ไม่ผ่าน" }
} finally {
    Pop-Location
}

Write-Host "ติดตั้งสำเร็จ รัน npm run start:kiosk เพื่อเปิดใช้งาน" -ForegroundColor Green

