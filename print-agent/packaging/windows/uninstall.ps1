#Requires -Version 5.1
#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Removes the FlowDineOS print agent. Also revoke the agent in Printing -> Agents so its token stops working.
.PARAMETER KeepData
  Keep %ProgramData%\RasoiOS\PrintAgent (config, credential, printed-job journal).
#>
param([switch] $KeepData)
$ErrorActionPreference = 'Stop'
$TaskName = 'RasoiOS Print Agent'
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
Remove-Item -Recurse -Force (Join-Path $env:ProgramFiles 'RasoiOS\PrintAgent') -ErrorAction SilentlyContinue
if (-not $KeepData) {
  Remove-Item -Recurse -Force (Join-Path $env:ProgramData 'RasoiOS\PrintAgent') -ErrorAction SilentlyContinue
}
Write-Host 'FlowDineOS print agent removed. Revoke it in Printing -> Agents if you have not already.'
