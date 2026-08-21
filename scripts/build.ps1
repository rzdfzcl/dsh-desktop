[CmdletBinding()]
param(
  [ValidateSet('Installer', 'Uninstaller', 'Portable')]
  [string]$Target = 'Installer',
  [switch]$SkipInstall,
  [switch]$ForceInstall,
  [switch]$RequireSigning,
  [switch]$KeepOldArtifacts,
  [switch]$KeepUnpacked
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$packageFile = Join-Path $projectRoot 'package.json'
$packageLockFile = Join-Path $projectRoot 'package-lock.json'
$releaseRoot = Join-Path $projectRoot 'release'
$dependencyStateFile = Join-Path $projectRoot 'node_modules\.dsh-build-state.json'
$script:signingEnabled = $false
$script:signTool = $null
$script:signCertificate = $null
$script:signPassword = $null
$script:timestampUrl = if ($env:DSH_TIMESTAMP_URL) {
  $env:DSH_TIMESTAMP_URL
} else {
  'http://timestamp.digicert.com'
}

function Invoke-Npm {
  param([Parameter(Mandatory)][string[]]$Arguments)

  & $script:npmCommand @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "npm $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
  }
}

function Assert-GuiExecutable {
  param([Parameter(Mandatory)][string]$Path)

  $bytes = [IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -lt 256) {
    throw "Invalid PE file: $Path"
  }

  $peOffset = [BitConverter]::ToInt32($bytes, 0x3c)
  $subsystemOffset = $peOffset + 24 + 68
  if ($subsystemOffset + 2 -gt $bytes.Length) {
    throw "Cannot read PE subsystem: $Path"
  }

  $subsystem = [BitConverter]::ToUInt16($bytes, $subsystemOffset)
  if ($subsystem -ne 2) {
    throw "EXE is not a Windows GUI application (subsystem $subsystem): $Path"
  }
}

function Get-Sha256Hex {
  param([Parameter(Mandatory)][string]$Path)

  $getFileHash = Get-Command Get-FileHash -ErrorAction SilentlyContinue
  if ($getFileHash) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
  }

  $sha256 = [Security.Cryptography.SHA256]::Create()
  $stream = [IO.File]::OpenRead($Path)
  try {
    return ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '')
  } finally {
    $stream.Dispose()
    $sha256.Dispose()
  }
}

function Get-DependencyFingerprint {
  if (-not (Test-Path -LiteralPath $packageLockFile -PathType Leaf)) {
    throw "package-lock.json not found: $packageLockFile"
  }

  $normalizedLock = Get-Content -LiteralPath $packageLockFile -Raw
  $rootVersionMatches = [regex]::Matches(
    $normalizedLock,
    '(?m)^(\s*"version"\s*:\s*)"[^"]+"(,?\s*)$'
  )
  if ($rootVersionMatches.Count -lt 2) {
    throw 'Unable to normalize the application versions in package-lock.json.'
  }
  for ($index = 1; $index -ge 0; $index--) {
    $match = $rootVersionMatches[$index]
    $replacement = $match.Groups[1].Value + '""' + $match.Groups[2].Value
    $normalizedLock = $normalizedLock.Remove($match.Index, $match.Length).Insert(
      $match.Index,
      $replacement
    )
  }
  $metadata = Get-Content -LiteralPath $packageFile -Raw | ConvertFrom-Json
  $dependencyMetadata = [ordered]@{
    dependencies = if ($metadata.PSObject.Properties.Name -contains 'dependencies') {
      $metadata.dependencies
    } else { $null }
    devDependencies = if ($metadata.PSObject.Properties.Name -contains 'devDependencies') {
      $metadata.devDependencies
    } else { $null }
    optionalDependencies = if ($metadata.PSObject.Properties.Name -contains 'optionalDependencies') {
      $metadata.optionalDependencies
    } else { $null }
    allowScripts = if ($metadata.PSObject.Properties.Name -contains 'allowScripts') {
      $metadata.allowScripts
    } else { $null }
  } | ConvertTo-Json -Compress
  $nodeVersion = (& $nodeCommand.Source --version | Out-String).Trim()
  $npmVersion = (& $script:npmCommand --version | Out-String).Trim()
  $fingerprintSource = "$dependencyMetadata|$normalizedLock|$nodeVersion|$npmVersion"
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes($fingerprintSource)
    return ([BitConverter]::ToString($sha256.ComputeHash($bytes))).Replace('-', '')
  } finally {
    $sha256.Dispose()
  }
}

