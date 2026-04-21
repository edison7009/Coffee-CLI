@echo off
echo Starting Coffee CLI Dev (Release profile)...
echo This compiles the Rust backend with release optimizations (opt-level=z + LTO).
echo First run rebuilds all dependencies and may take 2-5 minutes.
echo.

cd /d "%~dp0"

cargo tauri dev --release

pause
