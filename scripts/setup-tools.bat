@echo off
setlocal
rem Set up the optional Python workers:
rem
rem   Clean up    tools\cleanup\.venv         physics-checked foot planting, floor and
rem                                           self-collision fixes (numpy, scipy, MuJoCo)
rem   MotionBricks motionbricks\.venv-ort     in-betweening: regenerate a range, settle,
rem                                           loop (NVIDIA MotionBricks on ONNX Runtime)
rem
rem   scripts\setup-tools.bat                 both
rem   scripts\setup-tools.bat cleanup         only Clean up
rem   scripts\setup-tools.bat motionbricks    only MotionBricks
rem
rem MotionBricks also needs NVIDIA's MotionBricks checkout with its ONNX assets
rem in .\motionbricks (or set MOTIONBRICKS to where it is); see README.md.
cd /d "%~dp0.."

set "PY=py"
where py >nul 2>nul || set "PY=python"

if /i "%~1"=="motionbricks" goto motionbricks

echo Setting up Clean up in tools\cleanup\.venv...
%PY% -m venv tools\cleanup\.venv || goto failed
tools\cleanup\.venv\Scripts\python.exe -m pip install -q -r tools\cleanup\requirements.txt || goto failed
echo Clean up is ready.
if /i "%~1"=="cleanup" exit /b 0

:motionbricks
set "MBROOT=%MOTIONBRICKS%"
if "%MBROOT%"=="" set "MBROOT=motionbricks"
echo Setting up MotionBricks in %MBROOT%\.venv-ort...
if not exist "%MBROOT%" mkdir "%MBROOT%"
%PY% -m venv "%MBROOT%\.venv-ort" || goto failed
"%MBROOT%\.venv-ort\Scripts\python.exe" -m pip install -q -r tools\motionbricks\requirements.txt || goto failed
if not exist "%MBROOT%\motionbricks\assets\onnx\soma\mmm_v6_soma_fp32.onnx" (
    echo Note: the MotionBricks ONNX model was not found in %MBROOT%\motionbricks\assets\onnx\soma\.
    echo Put NVIDIA's MotionBricks checkout there; see README.md.
)
echo MotionBricks is ready.
exit /b 0

:failed
echo Setup failed.
exit /b 1
