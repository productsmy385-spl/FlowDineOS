# FlowDineOS Print Agent — Windows Authenticode Signing & Verification Pipeline
# (C) FlowDineOS. Designed for CI/CD releases and local validation.
[CmdletBinding()]
param(
  [string]$TargetDir = "",
  [string]$SignToolPath = ""
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $TargetDir) {
  $TargetDir = Resolve-Path (Join-Path $scriptDir "..\..\dist\windows")
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " FlowDineOS Windows Authenticode Signing & Verification" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " Target Directory: $TargetDir"

$binaries = @(
  (Join-Path $TargetDir "FlowDineOS.PrintAgent.exe"),
  (Join-Path $TargetDir "FlowDineOS.PrintAgent.Service.exe"),
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

# Method C: Verification of current binaries
Write-Host "`n==> Verifying Digital Signatures..." -ForegroundColor Cyan
foreach ($bin in $existingBinaries) {
  $leaf = Split-Path -Leaf $bin
  $sig = Get-AuthenticodeSignature -FilePath $bin

  if ($sig.Status -eq "Valid") {
    Write-Host " [AUTHENTICODE VALID] $leaf" -ForegroundColor Green
    Write-Host "   Signer:      $($sig.SignerCertificate.Subject)" -ForegroundColor Green
    Write-Host "   Thumbprint:  $($sig.SignerCertificate.Thumbprint)"
    Write-Host "   Timestamped: $($sig.TimeStamperCertificate -ne $null)"
  } else {
    Write-Host " [NOT SIGNED / UNTRUSTED] $leaf" -ForegroundColor Yellow
    Write-Host "   Status:      $($sig.Status)"
    Write-Host "   Explanation: Binary has no trusted commercial Authenticode certificate attached." -ForegroundColor DarkGray
  }
}

# 4. Recompute exact SHA-256 Checksums
Write-Host "`n==> Updating SHA256SUMS and Release ZIP..." -ForegroundColor Cyan
$shaLines = @()
foreach ($bin in $existingBinaries) {
  $hash = (Get-FileHash -Path $bin -Algorithm SHA256).Hash.ToLower()
  $leaf = Split-Path -Leaf $bin
  $shaLines += "$hash  $leaf"
}

$shaFile = Join-Path $TargetDir "SHA256SUMS"
[string]::Join([Environment]::NewLine, $shaLines) | Set-Content -Path $shaFile -Encoding ascii
Write-Host " [OK] Updated $shaFile" -ForegroundColor Green

# 5. Package verified clean ZIP from exact installer
$setupExe = Join-Path $TargetDir "FlowDineOS-Print-Agent-Setup.exe"
if (Test-Path $setupExe) {
  $setupZip = Join-Path $TargetDir "FlowDineOS-Print-Agent-Setup.zip"
  if (Test-Path $setupZip) { Remove-Item $setupZip -Force }
  
  Compress-Archive -Path $setupExe -DestinationPath $setupZip -Force
  $zipHash = (Get-FileHash -Path $setupZip -Algorithm SHA256).Hash.ToLower()
  Add-Content -Path $shaFile -Value "$zipHash  FlowDineOS-Print-Agent-Setup.zip" -Encoding ascii
  Write-Host " [OK] Created clean ZIP: $setupZip" -ForegroundColor Green
  Write-Host "      ZIP SHA256: $zipHash" -ForegroundColor DarkGray

  # Sync to packaging/windows/bin cache
  $pkgBin = Join-Path $scriptDir "bin"
  if (Test-Path $pkgBin) {
    Copy-Item $setupExe (Join-Path $pkgBin "FlowDineOS-Print-Agent-Setup.exe") -Force
    Copy-Item $setupZip (Join-Path $pkgBin "FlowDineOS-Print-Agent-Setup.zip") -Force
    Copy-Item $shaFile (Join-Path $pkgBin "SHA256SUMS") -Force
    Write-Host " [OK] Synced to packaging\windows\bin cache" -ForegroundColor Green
  }
}

Write-Host "`n==> Signing & verification pipeline complete!" -ForegroundColor Green
