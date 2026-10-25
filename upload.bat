@echo off
title Point Shop - GitHub Upload

cd /d "%~dp0"

echo ======================================================
echo   Point Shop - GitHub Auto Upload
echo ======================================================
echo.

:: 1. Check Git
where git >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Git is not installed or not in PATH.
    echo Please install Git from https://git-scm.com
    goto END
)

:: 2. Check Git Repository
if exist ".git" goto GIT_READY

echo [INFO] Git repository is not initialized.
echo.
set /p REPO_URL="Enter GitHub Repository URL: "
if "%REPO_URL%"=="" (
    echo [CANCELLED] URL was not provided.
    goto END
)
git init
git branch -M main
git remote add origin %REPO_URL%
echo [INFO] Git repository connected.
echo.

:GIT_READY
echo [1/3] Adding changed files (git add) ...
git add .
echo.

set DEFAULT_MSG=Update %date% %time%
set /p COMMIT_MSG="Commit message (Press Enter for default): "
if "%COMMIT_MSG%"=="" set COMMIT_MSG=%DEFAULT_MSG%

echo.
echo [2/3] Creating commit (git commit) ...
git commit -m "%COMMIT_MSG%"

echo.
echo [3/3] Uploading to GitHub (git push) ...
git push origin main
if errorlevel 1 (
    git push -u origin HEAD
)

if errorlevel 1 (
    echo.
    echo ======================================================
    echo   [ERROR] Upload failed.
    echo   Please check your GitHub login or repo URL.
    echo ======================================================
) else (
    echo.
    echo ======================================================
    echo   SUCCESS! Uploaded to GitHub.
    echo   Render will automatically deploy the new version.
    echo ======================================================
)

:END
echo.
pause
