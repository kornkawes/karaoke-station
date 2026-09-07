param(
  [switch]$SkipTests,
  [switch]$KeepStage
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$nodeVersion = '22.23.1'
$nodeArtifacts = @(
  @{
    Architecture = 'win-x64'
    ZipHash = '7df0bc9375723f4a86b3aa1b7cc73342423d9677a8df4538aca31a049e309c29'
    NodeHash = 'f8d162c0641dcee512132f3bcf8a68169c7ecb852efd8e1a46c9fec5a0f469ed'
  },
  @{
    Architecture = 'win-x86'
    ZipHash = 'e298b368aad86c571447a3650db3ce19063373ffd39d6d73d014a5d9ad31dc62'
    NodeHash = 'b1c3e891f327f59594345068505b052da6c93dbb19e5e5af631202eeb0c4015b'
  }
)
$scriptDir = Split-Path -Parent $PSCommandPath
$projectDir = [System.IO.Path]::GetFullPath((Join-Path $scriptDir '..'))
$packagingDir = Join-Path $projectDir 'packaging'
$stageDir = [System.IO.Path]::GetFullPath((Join-Path $packagingDir '.stage'))
$cacheDir = [System.IO.Path]::GetFullPath((Join-Path $packagingDir '.cache'))
$releaseDir = [System.IO.Path]::GetFullPath((Join-Path $projectDir 'release'))
$stageAppDir = Join-Path $stageDir 'app'
$nodeExtractDir = Join-Path $stageDir 'node-extract'
$iscc = Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$frameworkDir = Split-Path -Parent $csc
$installerPath = Join-Path $releaseDir 'KaraokeStation-Setup.exe'

function Assert-ChildPath {
  param([string]$Path, [string]$Parent)
  if ([string]::IsNullOrWhiteSpace($Path) -or [string]::IsNullOrWhiteSpace($Parent)) {
    throw 'Destructive path and parent must be non-empty'
  }
  $resolvedPath = [System.IO.Path]::GetFullPath($Path)
  $resolvedParent = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
  if (-not $resolvedPath.StartsWith($resolvedParent, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe path outside expected parent: $resolvedPath"
  }
}

function Assert-FileHash {
  param([string]$Path, [string]$Expected, [string]$Label)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Label not found: $Path"
  }
  $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $Expected) {
    throw "$Label SHA256 mismatch. Expected $Expected, received $actual"
  }
}

