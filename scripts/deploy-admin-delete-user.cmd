@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy-admin-delete-user.ps1" %*
exit /b %ERRORLEVEL%
