@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 네이버 블로그 도우미

where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js 가 설치되어 있지 않아요.
  echo     https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행해주세요.
  pause
  exit /b 1
)

if not exist node_modules (
  echo 처음 실행이라 필요한 파일을 설치하는 중이에요... (1~2분^)
  call npm install --omit=dev
  if errorlevel 1 (
    echo [!] 설치 중 오류가 났어요. 인터넷 연결을 확인하고 다시 실행해주세요.
    pause
    exit /b 1
  )
)

start "" http://localhost:3300

:run
echo ============================================
echo  네이버 블로그 도우미 실행 중 (이 창을 닫으면 꺼져요^)
echo  http://localhost:3300
echo ============================================
node server.js
rem 처음 설정을 저장하면 프로그램이 스스로 다시 시작해요 (종료 코드 3)
if %ERRORLEVEL%==3 goto run

echo.
echo 프로그램이 종료되었습니다. 오류가 있다면 위 내용을 확인해주세요.
pause
