param([switch]$Quiet, [switch]$KeepChrome)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms

# app\scripts → app → 설치 폴더
$root = (Split-Path (Split-Path $PSScriptRoot)).ToLower()
$mine = Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($root) -and ($_.CommandLine -like "*server.js*" -or $_.CommandLine -like "*serverloop.ps1*") }

# 이 프로그램 전용 크롬(블로그·AI 창). 평소 쓰는 크롬(다른 프로필)은 건드리지 않는다
$profileDir = (Join-Path $root "app\data\chrome-profile").ToLower()
$chromes = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($profileDir) }

$closedChrome = $false
$keptWhy = ""
if ($chromes -and -not $KeepChrome) {
  # 저장 안 한 글이 있을 수 있는 네이버 글쓰기 창이 열려 있는지 확인한다
  $writing = $false
  try {
    $tabs = Invoke-RestMethod -Uri "http://localhost:9222/json/list" -TimeoutSec 2
    $writing = @($tabs | Where-Object { $_.type -eq "page" -and $_.url -match "PostWriteForm|postwrite|Redirect=Write|PostUpdateForm" }).Count -gt 0
  } catch {}
  $doClose = $true
  if ($writing) {
    if ($Quiet) {
      $doClose = $false
    } else {
      $ans = [System.Windows.Forms.MessageBox]::Show("네이버 글쓰기 창이 열려 있어요.`n저장하지 않은 글은 창을 닫으면 사라질 수 있어요.`n`n블로그·AI 창도 같이 닫을까요?`n(아니요를 누르면 창은 그대로 두고 프로그램만 꺼요)", "네이버 블로그 도우미", "YesNo", "Question")
      $doClose = ($ans -eq "Yes")
    }
    if (-not $doClose) { $keptWhy = "글쓰기 창이 열려 있어서 창은 그대로 뒀어요." }
  }
  if ($doClose) {
    # 자식 프로세스(렌더러 등)까지 모두 정리
    $chromes | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    $closedChrome = $true
  }
}

if (-not $mine) {
  $msg = "지금 실행 중인 서버가 없어요."
} else {
  # node와, 그걸 감시하며 재시작해주는 serverloop.ps1을 같이 꺼야 확실히 멈춘다
  $mine | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  $msg = "서버를 껐어요."
}
if ($closedChrome) { $msg += "`n블로그·AI 창도 닫았어요." }
elseif ($keptWhy) { $msg += "`n" + $keptWhy }

if ($Quiet) { Write-Output ("RESULT server=" + [bool]$mine + " chromeClosed=" + $closedChrome + " kept=" + $keptWhy) }
else { [System.Windows.Forms.MessageBox]::Show($msg, "네이버 블로그 도우미", "OK", "Information") | Out-Null }
