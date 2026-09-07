param(
  [Parameter(Mandatory = $true)]
  [string]$StageDir,
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath
)

$ErrorActionPreference = 'Stop'
$expectedNodeHashes = @{
  'win-x64' = 'f8d162c0641dcee512132f3bcf8a68169c7ecb852efd8e1a46c9fec5a0f469ed'
  'win-x86' = 'b1c3e891f327f59594345068505b052da6c93dbb19e5e5af631202eeb0c4015b'
}
$stage = [System.IO.Path]::GetFullPath($StageDir)
$installer = [System.IO.Path]::GetFullPath($InstallerPath)

$required = @(
  (Join-Path $stage 'KaraokeStation.exe'),
  (Join-Path $stage 'KaraokeStation.ico'),
  (Join-Path $stage 'runtime\win-x64\node.exe'),
  (Join-Path $stage 'runtime\win-x86\node.exe'),
  (Join-Path $stage 'runtime\LICENSE-node.txt'),
  (Join-Path $stage 'THIRD-PARTY-NOTICES.txt'),
  (Join-Path $stage 'app\server\index.js'),
  (Join-Path $stage 'app\dist\index.html'),
  (Join-Path $stage 'app\node_modules\express\package.json'),
  (Join-Path $stage 'app\package-lock.json')
)
foreach ($path in $required) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Missing staged file: $path"
  }
}

$nodeHashes = @{}
$nodeSignatures = @{}
foreach ($architecture in $expectedNodeHashes.Keys) {
  $nodePath = Join-Path $stage "runtime\$architecture\node.exe"
  $nodeHash = (Get-FileHash -LiteralPath $nodePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($nodeHash -ne $expectedNodeHashes[$architecture]) {
    throw "Bundled $architecture node.exe SHA256 mismatch: $nodeHash"
  }
  $signature = Get-AuthenticodeSignature -LiteralPath $nodePath
  if ($signature.Status -ne 'Valid') {
    throw "Bundled $architecture node.exe Authenticode is $($signature.Status)"
  }
  $nodeHashes[$architecture] = $nodeHash
  $nodeSignatures[$architecture] = [string]$signature.Status
}

$forbiddenPackages = @(
  '@playwright',
  '@vitejs',
  'react',
  'react-dom',
  'socket.io-client',
  'vite',
  'vitest',
  'jsdom',
  'npm'
)
foreach ($package in $forbiddenPackages) {
  $packagePath = Join-Path (Join-Path $stage 'app\node_modules') $package
  if (Test-Path -LiteralPath $packagePath) {
    throw "Forbidden browser/dev package found in runtime: $package"
  }
}
if (Test-Path -LiteralPath (Join-Path $stage 'app\node_modules\.bin')) {
  $binFiles = @(Get-ChildItem -LiteralPath (Join-Path $stage 'app\node_modules\.bin') -Force)
  if ($binFiles.Count -gt 0) {
    throw 'Runtime stage contains package executables under node_modules\.bin'
  }
}

if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
  throw "Installer not found: $installer"
}
if ((Get-Item -LiteralPath $installer).Length -lt 1MB) {
  throw 'Installer is unexpectedly small'
}
$launcherSignature = Get-AuthenticodeSignature -LiteralPath (Join-Path $stage 'KaraokeStation.exe')
if ($launcherSignature.Status -notin @('Valid', 'NotSigned')) {
  throw "Launcher Authenticode status is unexpected: $($launcherSignature.Status)"
}

[pscustomobject]@{
  Installer = $installer
  InstallerSha256 = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
  InstallerBytes = (Get-Item -LiteralPath $installer).Length
  NodeSha256 = $nodeHashes
  NodeAuthenticode = $nodeSignatures
  LauncherAuthenticode = [string]$launcherSignature.Status
  RuntimePackageCount = @(Get-ChildItem -LiteralPath (Join-Path $stage 'app\node_modules') -Directory).Count
  VerifiedAt = (Get-Date).ToString('o')
} | ConvertTo-Json
