@echo off
chcp 65001 >nul
title 启用桌面透明（acrylic）
setlocal enabledelayedexpansion

call "%~dp0_find-node.cmd"
if errorlevel 1 exit /b 1

echo ============================================
echo  启用 DSH 桌面透明（acrylic 磨砂）
echo ============================================
echo.
echo  会关闭并重启 DeepSeek Harness，首次运行会备份
echo  app.asar（约 200+ MB）。没装 Node.js 也能用，脚本
echo  会自动找 DSH 自带的 node。
echo.
set /p CONFIRM=继续？[Y/N] 
if /i not "%CONFIRM%"=="Y" (
  echo 已取消。
  pause
  exit /b 0
)

"%NODE_EXE%" "%~dp0..\tools\transparency.mjs" apply
echo.
pause
