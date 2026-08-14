@echo off
setlocal
chcp 65001 >nul

cd /d "%~dp0.."

echo ========================================
echo   DeepSeek Harness Installer Build
echo ========================================
echo.

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1" -Target Installer
set "BUILD_EXIT_CODE=%ERRORLEVEL%"

echo.
if "%BUILD_EXIT_CODE%"=="0" (
  echo Installer build completed successfully.
) else (
  echo Installer build failed with exit code %BUILD_EXIT_CODE%.
)
echo.
pause
exit /b %BUILD_EXIT_CODE%
