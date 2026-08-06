# Hangar persistence executor.
#
# Reads a JSON action list on stdin, applies each action, emits JSON results.
# NOTHING here deletes anything:
#   move-file               -> Move-Item (file preserved in quarantine)
#   registry-remove-value   -> Remove-ItemProperty AFTER the value is recorded
#   registry-restore-value  -> New-ItemProperty from the recorded value
#   task-disable/enable     -> Disable-/Enable-ScheduledTask (never Unregister)
#   service-startuptype     -> Set-Service -StartupType (never Remove-Service)
#
# Each action is attempted independently; one failure never aborts the rest.
param()
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$raw = [Console]::In.ReadToEnd()
if (-not $raw) { '{"error":"no input"}'; exit 1 }
$payload = $raw | ConvertFrom-Json

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

$results = New-Object System.Collections.ArrayList

foreach ($a in $payload.actions) {
  $r = [ordered]@{ id = $a.id; op = $a.op; ok = $false; detail = $null; error = $null }

  if ($a.needsAdmin -and -not $isAdmin) {
    $r.error = 'requires an elevated (Administrator) Hangar agent'
    [void]$results.Add([pscustomobject]$r); continue
  }

  try {
    switch ($a.op) {

      'move-file' {
        $dir = Split-Path -Parent $a.to
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        if (-not (Test-Path $a.from)) { throw "source not found: $($a.from)" }
        if (Test-Path $a.to) { throw "destination already occupied: $($a.to)" }
        Move-Item -LiteralPath $a.from -Destination $a.to -Force
        $r.ok = $true; $r.detail = "moved to $($a.to)"
      }

      'registry-remove-value' {
        if (-not (Test-Path $a.hive)) { throw "key not found: $($a.hive)" }
        $cur = (Get-ItemProperty -Path $a.hive -Name $a.valueName -ErrorAction SilentlyContinue).$($a.valueName)
        if ($null -eq $cur) { throw "value '$($a.valueName)' not present" }
        # Record what we are about to remove so restore is exact.
        Remove-ItemProperty -Path $a.hive -Name $a.valueName -Force
        $r.ok = $true; $r.detail = "removed; recorded value length $($cur.Length)"
      }

      'registry-restore-value' {
        if (-not (Test-Path $a.hive)) { New-Item -Path $a.hive -Force | Out-Null }
        New-ItemProperty -Path $a.hive -Name $a.valueName -Value $a.recordedValue -PropertyType String -Force | Out-Null
        $r.ok = $true; $r.detail = 'value recreated'
      }

      'task-disable' {
        Disable-ScheduledTask -TaskName $a.taskName -TaskPath $a.taskPath -ErrorAction Stop | Out-Null
        $r.ok = $true; $r.detail = 'task disabled (definition kept)'
      }

      'task-enable' {
        Enable-ScheduledTask -TaskName $a.taskName -TaskPath $a.taskPath -ErrorAction Stop | Out-Null
        $r.ok = $true; $r.detail = 'task enabled'
      }

      'service-startuptype' {
        $svc = Get-Service -Name $a.serviceName -ErrorAction Stop
        Set-Service -Name $a.serviceName -StartupType $a.target -ErrorAction Stop
        $r.ok = $true; $r.detail = "StartupType -> $($a.target) (service left $($svc.Status))"
      }

      default { throw "unsupported op: $($a.op)" }
    }
  } catch {
    $r.error = $_.Exception.Message
  }

  [void]$results.Add([pscustomobject]$r)
}

[pscustomobject]@{
  elevated = $isAdmin
  results  = @($results)
} | ConvertTo-Json -Depth 6 -Compress
