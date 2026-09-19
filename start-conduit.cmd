@echo off
cd /d %~dp0
start "Conduit" /min node server/index.js
