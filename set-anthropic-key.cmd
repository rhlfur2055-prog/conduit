@echo off
rem Anthropic API 키를 .env 에 넣는다 (입력한 키는 화면에 보이지 않는다)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0set-anthropic-key.ps1"
pause
