@echo off
chcp 65001 >nul
title 安装 dsh-wallpaper-glass
setlocal enabledelayedexpansion

call "%~dp0_find-node.cmd"
if errorlevel 1 exit /b 1

echo ============================================
echo  安装 dsh-wallpaper-glass 到当前 DSH profile
echo ============================================
echo.
echo  会写入 profile 的 dependencies(link:) 与 bundles，
echo  不会修改应用本体。装完请重启 DeepSeek Harness。
echo.
"%NODE_EXE%" "%~dp0..\tools\install.mjs"
if errorlevel 1 (
  echo.
  echo [失败] 没有写入 profile。
  pause
  exit /b 1
)
echo.
pause
