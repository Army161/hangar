@echo off
rem Hangar — start the local agent and open the dashboard.
cd /d "%~dp0"
echo.
echo   Starting Hangar agent...
start "" http://localhost:7420
node server.js
