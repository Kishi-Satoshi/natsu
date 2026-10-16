# =====================================================================
# get-installer.ps1 — NaTsu のインストーラーを確実に取得する
#
# 社内回線は大容量ダウンロードを途中で切ることがある（115〜122MB付近で
# 切断する実績あり）。ブラウザで落とすと止まったまま進まないため、
# curl.exe の -C - で「続きから」を繰り返す。setup-*.ps1 の Get-BigFile と同じ方式。
#
# 落とし終わったらサイズと SHA256 を突き合わせて、壊れていないか確かめる。
#
# 実行方法（PowerShell）:
#   powershell -ExecutionPolicy Bypass -File .\get-installer.ps1
#   powershell -ExecutionPolicy Bypass -File .\get-installer.ps1 -Version 0.1.0
#
# エクスプローラーから起動したとき（右クリックの「PowerShell で実行」やダブルクリック）は、
# 窓がすぐ閉じないよう、最後とエラーで止まったときに Enter を待ちます。待たせないときは -NoPause。
#
# Windows PowerShell 5.1 / PowerShell 7 の両方で動作します。
# =====================================================================
param(
    [string]$Version = "",
    [string]$OutDir = ".",
    [switch]$NoPause
)

$ErrorActionPreference = "Stop"
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

# ---------------------------------------------------------------------
# エクスプローラーから起動したときは、閉じる前に Enter を待つ
#   右クリックの「PowerShell で実行」やダブルクリックで起動すると、終わった瞬間に窓が閉じて、
#   エラーも表示した内容も読めない。そのときだけ、最後とエラーで止まったときに Enter を待つ。
#   開いてある PowerShell の窓から実行したときは、今までどおり待たない。-NoPause でも待たない。
#   調べられなかったときは「待たない」にする（自動で実行したときに止まったままにならないように）。
# ---------------------------------------------------------------------
function Test-LaunchedFromExplorer {
    param([string]$ScriptPath)
    try {
        if (-not $ScriptPath) { return $false }
        $name = Split-Path -Leaf $ScriptPath
        $cmd = [Environment]::CommandLine
        if (-not $cmd) { return $false }
        # このスクリプトのために開いた窓か。開いてある窓で .\ から実行したときは、起動の行に名前が無い
        # （スタートメニューやアドレス欄から開いた窓も親は explorer.exe なので、親だけでは決めない）
        if ($cmd.IndexOf($name, [StringComparison]::OrdinalIgnoreCase) -lt 0) { return $false }
        # -NoExit なら窓は閉じない。-NonInteractive なら Enter を待てない
        if ($cmd -match '\s-(noe|noni)') { return $false }
        # 右クリックの「PowerShell で実行」は、次の形で起動する
        #   powershell.exe "-Command" "if(...) { Set-ExecutionPolicy -Scope Process Bypass }; & '<このファイル>'"
        if (($cmd -match '-Command') -and ($cmd -match 'Set-ExecutionPolicy -Scope Process Bypass') -and ($cmd -match "&\s*'")) { return $true }
        # ダブルクリックなど: 親のプロセスが explorer.exe
        $me = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId=" + $PID)
        if (-not $me) { return $false }
        $parent = Get-Process -Id $me.ParentProcessId -ErrorAction SilentlyContinue
        if ($parent -and ($parent.ProcessName -eq "explorer")) { return $true }
    }
    catch { }
    return $false
}

# エクスプローラーから起動していれば、ひとこと出して Enter を待つ
function Wait-BeforeClose {
    param([string]$Message)
    if (-not $script:PauseOnExit) { return }
    Write-Host ""
    if ($Message) { Write-Host $Message -ForegroundColor Cyan }
    try { [void](Read-Host "Enter キーを押すと閉じます") } catch { }
}

