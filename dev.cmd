@echo off
setlocal
rem Run from Cmder/CMD without requiring npm or Node to be on PATH.
pushd "%~dp0" || exit /b 1
set "NODE_EXE="
if exist "%~dp0.local-runtime\node-v22.22.0-win-x64\node.exe" set "NODE_EXE=%~dp0.local-runtime\node-v22.22.0-win-x64\node.exe"
if not defined NODE_EXE for /f "delims=" %%N in ('where node.exe 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%N"
if not defined NODE_EXE goto missing_node
for %%N in ("%NODE_EXE%") do set "NODE_DIR=%%~dpN"
set "NPM_CLI=%NODE_DIR%node_modules\npm\bin\npm-cli.js"
"%NODE_EXE%" -e "const [major,minor]=process.versions.node.split('.').map(Number); if(major!==22 || minor<14){console.error('SPFx requires Node 22.14 or newer within Node 22. Found '+process.version);process.exit(1)}"
if errorlevel 1 goto failed
if not exist "%NPM_CLI%" goto missing_npm
set "PATH=%NODE_DIR%;%~dp0node_modules\.bin;%PATH%"
set "ACTION=%~1"
if not defined ACTION set "ACTION=start"
if /i "%ACTION%"=="doctor" goto doctor
if /i "%ACTION%"=="install" goto install
if not exist "%~dp0node_modules\@rushstack\heft\bin\heft" goto missing_dependencies
if /i "%ACTION%"=="start" goto start
if /i "%ACTION%"=="trust-cert" goto trust_cert
if /i "%ACTION%"=="test" goto test
if /i "%ACTION%"=="build" goto build
if /i "%ACTION%"=="clean" goto clean
echo Usage: dev.cmd [doctor^|install^|trust-cert^|start^|test^|build^|clean]
echo Use dev.cmd start --nobrowser to keep the browser closed.
goto failed

:doctor
echo Node executable: %NODE_EXE%
"%NODE_EXE%" --version
echo npm CLI: %NPM_CLI%
"%NODE_EXE%" "%NPM_CLI%" --version
if errorlevel 1 goto failed
if not exist "%~dp0node_modules\@rushstack\heft\bin\heft" goto missing_dependencies
echo SPFx dependencies are installed.
goto success

:install
"%NODE_EXE%" "%NPM_CLI%" ci
goto result

:start
if "%~2"=="" goto start_browser
if /i not "%~2"=="--nobrowser" goto bad_start_option
"%NODE_EXE%" "%~dp0node_modules\@rushstack\heft\bin\heft" start --clean --nobrowser
goto result
:start_browser
"%NODE_EXE%" "%~dp0node_modules\@rushstack\heft\bin\heft" start --clean
goto result
:bad_start_option
echo Supported start option: --nobrowser
goto failed

:trust_cert
"%NODE_EXE%" "%~dp0node_modules\@rushstack\heft\bin\heft" trust-dev-cert
goto result
:test
"%NODE_EXE%" "%NPM_CLI%" test
goto result
:build
"%NODE_EXE%" "%NPM_CLI%" run build
goto result
:clean
"%NODE_EXE%" "%NPM_CLI%" run clean
goto result

:missing_node
echo Node.js was not found. Install Node 22.14 or newer within Node 22, including npm, then reopen Cmder.
goto failed
:missing_npm
echo npm is missing from the selected Node installation: %NODE_DIR%
echo Install the complete Node 22 distribution including npm, then reopen Cmder.
goto failed
:missing_dependencies
echo Project dependencies are missing. Run: dev.cmd install
goto failed
:result
set "RESULT=%ERRORLEVEL%"
popd
exit /b %RESULT%
:success
popd
exit /b 0
:failed
popd
exit /b 1
