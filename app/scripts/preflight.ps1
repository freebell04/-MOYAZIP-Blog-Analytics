$ErrorActionPreference = "Stop"
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

# 폴더 구조:  설치폴더\실행하기.vbs,  설치폴더\app\(server.js, data, ...),  설치폴더\app\scripts\(이 파일)
$app = Split-Path $PSScriptRoot
$root = Split-Path $app
Set-Location -Path $app

$REPO = "freebell04/-MOYAZIP-Blog-Analytics"

# 창이 완전히 숨겨진 채로 돌기 때문에, 진짜 문제가 생겼을 때는 콘솔 대신 알림창으로 보여준다.
Add-Type -AssemblyName System.Windows.Forms
function Show-ErrorBox($msg) {
  [System.Windows.Forms.MessageBox]::Show($msg, "네이버 블로그 도우미", "OK", "Error") | Out-Null
}

function Test-PortOpen($portNum) {
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $result = $client.BeginConnect("127.0.0.1", $portNum, $null, $null)
    $ok = $result.AsyncWaitHandle.WaitOne(300)
    if ($ok -and $client.Connected) { $client.Close(); return $true }
    $client.Close()
    return $false
  } catch { return $false }
}

# 이 설치 폴더에서 떠 있는 서버(예전 구조의 서버 포함)를 정리한다.
# 업데이트하면서 파일을 덮어쓰려면, 그 파일을 쓰고 있는 옛날 서버부터 꺼야 한다.
function Stop-MyOldServer {
  $r = $root.ToLower()
  $mine = Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.ToLower().Contains($r) -and ($_.CommandLine -like "*server.js*" -or $_.CommandLine -like "*serverloop.ps1*") }
  if ($mine) {
    $mine | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 800
  }
}

