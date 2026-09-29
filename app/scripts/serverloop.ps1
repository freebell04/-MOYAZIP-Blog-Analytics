$ErrorActionPreference = "Continue"
# app\scripts → app (server.js, data, node_modules가 있는 곳)
$app = Split-Path $PSScriptRoot
Set-Location -Path $app

# 화면에 안 보이는 상태로 돌기 때문에, 문제가 생기면 여기 로그 파일에서 확인할 수 있게 남긴다.
# (PowerShell의 "*>>" 파이프는 자식 프로세스 출력을 한글 코드페이지로 잘못 해석해 로그가 깨지므로,
# Start-Process의 OS 수준 리다이렉션을 써서 원본 바이트 그대로 저장한다)
$logPath = Join-Path $app "server.log"

while ($true) {
  "===== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') 서버 시작 =====" | Out-File -FilePath $logPath -Append -Encoding UTF8
  # 절대경로로 실행해야 나중에 이 서버를 "이 폴더 것"으로 구분해서 끌 수 있다.
  $proc = Start-Process -FilePath "node" -ArgumentList "`"$app\server.js`"" -NoNewWindow -PassThru `
    -RedirectStandardOutput "$logPath.out" -RedirectStandardError "$logPath.err"
  $null = $proc.Handle   # 이걸 먼저 잡아둬야 끝난 뒤 ExitCode를 읽을 수 있다 (안 하면 빈 값)
  Wait-Process -Id $proc.Id -ErrorAction SilentlyContinue
  Get-Content "$logPath.out" -Encoding UTF8 -ErrorAction SilentlyContinue | Out-File -FilePath $logPath -Append -Encoding UTF8
  Get-Content "$logPath.err" -Encoding UTF8 -ErrorAction SilentlyContinue | Out-File -FilePath $logPath -Append -Encoding UTF8
  Remove-Item "$logPath.out", "$logPath.err" -ErrorAction SilentlyContinue
  $code = $proc.ExitCode
  # 처음 설정을 저장하면 프로그램이 스스로 다시 시작해요 (종료 코드 3)
  if ($code -ne 3) {
    # 켜지자마자 꺼졌다면 로딩 화면이 계속 기다리지 않도록, 에러 내용을 로딩 화면에 보여준다
    if (((Get-Date) - $proc.StartTime).TotalSeconds -lt 30 -and $code -ne 0) {
      # 스택 추적 말고 실제 오류 문장(…Error: …)을 골라서 보여준다
      $recent = Get-Content $logPath -Encoding UTF8 -Tail 40 -ErrorAction SilentlyContinue
      $tail = ($recent | Where-Object { $_ -cmatch "Error\b" -and $_ -notmatch "^\s+at " } | Select-Object -First 1)
      if (-not $tail) { $tail = ($recent | Select-Object -Last 2) -join " / " }
      if ($tail -match "Cannot find module" -and $tail -match "node_modules") {
        # 설치 파일이 망가진 경우: 완료 표시를 지워두면 다음 실행 때 preflight가 통째로 새로 설치한다
        Remove-Item (Join-Path $app "node_modules\.nbh-pkg-hash") -Force -ErrorAction SilentlyContinue
        $errMsg = "설치 파일 일부가 빠져 있어서 서버가 켜지지 않았어요. 실행하기.vbs를 한 번 더 누르면 자동으로 새로 설치해서 고쳐요."
      } else {
        $errMsg = "서버가 켜지다가 멈췄어요. ($tail) — 폴더 app\server.log에 자세한 내용이 있어요."
      }
      $j = @{ step = -1; msg = ""; err = $errMsg; url = "" } | ConvertTo-Json -Compress
      [System.IO.File]::WriteAllText((Join-Path $env:TEMP "nbh-status.js"), "window.NBH=$j;", (New-Object System.Text.UTF8Encoding($false)))
    }
    break
  }
}
"===== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') 서버 종료 (코드 $code) =====" | Out-File -FilePath $logPath -Append -Encoding UTF8
