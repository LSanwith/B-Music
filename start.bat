@echo off
chcp 65001 >nul
title B·Music 网页版
cd /d %~dp0
where node >nul 2>nul
if %errorlevel% neq 0 (
  echo [提示] 未检测到 Node.js，将直接用浏览器打开 index.html（功能完整）。
  start "" "%~dp0index.html"
  pause
  exit /b
)
node server.js
pause