function Test-DependencyCache {
  param([Parameter(Mandatory)][string]$Fingerprint)

  $requiredFiles = @(
    (Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'),
    (Join-Path $projectRoot 'node_modules\electron-builder\package.json')
  )
  if ($requiredFiles | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) }) {
    return $false
  }
  if (-not (Test-Path -LiteralPath $dependencyStateFile -PathType Leaf)) {
    return $false
  }

  try {
    $state = Get-Content -LiteralPath $dependencyStateFile -Raw | ConvertFrom-Json
    return [string]$state.fingerprint -eq $Fingerprint
  } catch {
    return $false
  }
}

function Save-DependencyCache {
  param([Parameter(Mandatory)][string]$Fingerprint)

  [PSCustomObject]@{
    fingerprint = $Fingerprint
    createdAt = [DateTime]::UtcNow.ToString('o')
  } | ConvertTo-Json | Set-Content -LiteralPath $dependencyStateFile -Encoding UTF8
}

function Install-ElectronRuntime {
  $electronRoot = Join-Path $projectRoot 'node_modules\electron'
  $electronInstaller = Join-Path $electronRoot 'install.js'
  $electronExecutable = Join-Path $electronRoot 'dist\electron.exe'

  if (Test-Path -LiteralPath $electronExecutable -PathType Leaf) {
    return
  }
  if (-not (Test-Path -LiteralPath $electronInstaller -PathType Leaf)) {
    throw "Electron installer not found: $electronInstaller"
  }

  Write-Host 'Downloading Electron runtime...' -ForegroundColor Cyan
  & $nodeCommand.Source $electronInstaller
  if ($LASTEXITCODE -ne 0) {
    throw "Electron runtime installation failed with exit code $LASTEXITCODE"
  }
  if (-not (Test-Path -LiteralPath $electronExecutable -PathType Leaf)) {
    throw "Electron runtime executable not found after installation: $electronExecutable"
  }
}

function Install-BuildDependencies {
  if ($SkipInstall) {
    Write-Host '[2/4] Skipping dependency installation by request.' -ForegroundColor DarkGray
    return
  }

  $fingerprint = Get-DependencyFingerprint
  if (-not $ForceInstall -and (Test-DependencyCache -Fingerprint $fingerprint)) {
    Write-Host '[2/4] Dependencies unchanged; reusing node_modules.' -ForegroundColor Green
    return
  }

  Write-Host '[2/4] Installing locked dependencies...' -ForegroundColor Cyan
  Invoke-Npm -Arguments @('ci', '--no-audit', '--no-fund')
  Install-ElectronRuntime
  Save-DependencyCache -Fingerprint $fingerprint
}

function Find-SignTool {
  if ($env:DSH_SIGNTOOL_PATH) {
    if (-not (Test-Path -LiteralPath $env:DSH_SIGNTOOL_PATH -PathType Leaf)) {
      throw "DSH_SIGNTOOL_PATH does not exist: $env:DSH_SIGNTOOL_PATH"
    }
    return (Resolve-Path -LiteralPath $env:DSH_SIGNTOOL_PATH).Path
  }

  $command = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  $kitsRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
  if (Test-Path -LiteralPath $kitsRoot -PathType Container) {
    $candidate = Get-ChildItem -Path (Join-Path $kitsRoot '*\x64\signtool.exe') -File |
      Sort-Object FullName -Descending |
      Select-Object -First 1
    if ($candidate) {
      return $candidate.FullName
    }
  }
  return $null
}

function Initialize-CodeSigning {
  $certificate = $env:DSH_SIGN_CERTIFICATE
  if (-not $certificate -and $env:CSC_LINK -and
      (Test-Path -LiteralPath $env:CSC_LINK -PathType Leaf)) {
    $certificate = $env:CSC_LINK
  }

  if (-not $certificate) {
    if ($RequireSigning) {
      throw 'Code signing is required, but DSH_SIGN_CERTIFICATE is not configured.'
    }
    Write-Warning 'Code signing is disabled. Set DSH_SIGN_CERTIFICATE and DSH_SIGN_PASSWORD for release builds.'
    return
  }
  if (-not (Test-Path -LiteralPath $certificate -PathType Leaf)) {
    throw "Signing certificate not found: $certificate"
  }

  $script:signTool = Find-SignTool
  if (-not $script:signTool) {
    throw 'signtool.exe was not found. Install the Windows SDK or set DSH_SIGNTOOL_PATH.'
  }
  $script:signCertificate = (Resolve-Path -LiteralPath $certificate).Path
  $script:signPassword = if ($env:DSH_SIGN_PASSWORD) {
    $env:DSH_SIGN_PASSWORD
  } else {
    $env:CSC_KEY_PASSWORD
  }
  $env:CSC_LINK = $script:signCertificate
  if ($script:signPassword) {
    $env:CSC_KEY_PASSWORD = $script:signPassword
  }
  $script:signingEnabled = $true
  Write-Host 'Code signing enabled for all Windows executables.' -ForegroundColor Green
}

