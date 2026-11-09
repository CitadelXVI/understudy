@echo off
setlocal
rem Build Understudy on Windows: kimodo.cpp's native text-to-motion worker
rem (kimodo.cpp\build\release\kmd-generate.exe) and the Understudy server
rem (build\understudy.exe).
rem
rem   scripts\build.bat
rem
rem Needs Visual Studio 2022 or later with "Desktop development with C++" and
rem its CMake tools (or CMake and Ninja on PATH), the Vulkan SDK, Go and Git.
rem Runs from any shell: when the x64 toolchain is not loaded it finds Visual
rem Studio and loads it for this script only.

for %%I in ("%~dp0..") do set "ROOT=%%~fI"
set "KROOT=%ROOT%\kimodo.cpp"

if exist "%KROOT%\CMakeLists.txt" goto have_kimodo
echo Checking out the kimodo.cpp submodule...
git -C "%ROOT%" submodule update --init --recursive || goto submodule_failed
:have_kimodo

rem The toolchain, CMake, Ninja, the Vulkan SDK and kimodo.cpp's own submodules.
call "%KROOT%\scripts\build\windows_prepare.bat" "%KROOT%"
if errorlevel 1 exit /b 1

set "GO=go"
where go >nul 2>nul || set "GO=C:\Program Files\Go\bin\go.exe"
if not exist "%GO%" if not "%GO%"=="go" goto no_go

rem Windows will not replace a running executable.
tasklist /fi "imagename eq understudy.exe" 2>nul | findstr /i /c:"understudy.exe" >nul
if not errorlevel 1 goto server_running

cd /d "%KROOT%"
echo.
echo Building kmd-generate...
cmake --preset windows-release || goto build_failed
cmake --build --preset windows-release --target kmd-generate || goto build_failed

cd /d "%ROOT%"
echo.
echo Building the Understudy server...
"%GO%" build -o build\understudy.exe . || goto build_failed

echo.
echo Built:
echo   kimodo.cpp\build\release\kmd-generate.exe   text-to-motion worker
echo   build\understudy.exe                         Understudy server
echo.
echo Next: scripts\get-weights.bat (once), then scripts\start.bat
exit /b 0

:submodule_failed
echo git submodule update failed.  Clone with: git clone --recursive https://github.com/CitadelXVI/understudy
exit /b 1

:no_go
echo Go was not found.  Install it with: winget install GoLang.Go
exit /b 1

:server_running
echo Understudy is running and holds files this build replaces.
echo Stop it first with scripts\stop.bat.
exit /b 1

:build_failed
echo Build failed.
exit /b 1
