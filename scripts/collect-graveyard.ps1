# Hangar Graveyard collector — READ ONLY.
#
# Finds candidate projects and agent session stores under the user profile.
# Never writes, moves, or deletes anything.
#
# Performance matters here: a naive recursive sweep of $HOME walks node_modules
# and .git object stores and takes minutes. Strategy instead:
#   - only look at top-level folders under $HOME (plus known agent stores)
#   - inside each, sample to a bounded depth and skip noise directories entirely
#   - cap the number of files examined per project
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$HOMEDIR   = $env:USERPROFILE
$MAXDEPTH  = 3
$MAXFILES  = 150   # enough to date a project; the walk dominates the cost
$RETURN    = 40    # only the newest N are shipped — JS still does the filtering

# Top-level folders that are never user projects.
$SKIP_TOP = @(
  'AppData','Application Data','Cookies','Local Settings','NetHood','PrintHood',
  'Recent','SendTo','Start Menu','Templates','My Documents','Searches','Links',
  'Favorites','Contacts','OneDrive','Saved Games','3D Objects','Pictures',
  'Music','Videos','Downloads','Desktop','Documents','scoop','nvm4w',
  '.cache','.npm','.nuget','.dotnet','.gradle','.docker','.ssh','.vscode',
  '.cursor','.android','.templateengine','IntelGraphicsProfiles','MicrosoftEdgeBackups'
)

# Dot-directories are tool state, not projects you built. Scanning them
# produced 248 "projects" on this machine and buried the real ones. Agent
# session stores are picked up separately and deliberately below.
$AGENT_STORE_DIRS = @('.openclaw','.claude','.hermes')

# Directories never descended into when sampling a project.
$SKIP_DIR = 'node_modules|\.git|target|\.venv|venv|__pycache__|dist|build|\.next|\.nuxt|\.turbo|coverage|\.pytest_cache|\.mypy_cache|obj|bin'

$MARKER_FILES = @(
  'package.json','Cargo.toml','pyproject.toml','requirements.txt','Pipfile',
  'go.mod','pom.xml','build.gradle','Gemfile','composer.json',
  'docker-compose.yml','docker-compose.yaml','Dockerfile','README.md'
)

function Sample-Project([string]$root) {
  $files = New-Object System.Collections.ArrayList
  $stack = New-Object System.Collections.Stack
  $stack.Push(@{ p = $root; d = 0 })
  $count = 0

  while ($stack.Count -gt 0 -and $count -lt $MAXFILES) {
    $node = $stack.Pop()
    if ($node.d -gt $MAXDEPTH) { continue }

    foreach ($item in (Get-ChildItem -LiteralPath $node.p -Force -ErrorAction SilentlyContinue)) {
      if ($item.PSIsContainer) {
        if ($item.Name -match "^($SKIP_DIR)$") { continue }
        $stack.Push(@{ p = $item.FullName; d = $node.d + 1 })
      } else {
        [void]$files.Add([pscustomobject]@{
          path  = $item.FullName
          mtime = $item.LastWriteTime.ToString('o')
        })
        $count++
        if ($count -ge $MAXFILES) { break }
      }
    }
  }
  return $files
}

function Get-Markers([string]$root) {
  $found = New-Object System.Collections.ArrayList
  foreach ($m in $MARKER_FILES) {
    if (Test-Path -LiteralPath (Join-Path $root $m)) { [void]$found.Add($m) }
  }
  if (Test-Path -LiteralPath (Join-Path $root '.git')) { [void]$found.Add('.git') }
  if (Get-ChildItem -LiteralPath $root -Filter *.sln -File -ErrorAction SilentlyContinue | Select-Object -First 1) { [void]$found.Add('.sln') }
  if (Get-ChildItem -LiteralPath $root -Filter *.bat -File -ErrorAction SilentlyContinue | Select-Object -First 1) { [void]$found.Add('bat') }
  return @($found)
}

