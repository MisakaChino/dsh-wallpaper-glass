@echo off
chcp 65001 >nul
title 关闭桌面透明（还原）
setlocal enabledelayedexpansion

call "%~dp0_find-node.cmd"
if errorlevel 1 exit /b 1

echo ============================================
echo  还原 DSH 桌面透明
echo ============================================
echo.
echo  会用最近的 app.asar.bak-* 备份还原，并重启应用。
echo.
set /p CONFIRM=继续？[Y/N] 
if /i not "%CONFIRM%"=="Y" (
  echo 已取消。
  pause
  exit /b 0
)

"%NODE_EXE%" "%~dp0..\tools\transparency.mjs" revert
echo.
pause
