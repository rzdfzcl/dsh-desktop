@echo off
setlocal
chcp 65001 >nul

cd /d "%~dp0.."

echo ========================================
echo   DeepSeek Harness Portable Build
echo ========================================
echo.

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1" -Target Portable
set "BUILD_EXIT_CODE=%ERRORLEVEL%"

echo.
if "%BUILD_EXIT_CODE%"=="0" (
  echo Portable build completed successfully.
) else (
  echo Portable build failed with exit code %BUILD_EXIT_CODE%.
)
echo.
pause
exit /b %BUILD_EXIT_CODE%
