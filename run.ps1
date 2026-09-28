$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$Host.UI.RawUI.WindowTitle = "네이버 블로그 도우미"
Set-Location -Path $PSScriptRoot

function Stop-WithMessage($msg) {
  Write-Host ""
  Write-Host $msg -ForegroundColor Red
  Read-Host "계속하려면 Enter를 누르세요"
  exit 1
}

# 이미 다른 폴더(또는 이전 실행)에서 서버가 떠 있는지 확인. 폴더를 두 번 풀었거나
# 실행하기.bat을 두 번 눌렀을 때 "포트가 이미 사용 중" 에러 화면 대신 그냥 그 화면을 열어준다.
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

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Stop-WithMessage "[!] Node.js가 설치되어 있지 않아요.`n    https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행해주세요."
}

if (Test-PortOpen 3300) {
  Write-Host "이미 실행 중이에요! 브라우저를 열게요."
  Start-Process "http://localhost:3300"
  Read-Host "이 창은 닫아도 돼요 (Enter)"
  exit 0
}

if (-not (Test-Path (Join-Path $PSScriptRoot "node_modules"))) {
  Write-Host "처음 실행이라 필요한 파일을 설치하는 중이에요... (1~2분)"
  npm install --omit=dev
  if ($LASTEXITCODE -ne 0) {
    Stop-WithMessage "[!] 설치 중 오류가 났어요. 인터넷 연결을 확인하고 다시 실행해주세요."
  }
}

# 서버가 실제로 응답할 때까지 기다렸다가 자동으로 넘어가는 로딩 화면을 먼저 띄운다
# (서버가 뜨기 전에 그냥 열면 "사이트에 연결할 수 없음"이 잠깐 보여서 그걸 막는 용도)
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
  <p class="sub" id="sub">잠시만 기다려주세요 (보통 몇 초 안에 끝나요)</p>
</div>
<script>
  var target = "http://localhost:3300/";
  var tries = 0;
  function check() {
    tries++;
    fetch(target, { mode: "no-cors", cache: "no-store" })
      .then(function () { location.href = target; })
      .catch(function () {
        if (tries === 40) document.getElementById("sub").textContent = "시간이 좀 걸리네요... 콘솔 창(검은 창)에 안내가 떠 있는지 확인해보세요.";
        setTimeout(check, 500);
      });
  }
  check();
</script>
</body></html>
'@ | Set-Content -Path $loadingPath -Encoding UTF8
Start-Process $loadingPath

while ($true) {
  Write-Host "============================================"
  Write-Host " 네이버 블로그 도우미 실행 중 (이 창을 닫으면 꺼져요)"
  Write-Host " http://localhost:3300"
  Write-Host "============================================"
  node server.js
  # 처음 설정을 저장하면 프로그램이 스스로 다시 시작해요 (종료 코드 3)
  if ($LASTEXITCODE -ne 3) { break }
}

Write-Host ""
Write-Host "프로그램이 종료되었습니다. 오류가 있다면 위 내용을 확인해주세요."
Read-Host "계속하려면 Enter를 누르세요"
