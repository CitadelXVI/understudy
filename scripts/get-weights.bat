@echo off
setlocal
rem Download the model weights Understudy runs on, into this repository's root:
rem the Kimodo SOMA RP v1.1 motion model (models\) and the Llama-3 text encoder
rem (Q8_0), both as published GGUF files on Hugging Face.
rem
rem   scripts\get-weights.bat                         SOMA RP v1.1 + Q8_0 text encoder
rem   scripts\get-weights.bat --model soma-seed-v1.1  extra flags go to the downloader
rem
rem Needs Python 3 with huggingface_hub (pip install huggingface_hub).  The
rem weights come under their own licenses: the Kimodo models under the NVIDIA
rem Open Model License and the text encoder under the Meta Llama 3 Community
rem License.  Read them before you ship anything made with them.
rem
rem SOMA RP v1.2, the model Understudy prefers when present, is not published
rem as GGUF; scripts\convert_soma_v12.py converts it from NVIDIA's checkpoint.
cd /d "%~dp0.."

set "PY=py"
where py >nul 2>nul || set "PY=python"

if "%~1"=="" (
    %PY% kimodo.cpp\scripts\download_gguf_weights.py --output . --model soma-rp-v1.1
) else (
    %PY% kimodo.cpp\scripts\download_gguf_weights.py --output . %*
)
if errorlevel 1 (
    echo Download failed.  Install the downloader's dependency with: %PY% -m pip install huggingface_hub
    exit /b 1
)
echo Weights are in %CD%.  Start Understudy with scripts\start.bat
