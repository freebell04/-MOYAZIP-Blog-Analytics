$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms

# app\scripts → app → 설치 폴더
$root = (Split-Path (Split-Path $PSScriptRoot)).ToLower()
$mine = Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($root) -and ($_.CommandLine -like "*server.js*" -or $_.CommandLine -like "*serverloop.ps1*") }

if (-not $mine) {
  $msg = "지금 실행 중인 서버가 없어요."
} else {
  # node와, 그걸 감시하며 재시작해주는 serverloop.ps1을 같이 꺼야 확실히 멈춘다
  $mine | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  $msg = "서버를 껐어요."
}
[System.Windows.Forms.MessageBox]::Show($msg, "네이버 블로그 도우미", "OK", "Information") | Out-Null
