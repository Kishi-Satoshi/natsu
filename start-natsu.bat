@echo off
rem 日本語メッセージのため、コンソールをUTF-8にする（このファイルはBOM無しUTF-8）
chcp 65001 >nul
rem =====================================================
rem NaTsu 起動（コンソールウィンドウを残しません）
rem このbatが置かれたフォルダをアプリ本体とみなします。
rem =====================================================
set "APPDIR=%~dp0"
if "%APPDIR:~-1%"=="\" set "APPDIR=%APPDIR:~0,-1%"

rem electron.exe が無いとき（Electron 42 から npm install では本体が来ない）だけ、tools\get-electron.js で取り込む。
rem 括弧の塊を使わず goto で分ける（フォルダの名前に閉じ括弧が入っても壊れないように）。
if exist "%APPDIR%\node_modules\electron\dist\electron.exe" goto run
where node >nul 2>nul
if errorlevel 1 goto nonode
node "%APPDIR%\tools\get-electron.js" "%APPDIR%"
if errorlevel 1 goto failed
:run
start "" "%APPDIR%\node_modules\electron\dist\electron.exe" "%APPDIR%"
exit /b 0
:nonode
echo Node.js 22.12 以上を入れてください。https://nodejs.org/ja から LTS 版を入れられます。
pause
exit /b 1
:failed
pause
exit /b 1
