@echo off
title Desktop Pet
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies, first time only...
  call npm install
)
echo Starting Desktop Pet. The first start can take a few minutes while it builds.
echo Keep this window open while the pet runs. Close it to stop the pet.
call npm run dev
pause