function Sign-Executable {
  param([Parameter(Mandatory)][string]$Path)

  if (-not $script:signingEnabled) {
    return
  }
  $arguments = @(
    'sign', '/fd', 'SHA256', '/td', 'SHA256',
    '/tr', $script:timestampUrl,
    '/f', $script:signCertificate
  )
  if ($script:signPassword) {
    $arguments += @('/p', $script:signPassword)
  }
  $arguments += $Path
  & $script:signTool @arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Code signing failed with exit code $LASTEXITCODE`: $Path"
  }

  & $script:signTool verify /pa /all $Path
  if ($LASTEXITCODE -ne 0) {
    throw "Signature verification failed with exit code $LASTEXITCODE`: $Path"
  }
}

function Build-UninstallLauncher {
  param(
    [Parameter(Mandatory)][string]$SourcePath,
    [Parameter(Mandatory)][string]$OutputPath,
    [Parameter(Mandatory)][string]$IconPath
  )

  if (-not (Test-Path -LiteralPath $SourcePath -PathType Leaf)) {
    throw "Uninstall launcher source not found: $SourcePath"
  }
  if (-not (Test-Path -LiteralPath $IconPath -PathType Leaf)) {
    throw "Uninstall launcher icon not found: $IconPath"
  }
  if (Test-Path -LiteralPath $OutputPath) {
    Remove-Item -LiteralPath $OutputPath -Force
  }

  $compilerCandidates = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
  )
  $compiler = $compilerCandidates | Where-Object {
    Test-Path -LiteralPath $_ -PathType Leaf
  } | Select-Object -First 1
  if (-not $compiler) {
    throw 'Windows .NET Framework C# compiler csc.exe was not found.'
  }

  $compilerArguments = @(
    '/nologo',
    '/target:winexe',
    '/optimize+',
    "/win32icon:$IconPath",
    "/out:$OutputPath",
    '/reference:System.dll',
    '/reference:System.Windows.Forms.dll',
    $SourcePath
  )
  & $compiler @compilerArguments
  if ($LASTEXITCODE -ne 0) {
    throw "Uninstall launcher compilation failed with exit code $LASTEXITCODE"
  }
}

if (-not (Test-Path -LiteralPath $packageFile -PathType Leaf)) {
  throw "package.json not found: $packageFile"
}
if ($SkipInstall -and $ForceInstall) {
  throw 'SkipInstall and ForceInstall cannot be used together.'
}

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$npmInfo = Get-Command npm.cmd -ErrorAction SilentlyContinue
$script:npmCommand = if ($npmInfo) { $npmInfo.Source } else { $null }
if (-not $nodeCommand -or -not $script:npmCommand) {
  throw 'Node.js/npm was not found. Install Node.js LTS first.'
}

$package = Get-Content -LiteralPath $packageFile -Raw | ConvertFrom-Json
$version = [string]$package.version
$productName = [string]$package.build.productName
if (-not $version -or -not $productName) {
  throw 'package.json is missing version or build.productName.'
}
$dshRuntimePackage = [string]$package.dshRuntime.packageName
$dshRuntimeVersion = [string]$package.dshRuntime.version
$minimumNodeMajor = [int]$package.dshRuntime.minimumNodeMajor
$preferredNodeVersion = [string]$package.dshRuntime.preferredNodeVersion
$preferredNodeSha256 = [string]$package.dshRuntime.preferredNodeSha256
$lockedDshProperty = $package.devDependencies.PSObject.Properties[$dshRuntimePackage]
$lockedDshVersion = if ($lockedDshProperty) { [string]$lockedDshProperty.Value } else { $null }
if (-not $dshRuntimePackage -or -not $dshRuntimeVersion) {
  throw 'package.json is missing dshRuntime.packageName or dshRuntime.version.'
}
if ($dshRuntimeVersion -ne $lockedDshVersion) {
  throw "dshRuntime.version ($dshRuntimeVersion) does not match devDependencies ($lockedDshVersion)."
}
if ($minimumNodeMajor -lt 20) {
  throw "Invalid dshRuntime.minimumNodeMajor: $minimumNodeMajor"
}
if ($preferredNodeVersion -notmatch '^\d+\.\d+\.\d+$') {
  throw "Invalid dshRuntime.preferredNodeVersion: $preferredNodeVersion"
}
if ($preferredNodeSha256 -notmatch '^[0-9a-fA-F]{64}$') {
  throw 'dshRuntime.preferredNodeSha256 must be a 64-character SHA-256 value.'
}

