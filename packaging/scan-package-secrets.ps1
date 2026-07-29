param(
  [string[]]$AdditionalPath = @()
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$packagingDir = Split-Path -Parent $PSCommandPath
$projectDir = [System.IO.Path]::GetFullPath((Join-Path $packagingDir '..'))
$projectPrefix = $projectDir.TrimEnd('\') + '\'
$knownSecretHashes = @(
  '6E4CA28D6ED3CC991CB368642609E33949BE263CED0BF1C50A270E5F6224EF38'
)
$textExtensions = [System.Collections.Generic.HashSet[string]]::new(
  [System.StringComparer]::OrdinalIgnoreCase
)
foreach ($extension in @(
  '.bat', '.cjs', '.cmd', '.config', '.cs', '.css', '.env', '.html', '.ini',
  '.iss', '.js', '.json', '.jsx', '.log', '.map', '.md', '.mjs', '.properties',
  '.ps1', '.svg', '.ts', '.tsx', '.txt', '.xml', '.yaml', '.yml'
)) {
  $null = $textExtensions.Add($extension)
}
$candidatePaths = [System.Collections.Generic.HashSet[string]]::new(
  [System.StringComparer]::OrdinalIgnoreCase
)

function Get-AsciiSha256 {
  param([string]$Value)
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::ASCII.GetBytes($Value)
    return ([System.BitConverter]::ToString($sha256.ComputeHash($bytes))).Replace('-', '')
  } finally {
    $sha256.Dispose()
  }
}

function Assert-ProjectPath {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) {
    throw 'Secret scan path must be non-empty'
  }
  $resolved = [System.IO.Path]::GetFullPath($Path)
  if (-not $resolved.StartsWith($projectPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Secret scan path escaped the project: $resolved"
  }
  $quarantinePrefix = (Join-Path $projectDir '.secrets').TrimEnd('\') + '\'
  if ($resolved.StartsWith($quarantinePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Secret quarantine must never be used as a package scan input'
  }
  return $resolved
}

function Add-CandidateFile {
  param([string]$Path)
  if (Test-Path -LiteralPath $Path -PathType Leaf) {
    $null = $candidatePaths.Add([System.IO.Path]::GetFullPath($Path))
  }
}

function Add-CandidateTree {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return }
  $resolvedRoot = Assert-ProjectPath -Path $Path
  foreach ($file in Get-ChildItem -LiteralPath $resolvedRoot -Recurse -File -Force) {
    if (($file.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
    $null = $candidatePaths.Add($file.FullName)
  }
}

foreach ($relativeRoot in @(
  'release',
  'server',
  'dist',
  'public\icons'
)) {
  Add-CandidateTree -Path (Join-Path $projectDir $relativeRoot)
}

foreach ($relativeFile in @(
  'package.json',
  'package-lock.json',
  'packaging\KaraokeStation.iss',
  'packaging\KaraokeStation-Windows7.iss',
  'packaging\THIRD-PARTY-NOTICES.txt',
  'packaging\launcher\Program.cs',
  'packaging\runtime\package.json',
  'packaging\runtime\package-lock.json'
)) {
  Add-CandidateFile -Path (Join-Path $projectDir $relativeFile)
}

foreach ($path in $AdditionalPath) {
  $resolved = Assert-ProjectPath -Path $path
  if (Test-Path -LiteralPath $resolved -PathType Container) {
    Add-CandidateTree -Path $resolved
  } elseif (Test-Path -LiteralPath $resolved -PathType Leaf) {
    Add-CandidateFile -Path $resolved
  } else {
    throw "Additional secret scan path does not exist: $resolved"
  }
}

foreach ($log in Get-ChildItem -LiteralPath $projectDir -Recurse -File -Filter '*.log' -Force) {
  if (
    $log.FullName -like "$projectPrefix`node_modules\*" -or
    $log.FullName -like "$projectPrefix`.secrets\*"
  ) {
    continue
  }
  $null = $candidatePaths.Add($log.FullName)
}

$googleApiKeyPattern = [regex]::new(
  '(?<![0-9A-Za-z_-])AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])',
  [System.Text.RegularExpressions.RegexOptions]::CultureInvariant
)
$patternScannedCount = 0
foreach ($filePath in $candidatePaths) {
  $file = Get-Item -LiteralPath $filePath -Force
  if ($file.Length -gt 128MB) {
    throw "Package secret scan refuses oversized input: $($file.FullName)"
  }
  $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
  if ($knownSecretHashes -contains $hash) {
    throw "Known quarantined secret hash found in package surface: $($file.FullName)"
  }
  $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
  $candidateMatches = @()
  foreach ($decoded in @(
    [System.Text.Encoding]::ASCII.GetString($bytes),
    [System.Text.Encoding]::Unicode.GetString($bytes),
    [System.Text.Encoding]::BigEndianUnicode.GetString($bytes)
  )) {
    $candidateMatches += @($googleApiKeyPattern.Matches($decoded))
  }
  foreach ($candidateMatch in $candidateMatches) {
    $candidateHash = Get-AsciiSha256 -Value $candidateMatch.Value
    if ($knownSecretHashes -contains $candidateHash) {
      throw "Known quarantined secret found embedded in package surface: $($file.FullName)"
    }
  }
  $extension = [System.IO.Path]::GetExtension($file.Name)
  $isTextCandidate = $textExtensions.Contains($extension) -or
    $file.Name.Equals('.env', [System.StringComparison]::OrdinalIgnoreCase)
  if ($isTextCandidate) {
    $patternScannedCount++
    if ($candidateMatches.Count -gt 0) {
      throw "Google API key pattern found in package text surface: $($file.FullName)"
    }
  }
}

[pscustomobject]@{
  Status = 'PASS'
  FilesScanned = $candidatePaths.Count
  TextFilesPatternScanned = $patternScannedCount
  KnownSecretHashes = $knownSecretHashes.Count
} | ConvertTo-Json
