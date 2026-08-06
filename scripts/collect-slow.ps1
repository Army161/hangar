# Hangar slow collector — persistence surfaces (startup, tasks, services). Read-only.
# These change rarely, so the server refreshes them on a long interval.
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

# Pull the first real path out of a command string so we can date the binary
# and match it back to a running process later.
function Get-TargetPath([string]$cmd) {
  if (-not $cmd) { return $null }
  if ($cmd -match '"([^"]+\.(exe|cmd|bat|vbs|lnk|ps1))"') { return $Matches[1] }
  if ($cmd -match '([A-Za-z]:\\[^"]*?\.(exe|cmd|bat|vbs|lnk|ps1))') { return $Matches[1] }
  return $null
}
function Get-FileDate([string]$p) {
  if ($p -and (Test-Path $p)) { return (Get-Item $p).LastWriteTime.ToString('o') }
  return $null
}

$entries = New-Object System.Collections.ArrayList

# --- Startup folders: real creation dates, the most trustworthy signal we have ---
$folders = @(
  @{ p = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup";     scope = 'user' },
  @{ p = "$env:ProgramData\Microsoft\Windows\Start Menu\Programs\Startup"; scope = 'machine' }
)
foreach ($f in $folders) {
  foreach ($item in (Get-ChildItem $f.p -File)) {
    [void]$entries.Add([pscustomobject]@{
      kind        = 'startup-folder'
      name        = $item.BaseName
      scope       = $f.scope
      command     = $item.FullName
      target      = $item.FullName
      added       = $item.LastWriteTime.ToString('o')
      addedSource = 'file created in Startup folder'
      location    = $f.p
      enabled     = $true
    })
  }
}

# --- Registry Run keys ---
$runKeys = @(
  @{ k = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run';                   scope = 'user' },
  @{ k = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce';               scope = 'user' },
  @{ k = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run';                   scope = 'machine' },
  @{ k = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\RunOnce';               scope = 'machine' },
  @{ k = 'HKLM:\Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Run';       scope = 'machine' }
)
foreach ($rk in $runKeys) {
  if (-not (Test-Path $rk.k)) { continue }
  $props = Get-ItemProperty $rk.k
  foreach ($pr in $props.PSObject.Properties) {
    if ($pr.Name -like 'PS*' -or -not $pr.Value) { continue }
    $t = Get-TargetPath $pr.Value
    [void]$entries.Add([pscustomobject]@{
      kind        = 'registry-run'
      name        = $pr.Name
      scope       = $rk.scope
      command     = [string]$pr.Value
      target      = $t
      # Windows does not timestamp individual registry values, so we fall back to
      # the target binary's date and say so rather than inventing precision.
      added       = (Get-FileDate $t)
      addedSource = 'target binary date (registry values are not timestamped)'
      location    = $rk.k
      enabled     = $true
    })
  }
}

# --- Scheduled tasks (non-Microsoft) ---
foreach ($t in (Get-ScheduledTask | Where-Object { $_.TaskPath -notlike '\Microsoft\*' })) {
  $info = $t | Get-ScheduledTaskInfo
  $act  = ($t.Actions | ForEach-Object { (("$($_.Execute) $($_.Arguments)").Trim()) }) -join ' ; '
  [void]$entries.Add([pscustomobject]@{
    kind        = 'scheduled-task'
    name        = $t.TaskName
    scope       = 'task'
    command     = $act
    target      = (Get-TargetPath $act)
    added       = if ($t.Date) { ([datetime]$t.Date).ToString('o') } else { (Get-FileDate (Get-TargetPath $act)) }
    addedSource = if ($t.Date) { 'task registration date' } else { 'target binary date' }
    location    = $t.TaskPath
    enabled     = ($t.State -ne 'Disabled')
    state       = [string]$t.State
    lastRun     = if ($info.LastRunTime) { $info.LastRunTime.ToString('o') } else { $null }
    nextRun     = if ($info.NextRunTime) { $info.NextRunTime.ToString('o') } else { $null }
    triggers    = (($t.Triggers | ForEach-Object { $_.CimClass.CimClassName -replace '^MSFT_Task','' -replace 'Trigger$','' }) -join ',')
  })
}

# --- Auto-start services outside \Windows\ ---
foreach ($s in (Get-CimInstance Win32_Service | Where-Object { $_.StartMode -eq 'Auto' -and $_.PathName -notlike '*\Windows\*' })) {
  $t = Get-TargetPath $s.PathName
  [void]$entries.Add([pscustomobject]@{
    kind        = 'service'
    name        = $s.Name
    display     = $s.DisplayName
    scope       = 'machine'
    command     = $s.PathName
    target      = $t
    added       = (Get-FileDate $t)
    addedSource = 'service binary date'
    location    = 'Services'
    enabled     = $true
    state       = $s.State
    svcPid      = [int]$s.ProcessId
  })
}

[pscustomobject]@{
  ts      = (Get-Date).ToString('o')
  entries = @($entries)
} | ConvertTo-Json -Depth 5 -Compress
