@echo off
echo Starting Coffee CLI Dev...

cd /d "%~dp0"

:: Start frontend dev server in a separate window
echo Starting Frontend (Vite)...
start cmd /k "cd src-ui && npm run dev"

:: Give vite a few seconds to start up
timeout /t 3 /nobreak >nul

:: Start Tauri backend
echo Starting Backend (Tauri)...
cargo tauri dev

pause