# 예전 버전은 모든 파일이 설치 폴더 바로 아래에 흩어져 있었다. app\ 폴더로 옮긴 뒤 남은 옛 파일을 정리한다.
function Move-LegacyLayout {
  $oldData = Join-Path $root "data"
  $newData = Join-Path $app "data"
  if ((Test-Path $oldData) -and -not (Test-Path $newData)) {
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
    "server.log", "server.log.out", "server.log.err"
  )
  foreach ($name in $legacy) {
    $p = Join-Path $root $name
    if (Test-Path $p) { Remove-Item -Path $p -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

# GitHub의 최신 버전과 비교해서, 새 버전이 있으면 받아서 덮어쓴다 (data, node_modules는 건드리지 않는다).
# 인터넷이 안 되거나 GitHub이 응답하지 않으면 조용히 건너뛰고 지금 버전으로 실행한다.
function Update-IfNeeded {
  $verFile = Join-Path $app ".version"
  try {
    $latest = (Invoke-RestMethod -Uri "https://api.github.com/repos/$REPO/commits/main" -TimeoutSec 5 `
      -Headers @{ "User-Agent" = "naver-blog-helper" }).sha
  } catch { return $false }
  if (-not $latest) { return $false }
  $current = if (Test-Path $verFile) { (Get-Content $verFile -Raw).Trim() } else { "" }
  if ($current -eq $latest) { return $false }
  if (-not $current) {
    # 방금 새로 받은 압축본(또는 업데이트 직후)이라 이미 최신이다. 기준만 기록해둔다.
    Set-Content -Path $verFile -Value $latest -Encoding ASCII
    return $false
  }

  $tmp = Join-Path $env:TEMP ("nbh-update-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    $zip = Join-Path $tmp "main.zip"
    Invoke-WebRequest -Uri "https://github.com/$REPO/archive/refs/heads/main.zip" -OutFile $zip -UseBasicParsing -TimeoutSec 120
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $src = Get-ChildItem $tmp -Directory | Select-Object -First 1
    robocopy $src.FullName $root /E /XD data node_modules .git /XF .gitignore .version server.log /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "파일 복사 실패 (robocopy $LASTEXITCODE)" }
    Set-Content -Path $verFile -Value $latest -Encoding ASCII
    return $true
  } catch {
    Show-ErrorBox "새 버전을 받는 중 문제가 생겼어요. 지금 버전으로 실행할게요.`n`n$($_.Exception.Message)"
    return $false
  } finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# 아무 창도 안 뜨니까, 지금 뭐라도 되고 있다는 걸 보여줄 게 이 로딩 화면뿐이다.
# 그래서 다른 어떤 작업보다도 먼저 띄운다 (업데이트·첫 설치로 몇 분 걸려도 계속 이 화면이 보인다).
$loadingPath = Join-Path $env:TEMP "nbh-loading.html"
@'
<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>네이버 블로그 도우미</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#f4f5f7;font-family:'Malgun Gothic',system-ui,sans-serif}
  .box{text-align:center}
  .badge{width:56px;height:56px;border-radius:16px;background:#03c75a;color:#fff;font-weight:800;
    font-size:26px;display:flex;align-items:center;justify-content:center;margin:0 auto 18px}
  .spin{width:28px;height:28px;border:3px solid #e6f9ee;border-top-color:#03c75a;border-radius:50%;
    margin:0 auto 16px;animation:s .8s linear infinite}
  @keyframes s{to{transform:rotate(360deg)}}
  p{color:#1a1a1a;font-size:15px;margin:4px 0}
  .sub{color:#5b5b5b;font-size:13px}
</style></head>
<body><div class="box">
  <div class="badge">N</div>
  <div class="spin"></div>
  <p>최신 버전을 확인하고 준비하는 중이에요...</p>
  <p class="sub" id="sub">잠시만 기다려주세요 (업데이트가 있거나 처음 켤 땐 몇 분 걸릴 수 있어요)</p>
</div>
<script>
  var target = "http://localhost:3300/";
  var tries = 0;
  function check() {
    tries++;
    fetch(target, { mode: "no-cors", cache: "no-store" })
      .then(function () { location.href = target; })
      .catch(function () {
        if (tries === 120) document.getElementById("sub").textContent = "생각보다 오래 걸리네요... 문제가 있다면 알림창이 뜰 거예요.";
        setTimeout(check, 500);
      });
  }
  check();
</script>
</body></html>
'@ | Set-Content -Path $loadingPath -Encoding UTF8
Start-Process $loadingPath

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Show-ErrorBox "Node.js가 설치되어 있지 않아요.`n`nhttps://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행해주세요."
  exit 1
}

Stop-MyOldServer
try { Move-LegacyLayout } catch {
  Show-ErrorBox "예전 버전의 설정 폴더(data)를 새 위치로 옮기지 못했어요.`n네이버 로그인용 크롬 창을 모두 닫고 다시 실행해주세요.`n`n$($_.Exception.Message)"
  exit 1
}

if (Test-PortOpen 3300) {
  Show-ErrorBox "포트 3300을 다른 프로그램(또는 이 프로그램을 풀어둔 다른 폴더)이 쓰고 있어요.`n`n이 프로그램을 여러 폴더에 압축 풀어두셨다면, 하나만 남기고 나머지는 꺼주세요."
  exit 0
}

$updated = Update-IfNeeded

if ($updated -or -not (Test-Path (Join-Path $app "node_modules"))) {
  npm install --omit=dev *> $null
  if ($LASTEXITCODE -ne 0) {
    Show-ErrorBox "필요한 파일을 설치하는 중 오류가 났어요. 인터넷 연결을 확인하고 다시 실행해주세요."
    exit 1
  }
}

# 이웃 글 검색 등에서 쓰는 내부 브라우저(평소 쓰는 크롬과는 별개). 처음 한 번은 따로 받아야 한다.
function Test-PlaywrightChromium {
  $base = Join-Path $env:LOCALAPPDATA "ms-playwright"
  if (-not (Test-Path $base)) { return $false }
  return $null -ne (Get-ChildItem $base -Directory -Filter "chromium_headless_shell-*" -ErrorAction SilentlyContinue | Select-Object -First 1)
}
if (-not (Test-PlaywrightChromium)) {
  npx playwright install chromium *> $null
  if ($LASTEXITCODE -ne 0) {
    Show-ErrorBox "글 검색 기능에 필요한 내부 브라우저 설치에 실패했어요. 인터넷 연결을 확인하고 다시 실행해주세요."
    exit 1
  }
}

# 실제 서버는 화면에 안 보이는 상태로 뒤에서 돌린다. 끌 때는 설치 폴더의 종료하기.vbs를 쓰면 된다.
Start-Process -FilePath "powershell.exe" `
  -ArgumentList "-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", "`"$PSScriptRoot\serverloop.ps1`"" `
  -WindowStyle Hidden
