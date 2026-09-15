@echo off
echo %date% %time% >> "%~dp0chrome-launch.log"
C:\WINDOWS\py.exe "%~dp0bridge.py"