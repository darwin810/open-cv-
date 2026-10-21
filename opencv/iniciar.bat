@echo off
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Primero sigue los pasos de instalacion en README.md.
  pause
  exit /b 1
)
echo Abre http://127.0.0.1:8000 en tu navegador.
".venv\Scripts\python.exe" app.py
pause
