$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

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

# 이 폴더에서 이미 떠 있는 서버가 있으면 정리한다 (업데이트했는데 옛날 서버가 계속 떠 있는 걸 막기 위함)
function Stop-MyOldServer {
  $mine = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($PSScriptRoot.ToLower()) -and $_.CommandLine -like "*server.js*" }
  if ($mine) {
    $mine | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 800
  }
}

# 아무 창도 안 뜨니까, 지금 뭐라도 되고 있다는 걸 보여줄 게 이 로딩 화면뿐이다.
# 그래서 다른 어떤 검사보다도 먼저, 맨 처음에 띄운다 (첫 설치로 몇 분 걸려도 계속 이 화면이 보인다).
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
  <p>서버를 준비하고 있어요...</p>
  <p class="sub" id="sub">잠시만 기다려주세요 (처음 켤 땐 몇 분 걸릴 수 있어요)</p>
</div>
<script>
  var target = "http://localhost:3300/";
  var tries = 0;
  function check() {
    tries++;
    fetch(target, { mode: "no-cors", cache: "no-store" })
      .then(function () { location.href = target; })
      .catch(function () {
        if (tries === 60) document.getElementById("sub").textContent = "생각보다 오래 걸리네요... 문제가 있다면 알림창이 뜰 거예요.";
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

if (Test-PortOpen 3300) {
  # 이미 (이 폴더든 다른 폴더든) 뭔가 3300번에 떠 있으면, 로딩 화면이 알아서 그걸 감지해 넘어간다.
  # 다만 그게 이 프로그램의 다른 복사본일 수 있어서 한 번은 알려준다.
  Show-ErrorBox "포트 3300을 다른 프로그램(또는 이 프로그램을 풀어둔 다른 폴더)이 쓰고 있어요.`n`n이 프로그램을 여러 폴더에 압축 풀어두셨다면, 하나만 남기고 나머지는 꺼주세요."
  exit 0
}

if (-not (Test-Path (Join-Path $PSScriptRoot "node_modules"))) {
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

# 실제 서버는 화면에 안 보이는 상태로 뒤에서 돌린다. 끌 때는 같은 폴더의 종료하기.bat을 쓰면 된다.
Start-Process -FilePath "powershell.exe" `
  -ArgumentList "-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", "`"$PSScriptRoot\serverloop.ps1`"" `
  -WindowStyle Hidden