# 案内を出して止まるところは、ここを通して終わる（読めるように待ってから閉じる）
function Exit-Script {
    param([int]$Code = 1)
    Wait-BeforeClose "取得を完了できませんでした。上の案内を読んでから閉じてください。"
    exit $Code
}

$script:PauseOnExit = $false
if (-not $NoPause) { $script:PauseOnExit = Test-LaunchedFromExplorer $PSCommandPath }

# 思わぬエラー（ダウンロードや展開の失敗など）で止まったとき。
# エクスプローラーから起動していれば、赤字でエラーと次の手を出し、Enter を待ってから閉じる。
# 開いてある窓から実行したときは、今までどおり PowerShell のエラー表示に任せる（break）。
trap {
    if (-not $script:PauseOnExit) { break }
    Write-Host ""
    Write-Host ("エラーで止まりました: " + $_.Exception.Message) -ForegroundColor Red
    Write-Host "PowerShell を開いて powershell -ExecutionPolicy Bypass -File .\get-installer.ps1 で実行し直すと、詳しい内容が見えます。" -ForegroundColor Red
    Write-Host ("  このフォルダです: " + $PSScriptRoot + "（アドレス欄に powershell と入力すると、ここで開けます）")
    Wait-BeforeClose "上の赤い文字を控えてから閉じてください。"
    exit 1
}

$repo = "Kishi-Satoshi/natsu"
if ($Version -eq "") {
    $api = "https://api.github.com/repos/$repo/releases/latest"
}
else {
    $api = "https://api.github.com/repos/$repo/releases/tags/natsu-v$Version"
}

# --- リリース情報の取得 ---
# Invoke-RestMethod は Windows のプロキシ設定を使う。それが通らない環境も
# あるので、駄目なら curl.exe に切り替える。
Write-Host "リリース情報を取得中..." -ForegroundColor Cyan
$rel = $null
try {
    $rel = Invoke-RestMethod -Uri $api -UseBasicParsing
}
catch {
    try {
        $json = & curl.exe -L -sS $api
        $rel = $json | ConvertFrom-Json
    }
    catch {
        Write-Host "リリース情報を取得できませんでした。ネットワーク設定を確認してください。" -ForegroundColor Red
        Write-Host "  $api"
        Exit-Script 1
    }
}

$asset = $rel.assets | Where-Object { $_.name -like "*-setup.exe" } | Select-Object -First 1
if (-not $asset) {
    Write-Host "インストーラーがリリースに添付されていません（$($rel.tag_name)）。" -ForegroundColor Red
    Exit-Script 1
}

$expected = [long]$asset.size
$out = Join-Path $OutDir $asset.name
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

Write-Host ("  " + $rel.tag_name + " / " + $asset.name + " / " + [math]::Round($expected / 1MB) + " MB")

# --- 既にあるファイルの扱い ---
if (Test-Path $out) {
    $len = (Get-Item $out).Length
    if ($len -gt $expected) {
        Write-Host "既存ファイルが期待より大きいため、取り直します。" -ForegroundColor Yellow
        Remove-Item $out -Force
    }
    elseif ($len -lt $expected) {
        Write-Host ("途中まで取得済み（" + [math]::Round($len / 1MB) + " MB）。続きから再開します。") -ForegroundColor Yellow
    }
}

# --- 続きから繰り返し取得 ---
$maxTry = 40
for ($i = 1; $i -le $maxTry; $i++) {
    if ((Test-Path $out) -and ((Get-Item $out).Length -eq $expected)) { break }

    # -C - : 部分ファイルの続きから再開 / -L : リダイレクト追従
    & curl.exe -L -sS --retry 3 --retry-delay 2 -C - -o $out $asset.browser_download_url

    $len = 0
    if (Test-Path $out) { $len = (Get-Item $out).Length }
    if ($len -eq $expected) { break }

    $pct = 0
    if ($expected -gt 0) { $pct = [math]::Round(100 * $len / $expected) }
    Write-Host ("  切断を検出（" + [math]::Round($len / 1MB) + " / " + [math]::Round($expected / 1MB) + " MB・" + $pct + "%）。続きから再開します… 試行 " + $i + "/" + $maxTry) -ForegroundColor Yellow
    Start-Sleep -Seconds 3
}