Initialize-CodeSigning

$setupName = "$productName-$version-Setup.exe"
$uninstallName = "$productName-Uninstall.exe"
$portableName = "$productName-$version-Portable.exe"
$setupPath = Join-Path $releaseRoot $setupName
$uninstallPath = Join-Path $releaseRoot $uninstallName
$portablePath = Join-Path $releaseRoot $portableName
$uninstallSource = Join-Path $PSScriptRoot 'UninstallLauncher.cs'
$iconPath = Join-Path $projectRoot 'build\icon.ico'

$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'

Push-Location $projectRoot
try {
  Write-Host "[1/4] Project: $productName $version ($Target)" -ForegroundColor Cyan

  if ($Target -eq 'Uninstaller') {
    Write-Host '[2/4] Skipping dependency installation.' -ForegroundColor DarkGray
  } else {
    Install-BuildDependencies
  }

  if ($Target -eq 'Portable') {
    Write-Host '[3/4] Building Portable edition...' -ForegroundColor Cyan
    Invoke-Npm -Arguments @('run', 'dist:portable')
    $builtArtifacts = @($portablePath)
  } elseif ($Target -eq 'Uninstaller') {
    Write-Host '[3/4] Building standalone uninstall launcher...' -ForegroundColor Cyan
    if (-not (Test-Path -LiteralPath $releaseRoot -PathType Container)) {
      New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
    }
    Build-UninstallLauncher -SourcePath $uninstallSource -OutputPath $uninstallPath -IconPath $iconPath
    $builtArtifacts = @($uninstallPath)
  } else {
    Write-Host '[3/4] Building NSIS installer...' -ForegroundColor Cyan
    Invoke-Npm -Arguments @('run', 'dist')
    $builtArtifacts = @($setupPath)
  }

  foreach ($artifact in $builtArtifacts) {
    if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) {
      throw "Expected artifact not found: $artifact"
    }
    Assert-GuiExecutable -Path $artifact
    Sign-Executable -Path $artifact
  }

  Write-Host '[4/4] Verifying and organizing artifacts...' -ForegroundColor Cyan
  $resolvedRelease = (Resolve-Path -LiteralPath $releaseRoot).Path
  $keepNames = @($setupName, $uninstallName, $portableName)

  if (-not $KeepOldArtifacts) {
    $oldFiles = Get-ChildItem -LiteralPath $resolvedRelease -File |
      Where-Object { $_.Name -notin $keepNames }
    foreach ($file in $oldFiles) {
      if ($file.DirectoryName -ne $resolvedRelease) {
        throw "Refusing to delete a file outside release: $($file.FullName)"
      }
      Remove-Item -LiteralPath $file.FullName -Force
    }
  }

  $unpackedPath = Join-Path $resolvedRelease 'win-unpacked'
  if (-not $KeepUnpacked -and (Test-Path -LiteralPath $unpackedPath -PathType Container)) {
    $resolvedUnpacked = (Resolve-Path -LiteralPath $unpackedPath).Path
    if ((Split-Path -Parent $resolvedUnpacked) -ne $resolvedRelease) {
      throw "Refusing to delete unexpected directory: $resolvedUnpacked"
    }
    Remove-Item -LiteralPath $resolvedUnpacked -Recurse -Force
  }

  $artifacts = foreach ($artifact in $builtArtifacts) {
    $item = Get-Item -LiteralPath $artifact
    [PSCustomObject]@{
      File = $item.FullName
      SizeMB = [Math]::Round($item.Length / 1MB, 2)
      SHA256 = Get-Sha256Hex -Path $item.FullName
      Signed = $script:signingEnabled
    }
  }

  Write-Host ''
  Write-Host 'Build completed successfully:' -ForegroundColor Green
  $artifacts | Format-List
} finally {
  Pop-Location
}