function Get-GitInfo([string]$root) {
  $g = Join-Path $root '.git'
  if (-not (Test-Path -LiteralPath $g)) { return $null }
  $branch = $null; $last = $null
  $headFile = Join-Path $g 'HEAD'
  if (Test-Path -LiteralPath $headFile) {
    $head = (Get-Content -LiteralPath $headFile -TotalCount 1)
    if ($head -match 'ref:\s*refs/heads/(.+)$') { $branch = $Matches[1].Trim() }
  }
  # Commit time comes from the reflog's mtime — reading it costs nothing and
  # does not require git to be installed.
  $logHead = Join-Path $g 'logs\HEAD'
  if (Test-Path -LiteralPath $logHead) { $last = (Get-Item -LiteralPath $logHead).LastWriteTime.ToString('o') }
  return [pscustomobject]@{ branch = $branch; lastCommit = $last }
}

$projects = New-Object System.Collections.ArrayList

# ---- 1. user project folders (top level only) ----
foreach ($dir in (Get-ChildItem -LiteralPath $HOMEDIR -Directory -Force -ErrorAction SilentlyContinue)) {
  if ($SKIP_TOP -contains $dir.Name) { continue }
  if ($AGENT_STORE_DIRS -contains $dir.Name) { continue }   # handled as agent stores

  $markers = Get-Markers $dir.FullName

  # A dot-directory with no project marker is tool state, not something you
  # built. Requiring a marker here is what separates 248 folders from ~40 real
  # projects.
  if ($dir.Name.StartsWith('.') -and $markers.Count -eq 0) { continue }

  $files = Sample-Project $dir.FullName
  if ($markers.Count -eq 0 -and $files.Count -eq 0) { continue }
  $git = Get-GitInfo $dir.FullName

  [void]$projects.Add([pscustomobject]@{
    path          = $dir.FullName
    kind          = 'project'
    markers       = $markers
    files         = @($files | Sort-Object mtime -Descending | Select-Object -First $RETURN)
    fileCount     = $files.Count
    gitBranch     = if ($git) { $git.branch } else { $null }
    gitLastCommit = if ($git) { $git.lastCommit } else { $null }
    sessionCount  = 0
  })
}

# ---- 2. agent session stores ----
# Claude Code keeps one folder per project, each holding .jsonl transcripts.
$claudeProjects = Join-Path $HOMEDIR '.claude\projects'
if (Test-Path -LiteralPath $claudeProjects) {
  foreach ($d in (Get-ChildItem -LiteralPath $claudeProjects -Directory -ErrorAction SilentlyContinue)) {
    $jsonl = @(Get-ChildItem -LiteralPath $d.FullName -Filter *.jsonl -File -ErrorAction SilentlyContinue)
    $peer  = @(Get-ChildItem -LiteralPath $claudeProjects -Filter "$($d.Name).jsonl" -File -ErrorAction SilentlyContinue)
    $all   = @($jsonl) + @($peer)
    if ($all.Count -eq 0) { continue }
    # Folder names are the project path with separators mangled to dashes.
    $decoded = $d.Name -replace '^C--','C:\' -replace '-','\'
    [void]$projects.Add([pscustomobject]@{
      path          = $d.FullName
      kind          = 'agent-sessions'
      agent         = 'Claude Code'
      subject       = $decoded
      markers       = @()
      files         = @($all | ForEach-Object { [pscustomobject]@{ path = $_.FullName; mtime = $_.LastWriteTime.ToString('o') } })
      gitBranch     = $null
      gitLastCommit = $null
      sessionCount  = $all.Count
    })
  }
}

# Hermes and OpenClaw keep their own session stores.
foreach ($store in @(
  @{ p = (Join-Path $env:LOCALAPPDATA 'hermes\sessions'); agent = 'Hermes' },
  @{ p = (Join-Path $HOMEDIR '.openclaw');                agent = 'OpenClaw' }
)) {
  if (-not (Test-Path -LiteralPath $store.p)) { continue }
  $files = Sample-Project $store.p
  if ($files.Count -eq 0) { continue }
  [void]$projects.Add([pscustomobject]@{
    path          = $store.p
    kind          = 'agent-sessions'
    agent         = $store.agent
    markers       = @()
    files         = @($files | Sort-Object mtime -Descending | Select-Object -First $RETURN)
    fileCount     = $files.Count
    gitBranch     = $null
    gitLastCommit = $null
    sessionCount  = @($files | Where-Object { $_.path -match '\.(json|jsonl|db)$' }).Count
  })
}

[pscustomobject]@{
  ts       = (Get-Date).ToString('o')
  home     = $HOMEDIR
  scanned  = $projects.Count
  projects = @($projects)
} | ConvertTo-Json -Depth 6 -Compress
