# Hangar fast collector — system, processes, ports. Read-only.
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$os = Get-CimInstance Win32_OperatingSystem
$cs = Get-CimInstance Win32_ComputerSystem
$raw = Get-CimInstance Win32_Process

$perf = @{}
foreach ($g in Get-Process) { $perf[$g.Id] = $g }

$procs = foreach ($p in $raw) {
  $g = $perf[[int]$p.ProcessId]
  [pscustomobject]@{
    pid     = [int]$p.ProcessId
    ppid    = [int]$p.ParentProcessId
    name    = $p.Name
    memMB   = [math]::Round($p.WorkingSetSize / 1MB, 1)
    cpuSec  = if ($g -and $g.CPU) { [math]::Round($g.CPU, 2) } else { 0 }
    threads = [int]$p.ThreadCount
    started = if ($p.CreationDate) { $p.CreationDate.ToString('o') } else { $null }
    path    = $p.ExecutablePath
    cmd     = $p.CommandLine
  }
}

$ports = foreach ($c in (Get-NetTCPConnection -State Listen)) {
  [pscustomobject]@{
    port = [int]$c.LocalPort
    addr = $c.LocalAddress
    pid  = [int]$c.OwningProcess
  }
}

[pscustomobject]@{
  ts     = (Get-Date).ToString('o')
  system = [pscustomobject]@{
    boot      = $os.LastBootUpTime.ToString('o')
    uptimeMin = [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalMinutes, 0)
    totalGB   = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
    freeGB    = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
    cpus      = [int]$cs.NumberOfLogicalProcessors
    procCount = $raw.Count
    host      = $cs.Name
  }
  processes = @($procs)
  ports     = @($ports)
} | ConvertTo-Json -Depth 5 -Compress
