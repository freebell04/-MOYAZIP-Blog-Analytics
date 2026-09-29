$ErrorActionPreference = "Continue"
Set-Location -Path $PSScriptRoot

# 화면에 안 보이는 상태로 돌기 때문에, 문제가 생기면 여기 로그 파일에서 확인할 수 있게 남긴다.
# (PowerShell의 "*>>" 파이프는 자식 프로세스 출력을 한글 코드페이지로 잘못 해석해 로그가 깨지므로,
# Start-Process의 OS 수준 리다이렉션을 써서 원본 바이트 그대로 저장한다)
$logPath = Join-Path $PSScriptRoot "server.log"

while ($true) {
  "===== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') 서버 시작 =====" | Out-File -FilePath $logPath -Append -Encoding UTF8
  # "server.js"처럼 상대경로로 실행하면 나중에(다음 실행/업데이트 때) 이 서버를 "이 폴더 것"으로
  # 구분하지 못하게 되므로, 항상 절대경로로 실행한다.
  $proc = Start-Process -FilePath "node" -ArgumentList "`"$PSScriptRoot\server.js`"" -NoNewWindow -PassThru `
    -RedirectStandardOutput "$logPath.out" -RedirectStandardError "$logPath.err"
  Wait-Process -Id $proc.Id -ErrorAction SilentlyContinue
  Get-Content "$logPath.out" -Encoding UTF8 -ErrorAction SilentlyContinue | Out-File -FilePath $logPath -Append -Encoding UTF8
  Get-Content "$logPath.err" -Encoding UTF8 -ErrorAction SilentlyContinue | Out-File -FilePath $logPath -Append -Encoding UTF8
  Remove-Item "$logPath.out", "$logPath.err" -ErrorAction SilentlyContinue
  $code = $proc.ExitCode
  # 처음 설정을 저장하면 프로그램이 스스로 다시 시작해요 (종료 코드 3)
  if ($code -ne 3) { break }
}
"===== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') 서버 종료 (코드 $code) =====" | Out-File -FilePath $logPath -Append -Encoding UTF8