# --- 検証 ---
if (-not (Test-Path $out)) {
    Write-Host "ダウンロードできませんでした。" -ForegroundColor Red
    Exit-Script 1
}
$len = (Get-Item $out).Length
if ($len -ne $expected) {
    Write-Host ("再開を繰り返しても完了できませんでした（" + $len + " / " + $expected + " バイト）。") -ForegroundColor Red
    Write-Host "もう一度このスクリプトを実行すると、続きから再開します。"
    Exit-Script 1
}

# GitHub が公開しているハッシュと突き合わせる（あれば）
$digest = ""
try { $digest = [string]$asset.digest } catch { }
if ($digest -like "sha256:*") {
    $want = $digest.Substring(7).ToLower()
    $got = (Get-FileHash -Path $out -Algorithm SHA256).Hash.ToLower()
    if ($want -ne $got) {
        Write-Host "SHA256 が一致しません。ファイルが壊れています。" -ForegroundColor Red
        Write-Host ("  期待: " + $want)
        Write-Host ("  実際: " + $got)
        Write-Host "このファイルを削除して、もう一度実行してください。"
        Exit-Script 1
    }
    Write-Host "SHA256 検証 OK" -ForegroundColor Green
}

# --- セットアップスクリプトも一緒に取得する ---
# エンジン（whisper.cpp / llama.cpp）を入れるのに使う。インストーラーだけでは
# 文字起こしも要約も動かないので、同じフォルダに揃えておく。
$setups = @()
foreach ($a in $rel.assets) {
    if ($a.name -like "setup-*.ps1") {
        $sp = Join-Path $OutDir $a.name
        $ok = $false
        try {
            & curl.exe -L -sS --retry 3 --retry-delay 2 -o $sp $a.browser_download_url
            if ((Test-Path $sp) -and ((Get-Item $sp).Length -gt 0)) { $ok = $true }
        }
        catch { }
        if (-not $ok) {
            try {
                Invoke-WebRequest -Uri $a.browser_download_url -OutFile $sp -UseBasicParsing
                if ((Test-Path $sp) -and ((Get-Item $sp).Length -gt 0)) { $ok = $true }
            }
            catch { }
        }
        if ($ok) { $setups += $a.name }
        else { Write-Host ("  " + $a.name + " を取得できませんでした。リリースページから手で落としてください。") -ForegroundColor Yellow }
    }
}

Write-Host ""
Write-Host "========================= 取得完了 =========================" -ForegroundColor Green
Write-Host ("  " + (Resolve-Path $out))
Write-Host ""
Write-Host "このファイルを実行するとインストールされます（管理者権限は不要です）。"
Write-Host "インストール後の更新は数百KBの差分だけを取得するので、"
Write-Host "この大きなファイルを落とすのは初回だけです。"

if ($setups.Count -gt 0) {
    Write-Host ""
    Write-Host "続けて、エンジンをこの順に入れてください（同じフォルダに置いてあります）:" -ForegroundColor Cyan
    if ($setups -contains "setup-local-engine.ps1") {
        Write-Host "  1. powershell -ExecutionPolicy Bypass -File .\setup-local-engine.ps1"
        Write-Host "     文字起こし用。約 0.6GB"
    }
    if ($setups -contains "setup-summarizer.ps1") {
        Write-Host "  2. powershell -ExecutionPolicy Bypass -File .\setup-summarizer.ps1"
        Write-Host "     議事録の要約用。約 2GB"
    }
    Write-Host "  3. 表示されたパスを NaTsu の [設定] に貼り付ける"
}

Wait-BeforeClose "取得が終わりました。上の案内を控えてから閉じてください。"
