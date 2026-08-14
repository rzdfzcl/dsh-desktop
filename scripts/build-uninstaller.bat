@echo off
setlocal
chcp 65001 >nul

cd /d "%~dp0.."

echo ========================================
echo   DeepSeek Harness Uninstaller Build
echo ========================================
echo.

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1" -Target Uninstaller -SkipInstall
set "BUILD_EXIT_CODE=%ERRORLEVEL%"

echo.
if "%BUILD_EXIT_CODE%"=="0" (
  echo Uninstaller build completed successfully.
) else (
  echo Uninstaller build failed with exit code %BUILD_EXIT_CODE%.
)
echo.
pause
exit /b %BUILD_EXIT_CODE%
