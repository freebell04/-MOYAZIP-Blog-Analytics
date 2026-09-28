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

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Stop-WithMessage "[!] Node.js가 설치되어 있지 않아요.`n    https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행해주세요."
}

if (-not (Test-Path (Join-Path $PSScriptRoot "node_modules"))) {
  Write-Host "처음 실행이라 필요한 파일을 설치하는 중이에요... (1~2분)"
  npm install --omit=dev
  if ($LASTEXITCODE -ne 0) {
    Stop-WithMessage "[!] 설치 중 오류가 났어요. 인터넷 연결을 확인하고 다시 실행해주세요."
  }
}

Start-Process "http://localhost:3300"

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
