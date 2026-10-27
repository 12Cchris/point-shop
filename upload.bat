@echo off
setlocal
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
if errorlevel 1 goto FAILED
git branch -M main
if errorlevel 1 goto FAILED
git remote add origin "%REPO_URL%"
if errorlevel 1 goto FAILED
echo [INFO] Git repository connected.
echo.

:GIT_READY
:: 3. Confirm repository and remote
git rev-parse --is-inside-work-tree >nul 2>nul
if errorlevel 1 (
    echo [ERROR] This folder is not a valid Git repository.
    goto END
)
git remote get-url origin >nul 2>nul
if errorlevel 1 (
    echo [ERROR] No "origin" remote is configured.
    echo Run this script from the project folder connected to GitHub.
    goto END
)

:: 4. Stage all changes, including new files and deletions
echo [1/3] Adding changed files (git add -A) ...
git add -A
if errorlevel 1 goto FAILED
echo.

git diff --cached --quiet
if errorlevel 2 goto FAILED
if errorlevel 1 goto COMMIT
echo [INFO] No new changes to commit.
goto PUSH_ONLY

:COMMIT
set "DEFAULT_MSG=Update %date% %time%"
set "COMMIT_MSG="
set /p "COMMIT_MSG=Commit message (Press Enter for default): "
if not defined COMMIT_MSG set "COMMIT_MSG=%DEFAULT_MSG%"
echo.
echo [2/3] Creating commit ...
git commit -m "%COMMIT_MSG%"
if errorlevel 1 goto FAILED
echo.

:PUSH_ONLY
echo [3/3] Uploading current branch to GitHub ...
git push -u origin HEAD
if errorlevel 1 (
    echo [ERROR] Push failed. Check the GitHub message above.
    echo If the remote branch has newer commits, pull/rebase in a terminal and run this again.
    goto END
)
echo.
echo ======================================================
echo   SUCCESS! Current branch uploaded to GitHub.
echo   Render will deploy if it watches this branch.
echo ======================================================
goto END

:FAILED
echo.
echo [ERROR] A Git command failed. Read the error above; no success was reported.

:END
echo.
pause
endlocal
