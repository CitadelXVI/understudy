@echo off
setlocal
rem Start Understudy on Windows and open it in the browser.  Clips, projects,
rem poses and daily backups are kept in demo-output\.
rem
rem   scripts\start.bat                      serve on http://127.0.0.1:8094
rem   scripts\start.bat -gemx C:\GEM-X       extra flags go to the server
rem
rem The server runs in this window; press Ctrl+C or close the window to stop
rem it, or run scripts\stop.bat from anywhere.  Build first with
rem scripts\build.bat and download weights with scripts\get-weights.bat.
cd /d "%~dp0.."

set "ADDR=127.0.0.1:8094"
set "URL=http://%ADDR%"

if not exist "build\understudy.exe" (
    echo build\understudy.exe not found.  Build it first with: scripts\build.bat
    exit /b 1
)
if not exist "kimodo.cpp\build\release\kmd-generate.exe" (
    echo kimodo.cpp\build\release\kmd-generate.exe not found.  Build it first with: scripts\build.bat
    exit /b 1
)
if not exist "models\*.gguf" (
    echo Warning: no motion model in models\.  Download one with: scripts\get-weights.bat
)

tasklist /fi "imagename eq understudy.exe" 2>nul | findstr /i /c:"understudy.exe" >nul
if not errorlevel 1 (
    echo Understudy is already running at %URL% -- scripts\stop.bat stops it.
    start "" "%URL%"
    exit /b 0
)

echo Understudy: %URL%
echo Press Ctrl+C here or run scripts\stop.bat to stop it.
echo.
start "" /b cmd /c "ping -n 4 127.0.0.1 >nul & start "" "%URL%""
build\understudy.exe -addr %ADDR% -generator kimodo.cpp/build/release/kmd-generate -output demo-output %*
