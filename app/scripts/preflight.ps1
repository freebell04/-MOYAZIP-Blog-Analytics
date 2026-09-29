$ErrorActionPreference = "Stop"
# 예상 못 한 오류로 멈추면 로딩 화면이 영원히 기다리지 않도록, 무엇이든 화면에 보여주고 끝낸다
trap { try { Set-Status -1 "" "켜는 중 예상치 못한 문제가 생겼어요: $($_.Exception.Message)" } catch {}; exit 1 }
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

# 폴더 구조:  설치폴더\실행하기.vbs,  설치폴더\app\(server.js, data, ...),  설치폴더\app\scripts\(이 파일)
$app = Split-Path $PSScriptRoot
$root = Split-Path $app
Set-Location -Path $app

$REPO = "freebell04/-MOYAZIP-Blog-Analytics"
$port = if ($env:NBH_PORT) { [int]$env:NBH_PORT } else { 3300 }  # NBH_PORT: 테스트용
$env:PORT = "$port"                                                # serverloop → node 로 그대로 전달된다
$url = "http://localhost:$port/"
$verFile = Join-Path $app ".version"
$staged = Join-Path $app ".staged"   # 뒤에서 미리 받아둔 새 버전 (다음 실행 때 바로 적용)

# ---------------------------------------------------------------------------
# 진행 상황 표시: 로딩 화면(file://)이 0.3초마다 이 js 파일을 다시 읽어서 단계·메시지를 보여준다.
#   step 0 준비 · 1 업데이트 적용 · 2 필요한 파일 확인 · 3 서버 켜기
# ---------------------------------------------------------------------------
$statusPath = Join-Path $env:TEMP "nbh-status.js"
function Set-Status($step, $msg, $err = "") {
  $j = @{ step = $step; msg = $msg; err = $err; url = $url } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($statusPath, "window.NBH=$j;", (New-Object System.Text.UTF8Encoding($false)))
}
function Fail($msg) { Set-Status -1 "" $msg; exit 1 }

function Test-PortOpen($portNum) {
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $result = $client.BeginConnect("127.0.0.1", $portNum, $null, $null)
    $ok = $result.AsyncWaitHandle.WaitOne(200)
    if ($ok -and $client.Connected) { $client.Close(); return $true }
    $client.Close()
    return $false
  } catch { return $false }
}

function Get-MyServerProcs {
  $r = $root.ToLower()
  Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.ToLower().Contains($r) -and ($_.CommandLine -like "*server.js*" -or $_.CommandLine -like "*serverloop.ps1*") }
}
function Stop-MyServer {
  $procs = Get-MyServerProcs
  if ($procs) {
    $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 600
  }
}

