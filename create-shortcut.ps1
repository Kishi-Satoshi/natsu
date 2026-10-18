# =====================================================================
# NaTsu ショートカット作成スクリプト
# デスクトップとスタートメニューに NaTsu.lnk を作成します。
# スタートメニューに入るため、Windowsキー →「NaTsu」で検索・起動できる
# 標準的なアプリと同じ起動導線になります（コンソールは一切出ません）。
#
# 実行方法（アプリのフォルダ内で実行してください）:
#   powershell -ExecutionPolicy Bypass -File .\create-shortcut.ps1
# =====================================================================
$ErrorActionPreference = "Stop"

$app      = $PSScriptRoot
$electron = Join-Path $app "node_modules\electron\dist\electron.exe"
$icon     = Join-Path $app "assets\icon.ico"

# electron.exe が無いとき（Electron 42 から npm install では本体が来ない）だけ、tools\get-electron.js で取り込む
if (-not (Test-Path $electron)) {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($null -eq $node) {
        Write-Host "Node.js 22.12 以上を入れてください。https://nodejs.org/ja から LTS 版を入れられます。" -ForegroundColor Red
        exit 1
    }
    & $node.Source (Join-Path $app "tools\get-electron.js") $app
    if ($LASTEXITCODE -ne 0) { exit 1 }
}

$desktop   = [Environment]::GetFolderPath("Desktop")
$startMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"

$shell = New-Object -ComObject WScript.Shell
foreach ($dir in @($desktop, $startMenu)) {
    $lnkPath = Join-Path $dir "NaTsu.lnk"
    $lnk = $shell.CreateShortcut($lnkPath)
    $lnk.TargetPath       = $electron
    $lnk.Arguments        = '"' + $app + '"'
    $lnk.WorkingDirectory = $app
    if (Test-Path $icon) { $lnk.IconLocation = $icon }
    $lnk.Description      = "NaTsu - 声で、書く。（完全オフライン音声入力・議事録）"
    $lnk.Save()
    Write-Host ("作成: " + $lnkPath) -ForegroundColor Green
}

Write-Host ""
Write-Host "完了しました。デスクトップのアイコン、または Windowsキー →「NaTsu」で起動できます。" -ForegroundColor Cyan
