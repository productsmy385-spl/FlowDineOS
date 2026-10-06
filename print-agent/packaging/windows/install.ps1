#Requires -Version 5.1
#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Installs the FlowDineOS print agent on a Windows 10/11 counter PC (S1-P17-T009, Q-010).

.DESCRIPTION
  1. Checks Node.js 22 or later is installed.
  2. Copies rasoios-print-agent.cjs to %ProgramFiles%\RasoiOS\PrintAgent after verifying its SHA-256 against SHA256SUMS.
  3. Creates %ProgramData%\RasoiOS\PrintAgent and restricts it to SYSTEM and Administrators (the token lives there).
  4. Writes config.json and pairs the agent with the one-time code from Printing -> Agents.
  5. Registers the "RasoiOS Print Agent" scheduled task: starts at boot as SYSTEM, restarts every minute on failure,
     no time limit. A scheduled task needs no third-party service wrapper.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install.ps1 -ServerUrl https://app.example.com -PairingCode ABCD2345
#>
param(
  [Parameter(Mandatory = $true)][string] $ServerUrl,
  [Parameter(Mandatory = $true)][string] $PairingCode,
  [string] $SourceDir = $PSScriptRoot
)
$ErrorActionPreference = 'Stop'
$TaskName = 'RasoiOS Print Agent'
$InstallDir = Join-Path $env:ProgramFiles 'RasoiOS\PrintAgent'
$DataDir = Join-Path $env:ProgramData 'RasoiOS\PrintAgent'
$Bundle = 'rasoios-print-agent.cjs'

# 1. Node.js
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'Node.js is not installed. Install Node.js 22 LTS or later from https://nodejs.org and run this again.' }
$major = [int]((& $node --version).TrimStart('v').Split('.')[0])
if ($major -lt 22) { throw "Node.js $major is too old. Install Node.js 22 LTS or later." }

# 2. Verify and copy the bundle
$source = Join-Path $SourceDir $Bundle
$sums = Join-Path $SourceDir 'SHA256SUMS'
if (-not (Test-Path $source) -or -not (Test-Path $sums)) { throw "$Bundle and SHA256SUMS must be next to this script." }
$expected = ((Get-Content $sums | Where-Object { $_ -match [regex]::Escape($Bundle) }) -split '\s+')[0].ToLowerInvariant()
$actual = (Get-FileHash -Algorithm SHA256 $source).Hash.ToLowerInvariant()
if ($expected -ne $actual) { throw "Checksum mismatch for $Bundle. Download the release again." }
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Force $source (Join-Path $InstallDir $Bundle)

# 3. Data directory: SYSTEM and Administrators only, no inherited access
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {  # LocalSystem, BUILTIN\Administrators
  $identity = New-Object System.Security.Principal.SecurityIdentifier($sid)
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
}
Set-Acl -Path $DataDir -AclObject $acl

# 4. Pair (writes config.json and credentials.json into the data directory — the agent's default on Windows, so the
#    service needs no environment variable; Task Scheduler would not see a new one until the next reboot anyway)
& $node (Join-Path $InstallDir $Bundle) pair $PairingCode --server $ServerUrl
if ($LASTEXITCODE -ne 0) { throw 'Pairing failed; nothing was started. Create a new pairing code and run this again.' }

# 5. Scheduled task running as SYSTEM at startup
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$(Join-Path $InstallDir $Bundle)`" run" -WorkingDirectory $InstallDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Prints FlowDineOS kitchen tickets and bills on this restaurant''s printers.' | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Host "Installed and started '$TaskName'. Check Printing -> Agents in RASOIOS: this PC should show as online within a minute."