# 예전 버전(모든 파일이 설치 폴더 바로 아래)에서 넘어온 경우: data를 app\data로 옮기고 남은 옛 파일을 정리한다.
function Move-LegacyLayout {
  $oldData = Join-Path $root "data"
  $newData = Join-Path $app "data"
  if ((Test-Path $oldData) -and -not (Test-Path $newData)) {
    Stop-MyServer
    # 옛날 서버가 띄운 네이버 로그인용 크롬이 data\chrome-profile을 잡고 있으면 옮기지 못한다
    $chromeProfile = (Join-Path $oldData "chrome-profile").ToLower()
    Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($chromeProfile) } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 500
    Move-Item -Path $oldData -Destination $newData
  }
  $legacy = @(
    "server.js", "package.json", "package-lock.json", "style-guide.md", "lib", "public", "node_modules",
    "preflight.ps1", "serverloop.ps1", "stop.ps1", "update.ps1", "run.ps1",
    "실행하기.bat", "업데이트하기.bat", "종료하기.bat",
    "server.log", "server.log.out", "server.log.err",
    # GitHub 소개 페이지용 파일 (프로그램엔 필요 없음)
    "index.html", ".nojekyll", ".gitignore"
  )
  foreach ($name in $legacy) {
    $p = Join-Path $root $name
    if (Test-Path $p) { Remove-Item -Path $p -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

# 지난번 실행 때 뒤에서 미리 받아둔 새 버전이 있으면 적용한다 (인터넷 없이 로컬 복사라 몇 초면 끝난다).
function Apply-StagedUpdate {
  $ready = Join-Path $staged "READY"
  if (-not (Test-Path $ready)) { return $false }
  $sha = (Get-Content $ready -Raw).Trim()
  $src = Get-ChildItem $staged -Directory | Select-Object -First 1
  robocopy $src.FullName $root /E /XD data node_modules .git .staged /XF .gitignore .version server.log `
    (Join-Path $src.FullName "index.html") (Join-Path $src.FullName ".nojekyll") /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "새 버전 파일 복사 실패 (robocopy $LASTEXITCODE)" }
  Set-Content -Path $verFile -Value $sha -Encoding ASCII
  Remove-Item $staged -Recurse -Force -ErrorAction SilentlyContinue
  return $true
}

# package.json이 바뀌었을 때만 npm install (매번 하면 느리다)
function Test-NeedInstall {
  $nm = Join-Path $app "node_modules"
  if (-not (Test-Path $nm)) { return $true }
  $hashFile = Join-Path $nm ".nbh-pkg-hash"
  $h = (Get-FileHash (Join-Path $app "package.json") -Algorithm SHA1).Hash
  return -not ((Test-Path $hashFile) -and ((Get-Content $hashFile -Raw).Trim() -eq $h))
}
function Save-InstallHash {
  $h = (Get-FileHash (Join-Path $app "package.json") -Algorithm SHA1).Hash
  Set-Content -Path (Join-Path $app "node_modules\.nbh-pkg-hash") -Value $h -Encoding ASCII
}

function Test-PlaywrightChromium {
  $base = Join-Path $env:LOCALAPPDATA "ms-playwright"
  if (-not (Test-Path $base)) { return $false }
  return $null -ne (Get-ChildItem $base -Directory -Filter "chromium_headless_shell-*" -ErrorAction SilentlyContinue | Select-Object -First 1)
}

# 서버가 켜진 뒤 뒤에서 새 버전을 확인하고, 있으면 받아서 .staged에 준비만 해둔다.
# (사용자는 기다리지 않는다. 다음에 실행할 때 Apply-StagedUpdate가 몇 초 만에 적용)
function Stage-UpdateInBackground {
  try {
    $latest = (Invoke-RestMethod -Uri "https://api.github.com/repos/$REPO/commits/main" -TimeoutSec 8 `
      -Headers @{ "User-Agent" = "naver-blog-helper" }).sha
  } catch { return }
  if (-not $latest) { return }
  $current = if (Test-Path $verFile) { (Get-Content $verFile -Raw).Trim() } else { "" }
  if (-not $current) { Set-Content -Path $verFile -Value $latest -Encoding ASCII; return }  # 방금 받은 압축본 = 최신
  if ($current -eq $latest) { return }
  if ((Test-Path (Join-Path $staged "READY")) -and ((Get-Content (Join-Path $staged "READY") -Raw).Trim() -eq $latest)) { return }

  Remove-Item $staged -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Path $staged | Out-Null
  try {
    $zip = Join-Path $staged "main.zip"
    Invoke-WebRequest -Uri "https://github.com/$REPO/archive/refs/heads/main.zip" -OutFile $zip -UseBasicParsing -TimeoutSec 180
    Expand-Archive -Path $zip -DestinationPath $staged -Force
    Remove-Item $zip -Force
    Set-Content -Path (Join-Path $staged "READY") -Value $latest -Encoding ASCII   # 다 받은 뒤에만 표시
  } catch {
    Remove-Item $staged -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# ===========================================================================
# 1) 이미 켜져 있으면: 기다릴 것 없이 바로 화면을 연다
# ===========================================================================
if (Test-PortOpen $port) {
  if (-not $env:NBH_NO_BROWSER) { Start-Process $url }
  Stage-UpdateInBackground
  exit 0
}

# ===========================================================================
# 2) 로딩 화면부터 띄운다 (이후 모든 진행 상황이 여기 표시된다)
# ===========================================================================
Set-Status 0 "준비하는 중이에요"
$loadingPath = Join-Path $env:TEMP "nbh-loading.html"
Copy-Item (Join-Path $PSScriptRoot "loading.html") $loadingPath -Force
if (-not $env:NBH_NO_BROWSER) { Start-Process $loadingPath }   # NBH_NO_BROWSER: 테스트용

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail "Node.js가 설치되어 있지 않아요. https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행해주세요."
}

try { Move-LegacyLayout } catch {
  Fail "예전 버전의 설정 폴더(data)를 새 위치로 옮기지 못했어요. 네이버 로그인용 크롬 창을 모두 닫고 다시 실행해주세요. ($($_.Exception.Message))"
}

# 포트는 닫혀 있는데 이 폴더의 serverloop가 남아 있을 수 있다(서버가 막 죽은 경우 등) → 정리
Stop-MyServer

if (Test-Path (Join-Path $staged "READY")) {
  Set-Status 1 "새 버전을 적용하는 중이에요"
  try { [void](Apply-StagedUpdate) } catch { Remove-Item $staged -Recurse -Force -ErrorAction SilentlyContinue }
}

if (Test-NeedInstall) {
  Set-Status 2 "필요한 파일을 설치하는 중이에요 (처음이나 큰 업데이트 때만, 1~2분)"
  # PowerShell 5.1은 npm 경고(stderr)를 치명적 오류로 취급해서 스크립트가 죽는다 → cmd로 돌린다
  cmd /c "npm install --omit=dev --no-audit --no-fund >nul 2>&1"
  if ($LASTEXITCODE -ne 0) { Fail "필요한 파일을 설치하는 중 오류가 났어요. 인터넷 연결을 확인하고 다시 실행해주세요." }
  Save-InstallHash
}
if (-not (Test-PlaywrightChromium)) {
  Set-Status 2 "글 검색용 내부 브라우저를 받는 중이에요 (처음 한 번만, 2~5분)"
  cmd /c "npx playwright install chromium >nul 2>&1"
  if ($LASTEXITCODE -ne 0) { Fail "글 검색 기능에 필요한 내부 브라우저 설치에 실패했어요. 인터넷 연결을 확인하고 다시 실행해주세요." }
}

Set-Status 3 "서버를 켜는 중이에요"
Start-Process -FilePath "powershell.exe" `
  -ArgumentList "-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", "`"$PSScriptRoot\serverloop.ps1`"" `
  -WindowStyle Hidden

# 서버가 켜진 뒤에 뒤에서 새 버전 확인 (사용자는 기다리지 않는다)
Stage-UpdateInBackground