function New-PngIcon {
  param([string]$PngPath, [string]$IconPath)
  $png = [System.IO.File]::ReadAllBytes($PngPath)
  $stream = [System.IO.File]::Open($IconPath, [System.IO.FileMode]::Create)
  try {
    $writer = [System.IO.BinaryWriter]::new($stream)
    try {
      $writer.Write([uint16]0)
      $writer.Write([uint16]1)
      $writer.Write([uint16]1)
      $writer.Write([byte]0)
      $writer.Write([byte]0)
      $writer.Write([byte]0)
      $writer.Write([byte]0)
      $writer.Write([uint16]1)
      $writer.Write([uint16]32)
      $writer.Write([uint32]$png.Length)
      $writer.Write([uint32]22)
      $writer.Write($png)
    } finally {
      $writer.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

Assert-ChildPath -Path $stageDir -Parent $packagingDir
Assert-ChildPath -Path $cacheDir -Parent $packagingDir
if (-not (Test-Path -LiteralPath $iscc -PathType Leaf)) {
  throw "Inno Setup compiler not found: $iscc"
}
if (-not (Test-Path -LiteralPath $csc -PathType Leaf)) {
  throw "64-bit C# compiler not found: $csc"
}
if (-not (Test-Path -LiteralPath (Join-Path $packagingDir 'runtime\package-lock.json'))) {
  throw 'packaging/runtime/package-lock.json is required for a reproducible production install'
}

if (-not $SkipTests) {
  & npm.cmd test
  if ($LASTEXITCODE -ne 0) { throw 'npm test failed' }
}
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'npm run build failed' }

if (Test-Path -LiteralPath $stageDir) {
  Remove-Item -LiteralPath $stageDir -Recurse -Force
}
New-Item -ItemType Directory -Path $stageAppDir -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stageDir 'runtime') -Force | Out-Null
New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null
New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null

foreach ($artifact in $nodeArtifacts) {
  $architecture = $artifact.Architecture
  $nodeZip = Join-Path $cacheDir "node-v$nodeVersion-$architecture.zip"
  $nodeDownloadUrl = "https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-$architecture.zip"
  if (-not (Test-Path -LiteralPath $nodeZip -PathType Leaf)) {
    Invoke-WebRequest -Uri $nodeDownloadUrl -OutFile $nodeZip
  }
  Assert-FileHash -Path $nodeZip -Expected $artifact.ZipHash -Label "Official Node $architecture zip"

  $architectureExtractDir = Join-Path $nodeExtractDir $architecture
  Expand-Archive -LiteralPath $nodeZip -DestinationPath $architectureExtractDir
  $extractedRoot = Join-Path $architectureExtractDir "node-v$nodeVersion-$architecture"
  $extractedNode = Join-Path $extractedRoot 'node.exe'
  Assert-FileHash -Path $extractedNode -Expected $artifact.NodeHash -Label "Extracted $architecture node.exe"
  $runtimeArchitectureDir = Join-Path (Join-Path $stageDir 'runtime') $architecture
  New-Item -ItemType Directory -Path $runtimeArchitectureDir -Force | Out-Null
  Copy-Item -LiteralPath $extractedNode -Destination (Join-Path $runtimeArchitectureDir 'node.exe')
  if ($architecture -eq 'win-x64') {
    Copy-Item -LiteralPath (Join-Path $extractedRoot 'LICENSE') -Destination (Join-Path $stageDir 'runtime\LICENSE-node.txt')
  }
}

Copy-Item -LiteralPath (Join-Path $projectDir 'server') -Destination (Join-Path $stageAppDir 'server') -Recurse
Copy-Item -LiteralPath (Join-Path $projectDir 'dist') -Destination (Join-Path $stageAppDir 'dist') -Recurse
Copy-Item -LiteralPath (Join-Path $packagingDir 'runtime\package.json') -Destination (Join-Path $stageAppDir 'package.json')
Copy-Item -LiteralPath (Join-Path $packagingDir 'runtime\package-lock.json') -Destination (Join-Path $stageAppDir 'package-lock.json')
Copy-Item -LiteralPath (Join-Path $packagingDir 'THIRD-PARTY-NOTICES.txt') -Destination (Join-Path $stageDir 'THIRD-PARTY-NOTICES.txt')

& npm.cmd ci --omit=dev --ignore-scripts --no-audit --no-fund --prefix $stageAppDir
if ($LASTEXITCODE -ne 0) { throw 'Production runtime npm ci failed' }
$runtimeBinDir = Join-Path $stageAppDir 'node_modules\.bin'
if (Test-Path -LiteralPath $runtimeBinDir) {
  Assert-ChildPath -Path $runtimeBinDir -Parent $stageAppDir
  Remove-Item -LiteralPath $runtimeBinDir -Recurse -Force
}

$iconPath = Join-Path $stageDir 'KaraokeStation.ico'
New-PngIcon `
  -PngPath (Join-Path $projectDir 'public\icons\karaoke-station-256.png') `
  -IconPath $iconPath
$launcherPath = Join-Path $stageDir 'KaraokeStation.exe'
$compilerArguments = @(
  '/nologo',
  '/target:winexe',
  '/platform:anycpu',
  '/optimize+',
  "/out:$launcherPath",
  "/win32icon:$iconPath",
  "/reference:$(Join-Path $frameworkDir 'System.dll')",
  "/reference:$(Join-Path $frameworkDir 'System.Core.dll')",
  "/reference:$(Join-Path $frameworkDir 'System.Net.Http.dll')",
  "/reference:$(Join-Path $frameworkDir 'System.Windows.Forms.dll')",
  (Join-Path $packagingDir 'launcher\Program.cs')
)
& $csc $compilerArguments
if ($LASTEXITCODE -ne 0) { throw 'C# launcher compilation failed' }

Assert-ChildPath -Path $nodeExtractDir -Parent $stageDir
Remove-Item -LiteralPath $nodeExtractDir -Recurse -Force

$prePackageSecretScan = & powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File (Join-Path $packagingDir 'scan-package-secrets.ps1') `
  -AdditionalPath $stageDir
if ($LASTEXITCODE -ne 0) { throw 'Pre-package secret scan failed' }
$prePackageSecretScan

$package = Get-Content -Raw -LiteralPath (Join-Path $projectDir 'package.json') | ConvertFrom-Json
& $iscc `
  "/DStageDir=$stageDir" `
  "/DReleaseDir=$releaseDir" `
  "/DAppVersion=$($package.version)" `
  (Join-Path $packagingDir 'KaraokeStation.iss')
if ($LASTEXITCODE -ne 0) { throw 'Inno Setup compilation failed' }

$secretScan = & powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File (Join-Path $packagingDir 'scan-package-secrets.ps1') `
  -AdditionalPath $stageDir
if ($LASTEXITCODE -ne 0) { throw 'Post-package secret scan failed' }
$secretScan

$verification = & powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File (Join-Path $packagingDir 'verify-package.ps1') `
  -StageDir $stageDir `
  -InstallerPath $installerPath
if ($LASTEXITCODE -ne 0) { throw 'Package verification failed' }
$verification

if (-not $KeepStage) {
  Assert-ChildPath -Path $stageDir -Parent $packagingDir
  Remove-Item -LiteralPath $stageDir -Recurse -Force
}

Write-Host "Built installer: $installerPath"
