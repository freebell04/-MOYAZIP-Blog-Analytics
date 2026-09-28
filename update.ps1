$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$Host.UI.RawUI.WindowTitle = "네이버 블로그 도우미 업데이트"
Set-Location -Path $PSScriptRoot

function Stop-WithMessage($msg) {
  Write-Host ""
  Write-Host $msg -ForegroundColor Red
  Read-Host "계속하려면 Enter를 누르세요"
  exit 1
}

Write-Host "============================================"
Write-Host " GitHub에서 최신 버전을 받아오는 중이에요..."
Write-Host " (로그인 정보·설정·통계가 든 data 폴더는 그대로 둬요)"
Write-Host "============================================"

# 실행 중이면 파일을 덮어쓰다 충돌할 수 있어 먼저 꺼둔다
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*$($PSScriptRoot -replace '\\','\\\\')*server.js*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

$zipUrl = "https://github.com/freebell04/-MOYAZIP-Blog-Analytics/archive/refs/heads/main.zip"
$tmpDir = Join-Path $env:TEMP ("nbh-update-" + [guid]::NewGuid())
$zipPath = Join-Path $tmpDir "update.zip"
New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null

try {
  Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing
} catch {
  Stop-WithMessage "[!] 다운로드에 실패했어요. 인터넷 연결을 확인하고 다시 시도해주세요.`n    ($($_.Exception.Message))"
}

Expand-Archive -Path $zipPath -DestinationPath $tmpDir -Force
$extracted = Get-ChildItem $tmpDir -Directory | Select-Object -First 1
if (-not $extracted) {
  Stop-WithMessage "[!] 받은 파일에서 폴더를 찾지 못했어요. 다시 시도해주세요."
}

# data 폴더와 node_modules는 그대로 두고 나머지만 덮어쓴다
robocopy $extracted.FullName $PSScriptRoot /E /XD data node_modules .git /XF .gitignore | Out-Null

Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "필요한 파일을 다시 확인하는 중이에요..."
npm install --omit=dev
if ($LASTEXITCODE -ne 0) {
  Stop-WithMessage "[!] 설치 중 오류가 났어요. 인터넷 연결을 확인하고 실행하기.bat을 다시 눌러주세요."
}

Write-Host ""
Write-Host "✅ 업데이트가 끝났어요! 이제 실행하기.bat을 눌러 시작하세요."
Read-Host "계속하려면 Enter를 누르세요"
