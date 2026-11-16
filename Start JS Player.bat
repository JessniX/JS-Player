@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies, one moment...
  call npm install
)
start "" npx electron . %*
