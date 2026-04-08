@echo off
echo Starting Coffee CLI Dev...

cd /d "%~dp0"

:: Tauri's beforeDevCommand handles starting Vite automatically
cargo tauri dev

pause
