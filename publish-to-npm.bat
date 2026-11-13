@echo off
chcp 65001 >nul
title Figma Canvas MCP - npm publish
color 0A

echo ======================================================================
echo   FIGMA CANVAS MCP - NPM PUBLISH
echo ======================================================================
echo.

cd /d "%~dp0server"

echo [1/2] Проверка сборки TypeScript...
call npm run build
if %ERRORLEVEL% NEQ 0 (
    color 0C
    echo.
    echo [ОШИБКА] Ошибка при сборке проекта.
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo [2/2] Публикация пакета figma-canvas-mcp в npm...
echo.
echo ВНИМАНИЕ: Если появится запрос "Enter OTP:" или "This operation requires a one-time password",
echo введи 6 цифр из твоего приложения-аутентификатора (Google Authenticator / 1Password / SMS) и нажми Enter.
echo.

call npm publish --access public

echo.
if %ERRORLEVEL% EQU 0 (
    color 0A
    echo ======================================================================
    echo   [УСПЕХ] Пакет figma-canvas-mcp успешно опубликован в npm!
    echo.
    echo   Теперь любой разработчик может запустить его командой:
    echo     npx -y figma-canvas-mcp
    echo ======================================================================
) else (
    color 0C
    echo ======================================================================
    echo   [ОШИБКА] Публикация завершилась с ошибкой (код %ERRORLEVEL%).
    echo   Проверь сообщения выше (неправильный 2FA-код или истекло время).
    echo ======================================================================
)

echo.
pause
