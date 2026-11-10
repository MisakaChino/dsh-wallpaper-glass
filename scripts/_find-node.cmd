@echo off
rem Locates a usable node.exe: PATH first, then the runtime shipped with DSH.
rem Exports NODE_EXE. Does not require PowerShell or admin rights.
setlocal enabledelayedexpansion
set "NODE_EXE="

for /f "delims=" %%I in ('where node 2^>nul') do (
  if not defined NODE_EXE set "NODE_EXE=%%I"
)

if not defined NODE_EXE (
  for %%R in ("%USERPROFILE%\.dsh\dsh-runtimes") do (
    if exist "%%~fR" (
      for /f "delims=" %%D in ('dir /b /ad "%%~fR" 2^>nul') do (
        if not defined NODE_EXE (
          if exist "%%~fR\%%D\dependencies\node\bin\node.exe" set "NODE_EXE=%%~fR\%%D\dependencies\node\bin\node.exe"
        )
      )
    )
  )
)

if not defined NODE_EXE (
  echo [失败] 找不到 node.exe：PATH 里没有，也没找到 DSH 自带的运行时。
  echo        请安装 Node.js 18+ 后重试： https://nodejs.org
  endlocal
  exit /b 1
)

endlocal & set "NODE_EXE=%NODE_EXE%"
exit /b 0
