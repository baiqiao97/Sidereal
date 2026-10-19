@echo off
cd /d "%~dp0"
"D:\node\node.exe" server.cjs "%CD%"
pause
