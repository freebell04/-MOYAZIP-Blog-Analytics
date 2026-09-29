$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$Host.UI.RawUI.WindowTitle = "네이버 블로그 도우미 종료"

$root = $PSScriptRoot.ToLower()
$mine = Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($root) -and ($_.CommandLine -like "*server.js*" -or $_.CommandLine -like "*serverloop.ps1*") }

if (-not $mine) {
  Write-Host "지금 실행 중인 서버가 없어요."
} else {
  # node를 먼저 끄고, 그걸 감시하며 재시작해주는 serverloop.ps1도 같이 꺼야 확실히 멈춘다
  $mine | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Write-Host "✅ 서버를 껐어요."
}
Read-Host "닫으려면 Enter를 누르세요"
