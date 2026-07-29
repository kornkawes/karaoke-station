param(
  [switch]$SkipTests,
  [switch]$KeepStage
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.IO.Compression.FileSystem

$nodeVersion = '12.22.12'
$nodeArtifacts = @(
  @{
    Architecture = 'win-x64'
    ZipHash = '09639bac66d4dc4dd52179968209413ad4b7360e917dcbe8834052a4b936a087'
    NodeHash = 'b014e4ec5ca810b2fb54cdbf6ab8d6acc488285c98469606efb8b412472bec2a'
  },
  @{
    Architecture = 'win-x86'
    ZipHash = '2f7fa563c9477d5e9fddc5c22451b21b8a963c9b5004c80dd0140c3a3675a4e8'
    NodeHash = 'd8e21b6590e2542949e8abac1903665871ca3bc426da59c3d3fa37476e18439f'
  }
)
$scriptDir = Split-Path -Parent $PSCommandPath
$projectDir = [System.IO.Path]::GetFullPath((Join-Path $scriptDir '..'))
$packagingDir = Join-Path $projectDir 'packaging'
$stageDir = [System.IO.Path]::GetFullPath((Join-Path $packagingDir '.stage-windows7'))
$cacheDir = [System.IO.Path]::GetFullPath((Join-Path $packagingDir '.cache'))
$releaseDir = [System.IO.Path]::GetFullPath((Join-Path $projectDir 'release'))
$stageAppDir = Join-Path $stageDir 'app'
$iscc = Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$frameworkDir = Split-Path -Parent $csc
$installerPath = Join-Path $releaseDir 'KaraokeStation-Windows7-Setup.exe'

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

if (-not $SkipTests) {
  & npm.cmd test
  if ($LASTEXITCODE -ne 0) { throw 'npm test failed' }
}
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'npm run build failed' }

if (Test-Path -LiteralPath $stageDir) {
  Remove-Item -LiteralPath $stageDir -Recurse -Force
}
New-Item -ItemType Directory -Path (Join-Path $stageAppDir 'server') -Force | Out-Null
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

  $runtimeArchitectureDir = Join-Path (Join-Path $stageDir 'runtime') $architecture
  New-Item -ItemType Directory -Path $runtimeArchitectureDir -Force | Out-Null
  $nodeDestination = Join-Path $runtimeArchitectureDir 'node.exe'
  $archive = [System.IO.Compression.ZipFile]::OpenRead($nodeZip)
  try {
    $archiveRoot = "node-v$nodeVersion-$architecture/"
    $nodeEntry = $archive.GetEntry("${archiveRoot}node.exe")
    if ($null -eq $nodeEntry) {
      throw "Official Node $architecture zip does not contain node.exe"
    }
    [System.IO.Compression.ZipFileExtensions]::ExtractToFile(
      $nodeEntry,
      $nodeDestination,
      $true
    )
    if ($architecture -eq 'win-x64') {
      $licenseEntry = $archive.GetEntry("${archiveRoot}LICENSE")
      if ($null -eq $licenseEntry) {
        throw 'Official Node x64 zip does not contain LICENSE'
      }
      [System.IO.Compression.ZipFileExtensions]::ExtractToFile(
        $licenseEntry,
        (Join-Path $stageDir 'runtime\LICENSE-node.txt'),
        $true
      )
    }
  } finally {
    $archive.Dispose()
  }
  Assert-FileHash -Path $nodeDestination -Expected $artifact.NodeHash -Label "Extracted $architecture node.exe"
}

Copy-Item -LiteralPath (Join-Path $projectDir 'dist') -Destination (Join-Path $stageAppDir 'dist') -Recurse
Copy-Item -LiteralPath (Join-Path $packagingDir 'THIRD-PARTY-NOTICES.txt') -Destination (Join-Path $stageDir 'THIRD-PARTY-NOTICES.txt')
& node.exe (Join-Path $scriptDir 'build-legacy-server.mjs') (Join-Path $stageAppDir 'server\index.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Node 12 server bundle failed' }

$iconPath = Join-Path $stageDir 'KaraokeStation.ico'
New-PngIcon `
  -PngPath (Join-Path $projectDir 'public\icons\karaoke-station-256.png') `
  -IconPath $iconPath
$launcherPath = Join-Path $stageDir 'KaraokeStation.exe'
$compilerArguments = @(
  '/nologo',
  '/target:winexe',
  '/platform:anycpu',
  '/define:WINDOWS7_LEGACY',
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
  (Join-Path $packagingDir 'KaraokeStation-Windows7.iss')
if ($LASTEXITCODE -ne 0) { throw 'Inno Setup compilation failed' }

$secretScan = & powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File (Join-Path $packagingDir 'scan-package-secrets.ps1') `
  -AdditionalPath $stageDir
if ($LASTEXITCODE -ne 0) { throw 'Post-package secret scan failed' }
$secretScan

$verification = & powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File (Join-Path $packagingDir 'verify-windows7-package.ps1') `
  -StageDir $stageDir `
  -InstallerPath $installerPath
if ($LASTEXITCODE -ne 0) { throw 'Windows 7 package verification failed' }
$verification

if (-not $KeepStage) {
  Assert-ChildPath -Path $stageDir -Parent $packagingDir
  Remove-Item -LiteralPath $stageDir -Recurse -Force
}

Write-Host "Built Windows 7 installer: $installerPath"
