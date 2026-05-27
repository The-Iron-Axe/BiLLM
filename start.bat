@echo off
REM billm one-click launcher (Windows). Double-click to run.
REM Optional environment variables:
REM   BACKEND_PORT=8000   FRONTEND_PORT=5173   NO_BROWSER=1   SKIP_INSTALL=1
setlocal EnableDelayedExpansion
cd /d "%~dp0"

if not defined BACKEND_PORT set BACKEND_PORT=8000
if not defined FRONTEND_PORT set FRONTEND_PORT=5173

call :step "Checking environment"

set "PYTHON="
where python >nul 2>&1 && set "PYTHON=python"
if not defined PYTHON (
  where py >nul 2>&1 && set "PYTHON=py"
)
if not defined PYTHON (
  call :fail "Python not found. Install Python 3.10+ and add it to PATH."
)

where node >nul 2>&1 || call :fail "Node.js not found. Install Node 18+ and add it to PATH."
set "NPM=npm"
where npm >nul 2>&1 || (
  where npm.cmd >nul 2>&1 || call :fail "npm not found."
  set "NPM=npm.cmd"
)

for /f "delims=" %%i in ('where !PYTHON! 2^>nul') do set "PYTHON_PATH=%%i" & goto :python_found
:python_found
call :ok "Python : !PYTHON_PATH!"
for /f "delims=" %%i in ('where node 2^>nul') do set "NODE_PATH=%%i" & goto :node_found
:node_found
call :ok "Node   : !NODE_PATH!"
call :ok "npm    : !NPM!"

call :step "Checking config.json"
if not exist "config.json" (
  if exist "config.example.json" (
    copy /y "config.example.json" "config.json" >nul
    call :warn "config.json missing - copied from config.example.json. Edit it to set api_key (or fill it later in Settings)."
  ) else (
    call :warn "Neither config.json nor config.example.json exists; defaults will be created on first launch."
  )
) else (
  call :ok "config.json present"
)

if not defined SKIP_INSTALL (
  call :step "Installing backend deps (pip)"
  !PYTHON! -m pip install --disable-pip-version-check -q -r requirements.txt
  if errorlevel 1 call :fail "pip install failed"
  call :ok "Backend deps ready"

  if not exist "frontend\node_modules" (
    call :step "Installing frontend deps (npm install) - first time is slow"
    pushd frontend
    call !NPM! install --silent
    if errorlevel 1 (
      popd
      call :fail "npm install failed"
    )
    popd
    call :ok "Frontend deps ready"
  ) else (
    call :ok "frontend/node_modules exists, skipping npm install"
  )
) else (
  call :warn "Skipped dependency install (SKIP_INSTALL=1)"
)

call :step "Starting backend (FastAPI) on http://localhost:!BACKEND_PORT!"
start "billm-backend" /D "%CD%" cmd /k "title billm-backend && !PYTHON! -m uvicorn backend.main:app --host 127.0.0.1 --port !BACKEND_PORT! --reload"

call :step "Starting frontend (Vite) on http://localhost:!FRONTEND_PORT!"
start "billm-frontend" /D "%CD%\frontend" cmd /k "title billm-frontend && !NPM! run dev -- --port !FRONTEND_PORT!"

if not defined NO_BROWSER (
  call :step "Waiting for frontend to be ready"
  set "URL=http://localhost:!FRONTEND_PORT!"
  set "OPENED=0"
  for /l %%i in (1,1,60) do (
    if "!OPENED!"=="0" (
      curl -sSf "!URL!" >nul 2>&1
      if not errorlevel 1 (
        start "" "!URL!"
        set "OPENED=1"
        call :ok "Opened browser at !URL!"
      ) else (
        timeout /t 1 /nobreak >nul
      )
    )
  )
  if "!OPENED!"=="0" call :warn "Frontend not ready within 60s. Open !URL! manually."
)

echo.
echo Backend  window title: billm-backend
echo Frontend window title: billm-frontend
echo Close those windows to stop the services.
echo.
endlocal
exit /b 0

:step
echo ==^> %~1
exit /b 0

:ok
echo     %~1
exit /b 0

:warn
echo     %~1
exit /b 0

:fail
echo [!] %~1
pause
exit /b 1
