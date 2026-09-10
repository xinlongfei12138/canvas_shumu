@echo off
setlocal
title Infinite Canvas Update
echo Checking for Canvas updates...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Update-Canvas.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo.
  echo Update did not complete. Exit code: %EXIT_CODE%
) else (
  echo.
  echo Update check, dependency check, and build completed.
)
pause
exit /b %EXIT_CODE%
