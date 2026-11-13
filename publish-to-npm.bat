@echo off
title Figma Canvas MCP - npm publish
color 0A

echo ======================================================================
echo   FIGMA CANVAS MCP - NPM PUBLISH
echo ======================================================================
echo.

cd /d "%~dp0server"

echo [1/2] Building TypeScript project...
call npm.cmd run build
if %ERRORLEVEL% NEQ 0 (
    color 0C
    echo.
    echo [ERROR] Build failed.
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo [2/2] Publishing figma-canvas-mcp v0.2.0 to npm...
echo.
set /p OTP="Enter 6-digit 2FA code from your authenticator app (e.g. 123456): "
echo.

if "%OTP%"=="" (
    call npm.cmd publish --access public
) else (
    call npm.cmd publish --access public --otp=%OTP%
)

echo.
if %ERRORLEVEL% EQU 0 (
    color 0A
    echo ======================================================================
    echo   [SUCCESS] Package figma-canvas-mcp v0.2.0 is LIVE on npm!
    echo.
    echo   Anyone can now run: npx -y figma-canvas-mcp
    echo ======================================================================
) else (
    color 0C
    echo ======================================================================
    echo   [ERROR] Publish failed with error code %ERRORLEVEL%.
    echo   Check the messages above.
    echo ======================================================================
)

echo.
pause
