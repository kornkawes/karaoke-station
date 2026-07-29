param(
  [Parameter(Mandatory = $true)]
  [string]$StageDir,
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath
)

$ErrorActionPreference = 'Stop'
$expectedNodeHashes = @{
  'win-x64' = 'b014e4ec5ca810b2fb54cdbf6ab8d6acc488285c98469606efb8b412472bec2a'
  'win-x86' = 'd8e21b6590e2542949e8abac1903665871ca3bc426da59c3d3fa37476e18439f'
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
  (Join-Path $stage 'app\server\index.cjs'),
  (Join-Path $stage 'app\dist\index.html')
)
foreach ($path in $required) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Missing staged Windows 7 file: $path"
  }
}
if (Test-Path -LiteralPath (Join-Path $stage 'app\node_modules')) {
  throw 'Windows 7 stage must use the standalone server bundle, not node_modules'
}

$nodeHashes = @{}
$nodeSignatures = @{}
$nodeVersions = @{}
foreach ($architecture in $expectedNodeHashes.Keys) {
  $nodePath = Join-Path $stage "runtime\$architecture\node.exe"
  $nodeHash = (Get-FileHash -LiteralPath $nodePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($nodeHash -ne $expectedNodeHashes[$architecture]) {
    throw "Bundled Windows 7 $architecture node.exe SHA256 mismatch: $nodeHash"
  }
  $signature = Get-AuthenticodeSignature -LiteralPath $nodePath
  if ($signature.Status -ne 'Valid') {
    throw "Bundled Windows 7 $architecture node.exe Authenticode is $($signature.Status)"
  }
  $nodeVersion = (& $nodePath --version).Trim()
  if ($LASTEXITCODE -ne 0 -or $nodeVersion -ne 'v12.22.12') {
    throw "Bundled Windows 7 $architecture node.exe version is $nodeVersion"
  }
  $nodeHashes[$architecture] = $nodeHash
  $nodeSignatures[$architecture] = [string]$signature.Status
  $nodeVersions[$architecture] = $nodeVersion
}

if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
  throw "Windows 7 installer not found: $installer"
}
if ((Get-Item -LiteralPath $installer).Length -lt 1MB) {
  throw 'Windows 7 installer is unexpectedly small'
}
$launcherSignature = Get-AuthenticodeSignature -LiteralPath (Join-Path $stage 'KaraokeStation.exe')
if ($launcherSignature.Status -notin @('Valid', 'NotSigned')) {
  throw "Launcher Authenticode status is unexpected: $($launcherSignature.Status)"
}

[pscustomobject]@{
  Installer = $installer
  InstallerSha256 = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
  InstallerBytes = (Get-Item -LiteralPath $installer).Length
  NodeVersion = $nodeVersions
  NodeSha256 = $nodeHashes
  NodeAuthenticode = $nodeSignatures
  LauncherAuthenticode = [string]$launcherSignature.Status
  ServerBundleBytes = (Get-Item -LiteralPath (Join-Path $stage 'app\server\index.cjs')).Length
  VerifiedAt = (Get-Date).ToString('o')
} | ConvertTo-Json
