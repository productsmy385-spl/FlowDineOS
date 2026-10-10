# FlowDineOS Print Agent — Windows Authenticode Signing & Release Pipeline
# (C) FlowDineOS. Designed for CI/CD releases and local validation.
[CmdletBinding()]
param(
  [string]$TargetDir = "",
  [string]$SignToolPath = "",
  [switch]$RequireTrusted
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptDir "..\..\..")

if (-not $TargetDir) {
  $TargetDir = Resolve-Path (Join-Path $scriptDir "..\..\dist\windows")
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " FlowDineOS Windows Release & Signing Pipeline" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " Target Directory: $TargetDir"
Write-Host " Repo Root:        $repoRoot"

$binaries = @(
  (Join-Path $TargetDir "FlowDineOS.PrintAgent.exe"),
  (Join-Path $TargetDir "FlowDineOS.PrintAgent.Service.exe"),
  (Join-Path $TargetDir "FlowDineOS.PrintAgent.UI.exe"),
  (Join-Path $TargetDir "FlowDineOS-Print-Agent-Setup.exe")
)

# 1. Verify existence of binaries
$existingBinaries = @()
foreach ($bin in $binaries) {
  if (Test-Path $bin) {
    $existingBinaries += $bin
    $size = (Get-Item $bin).Length
    $hash = (Get-FileHash -Path $bin -Algorithm SHA256).Hash.ToLower()
    Write-Host " [FOUND] $(Split-Path -Leaf $bin) ($([Math]::Round($size / 1MB, 2)) MB)" -ForegroundColor Green
    Write-Host "         SHA256: $hash" -ForegroundColor DarkGray
  } else {
    Write-Warning " [MISSING] Binary not found: $bin"
  }
}

if ($existingBinaries.Count -eq 0) {
  throw "No executable binaries found to sign or verify in $TargetDir."
}

# 2. Locate SignTool
$resolvedSignTool = $null
if ($SignToolPath -and (Test-Path $SignToolPath)) {
  $resolvedSignTool = $SignToolPath
} elseif ($env:SIGNTOOL_PATH -and (Test-Path $env:SIGNTOOL_PATH)) {
  $resolvedSignTool = $env:SIGNTOOL_PATH
} elseif (Get-Command "signtool.exe" -ErrorAction SilentlyContinue) {
  $resolvedSignTool = (Get-Command "signtool.exe").Source
} else {
  # Search standard Windows Kits paths
  $kitsSearch = @(
    "C:\Program Files (x86)\Windows Kits\10\bin\*\x64\signtool.exe",
    "C:\Program Files\Windows Kits\10\bin\*\x64\signtool.exe"
  )
  foreach ($pattern in $kitsSearch) {
    $found = Resolve-Path $pattern -ErrorAction SilentlyContinue | Select-Object -Last 1
    if ($found) {
      $resolvedSignTool = $found.Path
      break
    }
  }
}

if ($resolvedSignTool) {
  Write-Host " [TOOL] Found SignTool at: $resolvedSignTool" -ForegroundColor Green
} else {
  Write-Host " [TOOL] SignTool not installed locally (typical on dev machines without Windows SDK)." -ForegroundColor Yellow
}

# 3. Determine Signing Method
$timestampUrl = if ($env:SIGNING_TIMESTAMP_URL) { $env:SIGNING_TIMESTAMP_URL } else { "http://timestamp.digicert.com" }
$signedAny = $false

# Method A: Microsoft Trusted Signing (Azure Artifact Signing)
if ($env:TRUSTED_SIGNING_ACCOUNT -and $env:TRUSTED_SIGNING_PROFILE) {
  Write-Host " [METHOD] Using Microsoft Trusted Signing (Azure Artifact Signing)..." -ForegroundColor Cyan
  Write-Host "          Account: $env:TRUSTED_SIGNING_ACCOUNT"
  Write-Host "          Profile: $env:TRUSTED_SIGNING_PROFILE"

  if ($resolvedSignTool -and $env:TRUSTED_SIGNING_DLIB_PATH) {
    foreach ($bin in $existingBinaries) {
      Write-Host " Signing $(Split-Path -Leaf $bin) with Microsoft Trusted Signing dlib..."
      & $resolvedSignTool sign /v /fd SHA256 /tr $timestampUrl /td SHA256 /dlib $env:TRUSTED_SIGNING_DLIB_PATH /dmdf $env:TRUSTED_SIGNING_METADATA $bin
    }
    $signedAny = $true
  } elseif (Get-Command "trusted-signing" -ErrorAction SilentlyContinue) {
    foreach ($bin in $existingBinaries) {
      Write-Host " Signing $(Split-Path -Leaf $bin) with trusted-signing CLI..."
      & trusted-signing sign -e $env:TRUSTED_SIGNING_ENDPOINT -a $env:TRUSTED_SIGNING_ACCOUNT -c $env:TRUSTED_SIGNING_PROFILE -f $bin
    }
    $signedAny = $true
  } else {
    Write-Warning " Trusted Signing tooling (dlib or CLI) not installed. Please configure TRUSTED_SIGNING_DLIB_PATH."
  }
}

# Method B: Authenticode PFX Certificate (Standard commercial / EV)
if (-not $signedAny -and ($env:SIGNING_CERT_PFX -or $env:SIGNING_CERT_BASE64)) {
  Write-Host " [METHOD] Using Authenticode Certificate..." -ForegroundColor Cyan

  $pfxFile = $env:SIGNING_CERT_PFX
  $tempPfx = $null
  if ($env:SIGNING_CERT_BASE64) {
    $tempPfx = Join-Path $env:TEMP "flowdineos-signing-$(New-Guid).pfx"
    [System.IO.File]::WriteAllBytes($tempPfx, [System.Convert]::FromBase64String($env:SIGNING_CERT_BASE64))
    $pfxFile = $tempPfx
  }

  $pfxPass = if ($env:SIGNING_CERT_PASSWORD) { $env:SIGNING_CERT_PASSWORD } else { "" }

  if ($resolvedSignTool) {
    foreach ($bin in $existingBinaries) {
      Write-Host " Signing $(Split-Path -Leaf $bin) with SignTool..."
      if ($pfxPass) {
        & $resolvedSignTool sign /f $pfxFile /p $pfxPass /fd SHA256 /tr $timestampUrl /td SHA256 /v $bin
      } else {
        & $resolvedSignTool sign /f $pfxFile /fd SHA256 /tr $timestampUrl /td SHA256 /v $bin
      }
    }
    $signedAny = $true
  } else {
    Write-Warning " SignTool required for PFX signing of PE executables."
  }

  if ($tempPfx -and (Test-Path $tempPfx)) {
    Remove-Item $tempPfx -Force -ErrorAction SilentlyContinue
  }
}

# 4. Verification of binaries
Write-Host "`n==> Verifying Digital Signatures..." -ForegroundColor Cyan
$artifactRecords = @()

foreach ($bin in $existingBinaries) {
  $leaf = Split-Path -Leaf $bin
  $item = Get-Item $bin
  $hash = (Get-FileHash -Path $bin -Algorithm SHA256).Hash.ToLower()
  $sig = Get-AuthenticodeSignature -FilePath $bin

  $isSigned = ($sig.Status -ne "NotSigned" -and $sig.SignerCertificate -ne $null)
  $isValidTrusted = ($sig.Status -eq "Valid")

  if ($isValidTrusted) {
    Write-Host " [AUTHENTICODE VALID] $leaf" -ForegroundColor Green
    Write-Host "   Signer:      $($sig.SignerCertificate.Subject)" -ForegroundColor Green
    Write-Host "   Thumbprint:  $($sig.SignerCertificate.Thumbprint)"
    Write-Host "   Timestamped: $($sig.TimeStamperCertificate -ne $null)"
  } elseif ($isSigned) {
    Write-Host " [SIGNED BUT UNTRUSTED ROOT] $leaf" -ForegroundColor Yellow
    Write-Host "   Status:      $($sig.Status)"
    Write-Host "   Signer:      $($sig.SignerCertificate.Subject)"
    Write-Host "   Issuer:      $($sig.SignerCertificate.Issuer)"
    Write-Host "   Timestamped: $($sig.TimeStamperCertificate -ne $null)"
  } else {
    Write-Host " [NOT SIGNED] $leaf" -ForegroundColor Yellow
    Write-Host "   Status:      $($sig.Status)"
  }

  $artifactRecords += [PSCustomObject]@{
    name = $leaf
    size = $item.Length
    sha256 = $hash
    signed = $isSigned
    signatureStatus = $sig.Status.ToString()
    signerSubject = if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { $null }
    signerIssuer = if ($sig.SignerCertificate) { $sig.SignerCertificate.Issuer } else { $null }
    timestamped = ($sig.TimeStamperCertificate -ne $null)
  }
}

# Strict enforcement check
$requireTrustedCheck = $RequireTrusted -or ($env:CI_REQUIRE_TRUSTED_SIGNING -eq "true")
$setupRecord = $artifactRecords | Where-Object { $_.name -eq "FlowDineOS-Print-Agent-Setup.exe" }

if ($requireTrustedCheck -and (-not $setupRecord -or $setupRecord.signatureStatus -ne "Valid")) {
  throw "PUBLIC CODE SIGNING FAILED: FlowDineOS-Print-Agent-Setup.exe signature is not Valid (status: $($setupRecord.signatureStatus)). Production release requires a public trusted CA certificate."
}

# 5. Recompute Checksums and Build Clean ZIP
Write-Host "`n==> Updating SHA256SUMS and Release ZIP..." -ForegroundColor Cyan

$setupExe = Join-Path $TargetDir "FlowDineOS-Print-Agent-Setup.exe"
$setupZip = Join-Path $TargetDir "FlowDineOS-Print-Agent-Setup.zip"

if (Test-Path $setupExe) {
  if (Test-Path $setupZip) { Remove-Item $setupZip -Force }
  Compress-Archive -Path $setupExe -DestinationPath $setupZip -Force
  $zipItem = Get-Item $setupZip
  $zipHash = (Get-FileHash -Path $setupZip -Algorithm SHA256).Hash.ToLower()
  Write-Host " [OK] Created clean ZIP: $setupZip" -ForegroundColor Green
  Write-Host "      ZIP SHA256: $zipHash" -ForegroundColor DarkGray

  $artifactRecords += [PSCustomObject]@{
    name = "FlowDineOS-Print-Agent-Setup.zip"
    size = $zipItem.Length
    sha256 = $zipHash
    signed = $false
    contains = "FlowDineOS-Print-Agent-Setup.exe"
  }
}

$shaLines = @()
foreach ($rec in $artifactRecords) {
  $shaLines += "$($rec.sha256)  $($rec.name)"
}

$shaFile = Join-Path $TargetDir "SHA256SUMS"
$chkFile = Join-Path $TargetDir "checksums.txt"
$shaContent = [string]::Join([Environment]::NewLine, $shaLines)
Set-Content -Path $shaFile -Value $shaContent -Encoding ascii
Set-Content -Path $chkFile -Value $shaContent -Encoding ascii
Write-Host " [OK] Updated $shaFile and $chkFile" -ForegroundColor Green

# 6. Generate release-manifest.json
$manifestObj = [PSCustomObject]@{
  product = "FlowDineOS Print Agent"
  platform = "windows"
  version = "0.2.0"
  buildTimestamp = (Get-Date).ToUniversalTime().ToString("o")
  signingStatus = [PSCustomObject]@{
    isSigned = if ($setupRecord) { $setupRecord.signed } else { $false }
    isPubliclyTrusted = if ($setupRecord) { ($setupRecord.signatureStatus -eq "Valid") } else { $false }
    provider = if ($env:TRUSTED_SIGNING_ACCOUNT) { "Microsoft Trusted Signing" } elseif ($env:SIGNING_CERT_PFX) { "Commercial Authenticode PFX" } else { "None / Local Development" }
    notes = if ($setupRecord -and $setupRecord.signatureStatus -ne "Valid") { "Signed with self-signed test certificate; public CA certificate required for public distribution." } else { "Verified release." }
  }
  artifacts = $artifactRecords
}

$manifestFile = Join-Path $TargetDir "release-manifest.json"
$manifestJson = $manifestObj | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($manifestFile, $manifestJson, (New-Object System.Text.UTF8Encoding($false)))
Write-Host " [OK] Generated $manifestFile" -ForegroundColor Green

# 7. Sync release artifacts to authoritative release/ folder and packaging/windows/bin
$releaseDir = Join-Path $repoRoot "release"
if (-not (Test-Path $releaseDir)) {
  New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null
}

$pkgBin = Join-Path $scriptDir "bin"
if (-not (Test-Path $pkgBin)) {
  New-Item -ItemType Directory -Path $pkgBin -Force | Out-Null
}

$syncFiles = @(
  "FlowDineOS-Print-Agent-Setup.exe",
  "FlowDineOS-Print-Agent-Setup.zip",
  "SHA256SUMS",
  "checksums.txt",
  "release-manifest.json"
)

foreach ($f in $syncFiles) {
  $src = Join-Path $TargetDir $f
  if (Test-Path $src) {
    Copy-Item $src (Join-Path $releaseDir $f) -Force
    Copy-Item $src (Join-Path $pkgBin $f) -Force
  }
}
Write-Host " [OK] Synced all release artifacts to $releaseDir and $pkgBin" -ForegroundColor Green

Write-Host "`n==> Release pipeline execution complete!" -ForegroundColor Green
