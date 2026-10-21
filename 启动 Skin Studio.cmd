@echo off
setlocal
pushd "%~dp0"
if errorlevel 1 goto directory_failed
set "STUDIO_NODE=node.exe"
where node.exe >nul 2>&1
if not errorlevel 1 goto node_found
set "STUDIO_NODE=%ProgramFiles%\nodejs\node.exe"
if exist "%STUDIO_NODE%" goto node_found
set "STUDIO_NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if exist "%STUDIO_NODE%" goto node_found
echo [ERROR] Node.js was not found. Install Node.js 18 or newer from https://nodejs.org/
goto failed
:node_found
"%STUDIO_NODE%" -e "if(Number(process.versions.node.split('.')[0])<18){console.error('[ERROR] Node.js 18 or newer is required. Found '+process.version);process.exit(1)}console.log('Node.js '+process.version)"
if errorlevel 1 goto failed
if not exist "server.cjs" goto files_missing
if not exist "agent-store.cjs" goto files_missing
if not exist "browser-launch.cjs" goto files_missing
if not exist "index.html" goto files_missing
if /i "%~1"=="--check" goto checked
echo Starting Skin Studio. Keep this window open while editing.
"%STUDIO_NODE%" "%~dp0server.cjs" --open %*
if errorlevel 1 goto failed
popd
exit /b 0
:checked
echo Skin Studio startup checks passed.
popd
exit /b 0
:files_missing
echo [ERROR] Studio files are missing. Extract the complete project folder first.
:failed
echo Startup failed. Read the error above.
if not defined SKIN_STUDIO_NO_PAUSE pause
popd
exit /b 1
:directory_failed
echo [ERROR] Cannot open the Skin Studio directory.
if not defined SKIN_STUDIO_NO_PAUSE pause
exit /b 1
