$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$packagingDir = Split-Path -Parent $PSCommandPath
$projectDir = [System.IO.Path]::GetFullPath((Join-Path $packagingDir '..'))
$testDir = [System.IO.Path]::GetFullPath((Join-Path $packagingDir '.launcher-test'))
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$frameworkDir = Split-Path -Parent $csc

function Assert-PackagingChildPath {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) {
    throw 'Packaging cleanup path must be non-empty'
  }
  $resolvedPath = [System.IO.Path]::GetFullPath($Path)
  $resolvedParent = [System.IO.Path]::GetFullPath($packagingDir).TrimEnd('\') + '\'
  if (-not $resolvedPath.StartsWith($resolvedParent, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe packaging cleanup path: $resolvedPath"
  }
}

try {
  Assert-PackagingChildPath -Path $testDir
  $guardRejected = $false
  try {
    Assert-PackagingChildPath -Path $projectDir
  } catch {
    $guardRejected = $true
  }
  if (-not $guardRejected) {
    throw 'Packaging containment guard accepted a path outside packaging'
  }
  if (Test-Path -LiteralPath $testDir) {
    Remove-Item -LiteralPath $testDir -Recurse -Force
  }
  New-Item -ItemType Directory -Path $testDir | Out-Null

  $allParseErrors = @()
  foreach ($script in @(
    (Join-Path $projectDir 'scripts\build-installer.ps1'),
    (Join-Path $projectDir 'scripts\build-windows7-installer.ps1'),
    (Join-Path $packagingDir 'verify-package.ps1'),
    (Join-Path $packagingDir 'verify-windows7-package.ps1'),
    (Join-Path $packagingDir 'scan-package-secrets.ps1')
  )) {
    $tokens = $null
    $parseErrors = $null
    [System.Management.Automation.Language.Parser]::ParseFile(
      $script,
      [ref]$tokens,
      [ref]$parseErrors
    ) | Out-Null
    $allParseErrors += @($parseErrors)
  }
  if ($allParseErrors.Count -gt 0) {
    throw "Packaging PowerShell syntax errors: $($allParseErrors -join '; ')"
  }

  $launcherSource = Get-Content -Raw -LiteralPath (Join-Path $packagingDir 'launcher\Program.cs')
  foreach ($requiredSource in @(
    'Environment.Is64BitOperatingSystem',
    'JobObjectLimitKillOnJobClose',
    'AssignProcessToJobObject',
    'ServerEntryFileName',
    '#if WINDOWS7_LEGACY',
    '--disable-session-crashed-bubble',
    '"/api/v1/party/session/start"',
    'BaseUrl + "/display "'
  )) {
    if (-not $launcherSource.Contains($requiredSource)) {
      throw "Launcher source is missing required contract: $requiredSource"
    }
  }
  if ($launcherSource.Contains('/display?newSession=1')) {
    throw 'Launcher must not rotate the session twice through the display URL'
  }

  $launcherTestPath = Join-Path $testDir 'KaraokeStation.exe'
  & $csc `
    /nologo `
    /target:winexe `
    /platform:anycpu `
    /optimize+ `
    "/out:$launcherTestPath" `
    "/reference:$(Join-Path $frameworkDir 'System.dll')" `
    "/reference:$(Join-Path $frameworkDir 'System.Core.dll')" `
    "/reference:$(Join-Path $frameworkDir 'System.Net.Http.dll')" `
    "/reference:$(Join-Path $frameworkDir 'System.Windows.Forms.dll')" `
    (Join-Path $packagingDir 'launcher\Program.cs')
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $launcherTestPath)) {
    throw 'AnyCPU launcher compilation failed'
  }
  $legacyLauncherTestPath = Join-Path $testDir 'KaraokeStation-Windows7.exe'
  & $csc `
    /nologo `
    /target:winexe `
    /platform:anycpu `
    /define:WINDOWS7_LEGACY `
    /optimize+ `
    "/out:$legacyLauncherTestPath" `
    "/reference:$(Join-Path $frameworkDir 'System.dll')" `
    "/reference:$(Join-Path $frameworkDir 'System.Core.dll')" `
    "/reference:$(Join-Path $frameworkDir 'System.Net.Http.dll')" `
    "/reference:$(Join-Path $frameworkDir 'System.Windows.Forms.dll')" `
    (Join-Path $packagingDir 'launcher\Program.cs')
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $legacyLauncherTestPath)) {
    throw 'Windows 7 AnyCPU launcher compilation failed'
  }
  $modernLauncherStrings = [System.Text.Encoding]::Unicode.GetString(
    [System.IO.File]::ReadAllBytes($launcherTestPath)
  )
  $legacyLauncherStrings = [System.Text.Encoding]::Unicode.GetString(
    [System.IO.File]::ReadAllBytes($legacyLauncherTestPath)
  )
  if (-not $modernLauncherStrings.Contains('index.js') -or
      $modernLauncherStrings.Contains('index.cjs')) {
    throw 'Modern launcher does not select only index.js'
  }
  if (-not $legacyLauncherStrings.Contains('index.cjs') -or
      $legacyLauncherStrings.Contains('index.js')) {
    throw 'Windows 7 launcher does not select only index.cjs'
  }

  $installerSource = Get-Content -Raw -LiteralPath (Join-Path $packagingDir 'KaraokeStation.iss')
  foreach ($requiredInstallerText in @(
    'AppId={{8C5D031B-64E7-4F70-9894-8A3249E22C8A}',
    'PrivilegesRequired=lowest',
    'MinVersion=10.0',
    'Type: files; Name: "{app}\app\server\index.cjs"',
    'function InitializeSetup(): Boolean;',
    'Release >= 378389',
    'KaraokeStation ต้องใช้ Microsoft .NET Framework 4.5 หรือใหม่กว่า',
    'Name: "startup"',
    'function PrepareToInstall',
    'function InitializeUninstall'
  )) {
    if (-not $installerSource.Contains($requiredInstallerText)) {
      throw "Inno source is missing required contract: $requiredInstallerText"
    }
  }
  if ($installerSource.Contains('[UninstallDelete]')) {
    throw 'Installer must preserve LocalAppData KaraokeStation data'
  }

  $windows7InstallerSource = Get-Content -Raw -LiteralPath (
    Join-Path $packagingDir 'KaraokeStation-Windows7.iss'
  )
  foreach ($requiredInstallerText in @(
    'AppId={{8C5D031B-64E7-4F70-9894-8A3249E22C8A}',
    'PrivilegesRequired=lowest',
    'MinVersion=6.1sp1',
    'OnlyBelowVersion=10.0',
    'OutputBaseFilename=KaraokeStation-Windows7-Setup',
    'Type: files; Name: "{app}\app\server\index.js"',
    'function InitializeSetup(): Boolean;',
    'Release >= 378389',
    'KaraokeStation ต้องใช้ Microsoft .NET Framework 4.5 หรือใหม่กว่า',
    'function PrepareToInstall',
    'function InitializeUninstall'
  )) {
    if (-not $windows7InstallerSource.Contains($requiredInstallerText)) {
      throw "Windows 7 Inno source is missing required contract: $requiredInstallerText"
    }
  }
  if ($windows7InstallerSource.Contains('[UninstallDelete]')) {
    throw 'Windows 7 installer must preserve LocalAppData KaraokeStation data'
  }

  foreach ($scenario in @(
    @{
      Name = 'legacy-to-modern'
      InstallerSource = $installerSource
      StaleEntry = 'index.cjs'
      ExpectedEntry = 'index.js'
    },
    @{
      Name = 'modern-to-legacy'
      InstallerSource = $windows7InstallerSource
      StaleEntry = 'index.js'
      ExpectedEntry = 'index.cjs'
    }
  )) {
    $scenarioDir = Join-Path $testDir $scenario.Name
    New-Item -ItemType Directory -Path $scenarioDir -Force | Out-Null
    $stalePath = Join-Path $scenarioDir $scenario.StaleEntry
    $expectedPath = Join-Path $scenarioDir $scenario.ExpectedEntry
    [System.IO.File]::WriteAllText($stalePath, 'stale')
    [System.IO.File]::WriteAllText($expectedPath, 'current')
    $cleanupContract = "Type: files; Name: `"{app}\app\server\$($scenario.StaleEntry)`""
    if (-not $scenario.InstallerSource.Contains($cleanupContract)) {
      throw "$($scenario.Name) is missing scoped stale-entry cleanup"
    }
    Remove-Item -LiteralPath $stalePath -Force
    if ((Test-Path -LiteralPath $stalePath) -or
        -not (Test-Path -LiteralPath $expectedPath -PathType Leaf)) {
      throw "$($scenario.Name) cross-lane cleanup simulation failed"
    }
  }

  $windows7BuildSource = Get-Content -Raw -LiteralPath (
    Join-Path $projectDir 'scripts\build-windows7-installer.ps1'
  )
  foreach ($requiredBuildText in @(
    "`$nodeVersion = '12.22.12'",
    'b014e4ec5ca810b2fb54cdbf6ab8d6acc488285c98469606efb8b412472bec2a',
    'd8e21b6590e2542949e8abac1903665871ca3bc426da59c3d3fa37476e18439f',
    'KaraokeStation-Windows7-Setup.exe',
    'build-legacy-server.mjs'
  )) {
    if (-not $windows7BuildSource.Contains($requiredBuildText)) {
      throw "Windows 7 build is missing required contract: $requiredBuildText"
    }
  }

  $secretScanner = Join-Path $packagingDir 'scan-package-secrets.ps1'
  $secretScanOutput = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $secretScanner
  if ($LASTEXITCODE -ne 0) {
    throw 'Clean package secret scan failed'
  }
  $secretFixtureDir = Join-Path $testDir 'secret-scan'
  New-Item -ItemType Directory -Path $secretFixtureDir -Force | Out-Null
  $fakeSecret = 'AIza' + ('A' * 35)
  [System.IO.File]::WriteAllText((Join-Path $secretFixtureDir 'fixture.txt'), $fakeSecret)
  $previousErrorPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $blockedOutput = & powershell.exe -NoProfile -ExecutionPolicy Bypass `
      -File $secretScanner `
      -AdditionalPath $secretFixtureDir 2>&1
    $blockedExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorPreference
  }
  if ($blockedExitCode -eq 0) {
    throw 'Package secret scan accepted a synthetic Google API key'
  }
  if (($blockedOutput -join "`n").Contains($fakeSecret)) {
    throw 'Package secret scan leaked the synthetic key in its error output'
  }
  Remove-Item -LiteralPath (Join-Path $secretFixtureDir 'fixture.txt') -Force

  $scannerLifecycleDir = Join-Path $testDir 'scanner-without-quarantine'
  $scannerLifecyclePackagingDir = Join-Path $scannerLifecycleDir 'packaging'
  New-Item -ItemType Directory -Path $scannerLifecyclePackagingDir -Force | Out-Null
  $scannerWithoutQuarantine = Join-Path $scannerLifecyclePackagingDir 'scan-package-secrets.ps1'
  $syntheticHashAlgorithm = [System.Security.Cryptography.SHA256]::Create()
  try {
    $syntheticKnownHash = (
      [System.BitConverter]::ToString(
        $syntheticHashAlgorithm.ComputeHash([System.Text.Encoding]::ASCII.GetBytes($fakeSecret))
      )
    ).Replace('-', '')
  } finally {
    $syntheticHashAlgorithm.Dispose()
  }
  $scannerTemplate = Get-Content -Raw -LiteralPath $secretScanner
  $scannerTemplate = $scannerTemplate.Replace(
    '6E4CA28D6ED3CC991CB368642609E33949BE263CED0BF1C50A270E5F6224EF38',
    $syntheticKnownHash
  )
  [System.IO.File]::WriteAllText(
    $scannerWithoutQuarantine,
    $scannerTemplate,
    [System.Text.Encoding]::UTF8
  )
  $noQuarantineOutput = & powershell.exe -NoProfile -ExecutionPolicy Bypass `
    -File $scannerWithoutQuarantine
  if ($LASTEXITCODE -ne 0) {
    throw 'Package secret scan requires the plaintext quarantine to exist'
  }

  $exactSecretBytes = [System.Text.Encoding]::ASCII.GetBytes($fakeSecret)
  $binaryFixturePath = Join-Path $scannerLifecycleDir 'fixture.bin'
  $binaryFixtureBytes = [byte[]]::new($exactSecretBytes.Length + 8)
  [System.Array]::Copy([byte[]](1, 2, 3, 4), 0, $binaryFixtureBytes, 0, 4)
  [System.Array]::Copy($exactSecretBytes, 0, $binaryFixtureBytes, 4, $exactSecretBytes.Length)
  [System.Array]::Copy(
    [byte[]](5, 6, 7, 8),
    0,
    $binaryFixtureBytes,
    $exactSecretBytes.Length + 4,
    4
  )
  [System.IO.File]::WriteAllBytes($binaryFixturePath, $binaryFixtureBytes)
  try {
    $ErrorActionPreference = 'Continue'
    $binaryBlockedOutput = & powershell.exe -NoProfile -ExecutionPolicy Bypass `
      -File $scannerWithoutQuarantine `
      -AdditionalPath $binaryFixturePath 2>&1
    $binaryBlockedExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorPreference
  }
  if ($binaryBlockedExitCode -eq 0) {
    throw 'Package secret scan accepted a binary containing the exact quarantined secret'
  }
  if (($binaryBlockedOutput -join "`n").Contains($fakeSecret)) {
    throw 'Package secret scan leaked the synthetic known secret in its error output'
  }

  $runtimeLockPath = Join-Path $packagingDir 'runtime\package-lock.json'
  $runtimeLockText = Get-Content -Raw -LiteralPath $runtimeLockPath
  foreach ($forbiddenPackage in @('react', 'react-dom', 'socket.io-client', 'vite', 'vitest', 'playwright')) {
    $escapedPackage = [regex]::Escape("node_modules/$forbiddenPackage")
    if ($runtimeLockText -match "`"$escapedPackage`"\s*:") {
      throw "Production lock contains forbidden browser/dev package: $forbiddenPackage"
    }
  }

  [pscustomobject]@{
    PowerShellSyntax = 'PASS'
    LauncherAnyCpuCompile = 'PASS'
    LauncherContract = 'PASS'
    CrossLaneUpgrade = 'PASS'
    DotNetPrerequisite = 'PASS'
    PackageSecretScan = 'PASS'
    InstallerContract = 'PASS'
    Windows7InstallerContract = 'PASS'
    Windows7RuntimeContract = 'PASS'
    ProductionLock = 'PASS'
    CleanupContainmentGuard = 'PASS'
  } | ConvertTo-Json
} finally {
  Assert-PackagingChildPath -Path $testDir
  if (Test-Path -LiteralPath $testDir) {
    Remove-Item -LiteralPath $testDir -Recurse -Force
  }
}
