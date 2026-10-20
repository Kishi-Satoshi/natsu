# =====================================================================
# NaTsu 要約エンジン セットアップスクリプト（議事録の自動要約用・任意）
#
# llama.cpp のWindows版バイナリ（llama-server）と、日本語対応の
# ローカルLLMモデル（GGUF形式）をダウンロードします。
# ※ このスクリプトの実行時のみインターネット接続が必要です。
#    ダウンロード完了後は完全オフラインで動作します。
#
# 実行方法（PowerShell）:
#   powershell -ExecutionPolicy Bypass -File .\setup-summarizer.ps1
#   powershell -ExecutionPolicy Bypass -File .\setup-summarizer.ps1 -Model 7b
#
# エクスプローラーから起動したとき（右クリックの「PowerShell で実行」やダブルクリック）は、
# 窓がすぐ閉じないよう、最後とエラーで止まったときに Enter を待ちます。待たせないときは -NoPause。
#
# ふつうは NaTsu の［設定］→［オフライン］の［PC の中の文字起こしを取り込む］で入れる。このスクリプトは詳しい人向け。
#
# -Model の選択肢:
#   e4b (既定) … Gemma 4 E4B-it Q4_K_M  約5.0GB。Apache-2.0。アプリの取り込みと同じファイル（同じ commit で固定）
#   3b         … Qwen2.5-3B-Instruct    約1.9GB。研究・評価のためだけのライセンス（Qwen RESEARCH LICENSE）。
#                                       業務の議事録には使わない
#   7b         … Qwen2.5-7B-Instruct    約4.7GB。Apache-2.0。高品質だが要約に時間がかかる
#
# llama.cpp は今までどおり最新のリリースを落とす（GitHub の API で引く）。Gemma 4 は b8637 より前の版では
# 読めないが、最新なら読める。
# Gemma 4 は考える手順（thinking）が既定で入ることがある（遅くなる）。気になるときはアプリの取り込みを使う
# （アプリで取り込んだ llama には、それを止める旗を渡す。このスクリプトで入れたものには渡らない）。
#
# Windows PowerShell 5.1 / PowerShell 7 の両方で動作します。
# =====================================================================
param(
    [string]$Model = "e4b",
    [string]$Tag = "",
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
    Wait-BeforeClose "セットアップを完了できませんでした。上の案内を読んでから閉じてください。"
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
    # コマンドとフォルダは、それぞれ札を付けて行の最後に置く（文の途中に置くと、後ろの語までひと続きに写される）
    Write-Host "PowerShell を開いて、次のコマンドで実行し直すと、詳しい内容が見えます。" -ForegroundColor Red
    Write-Host "  実行するコマンド: powershell -ExecutionPolicy Bypass -File .\setup-summarizer.ps1" -ForegroundColor Red
    Write-Host "  （下のフォルダをエクスプローラーで開き、アドレス欄に powershell と入力すると、そこで PowerShell が開きます）"
    Write-Host ("  このフォルダ: " + $PSScriptRoot)
    Wait-BeforeClose "上の赤い文字を控えてから閉じてください。"
    exit 1
}

# --- 大容量ファイル用: 切断されても続きから再開するダウンロード ---
function Get-BigFile {
    param([string]$Url, [string]$Out, [long]$MinBytes)
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    $maxTry = 12
    for ($i = 1; $i -le $maxTry; $i++) {
        if ($curl) {
            # -C - : 部分ファイルの続きから再開 / -L : リダイレクト追従（Windowsの証明書ストアを使用）
            & curl.exe -L -sS --retry 3 --retry-delay 2 -C - -o $Out $Url
        }
        else {
            Invoke-WebRequest -Uri $Url -OutFile $Out
        }
        if ((Test-Path $Out) -and ((Get-Item $Out).Length -ge $MinBytes)) { return $true }
        $lenMB = 0
        if (Test-Path $Out) { $lenMB = [math]::Round((Get-Item $Out).Length / 1MB) }
        Write-Host ("  切断を検出（現在 " + $lenMB + " MB）。続きから再開します… 試行 " + $i + "/" + $maxTry) -ForegroundColor Yellow
        Start-Sleep -Seconds 2
    }
    return $false
}

# --- モデルURLの解決（if/elseif で 5.1 互換に） ---
$modelUrl = ""
$modelFile = ""
$minMB = 0
if ($Model -eq "e4b") {
    # アプリの取り込み（src/engine-manifest.js の sum-model）と同じファイル・同じ commit
    $modelFile = "gemma-4-E4B-it-Q4_K_M.gguf"
    $modelUrl  = "https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/resolve/bfc15c382204943c3a8fff0c750b94ae2364d7a3/gemma-4-E4B-it-Q4_K_M.gguf"
    $minMB     = 4500
}
elseif ($Model -eq "3b") {
    $modelFile = "Qwen2.5-3B-Instruct-Q4_K_M.gguf"
    $modelUrl  = "https://huggingface.co/bartowski/Qwen2.5-3B-Instruct-GGUF/resolve/main/Qwen2.5-3B-Instruct-Q4_K_M.gguf"
    $minMB     = 1700
}
elseif ($Model -eq "7b") {
    $modelFile = "Qwen2.5-7B-Instruct-Q4_K_M.gguf"
    $modelUrl  = "https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf"
    $minMB     = 4300
}
else {
    Write-Host "不明なモデル名です: $Model （指定できる値: e4b / 3b / 7b）" -ForegroundColor Red
    Exit-Script 1
}

$root = Join-Path $PSScriptRoot "local-engine"
$llmRoot = Join-Path $root "llm"
New-Item -ItemType Directory -Force -Path $llmRoot | Out-Null

# ---------------------------------------------------------------------
# 1) llama.cpp Windowsバイナリ（llama-server.exe を含む）
#    最新リリースのタグをGitHub APIで取得し、CPU版zipをダウンロード
# ---------------------------------------------------------------------
Write-Host "[1/2] llama.cpp バイナリをダウンロード中..." -ForegroundColor Cyan
# リリース情報を取る。Invoke-RestMethod が通らない環境があるので curl.exe に落とす
function Get-Json {
    param([string]$Url)
    $r = $null
    try { $r = Invoke-RestMethod -Uri $Url }
    catch {
        try { $r = (& curl.exe -L -sS $Url) | ConvertFrom-Json } catch { }
    }
    return $r
}

# Windows の CPU版 zip を選ぶ。
# llama.cpp は配布の命名を変えることがある（b#### 方式 -> v0.x.y 方式など）ので、
# 既知の名前を順に試し、駄目なら「Windows の x64 zip で GPU 向けでないもの」で拾う。
function Find-WinCpuAsset {
    param($Assets)
    if (-not $Assets) { return $null }
    $patterns = @(
        "*bin-win-cpu-x64.zip",
        "*bin-win-avx2-x64.zip",
        "*win-cpu-x64.zip",
        "*win-x64.zip"
    )
    foreach ($p in $patterns) {
        $hit = $Assets | Where-Object { $_.name -like $p } | Select-Object -First 1
        if ($hit) { return $hit }
    }
    $hit = $Assets | Where-Object {
        $_.name -like "*.zip" -and $_.name -like "*win*" -and $_.name -like "*x64*" -and
        $_.name -notlike "*cuda*" -and $_.name -notlike "*cudart*" -and
        $_.name -notlike "*hip*" -and $_.name -notlike "*vulkan*" -and
        $_.name -notlike "*sycl*" -and $_.name -notlike "*arm*" -and
        $_.name -notlike "*opencl*"
    } | Select-Object -First 1
    return $hit
}

$base = "https://api.github.com/repos/ggml-org/llama.cpp/releases"
$candidates = @()
if ($Tag -ne "") {
    $one = Get-Json ($base + "/tags/" + $Tag)
    if ($one) { $candidates += $one }
}
else {
    $one = Get-Json ($base + "/latest")
    if ($one) { $candidates += $one }
    # 最新リリースに Windows バイナリが無いことがある（配布方針の変更など）ので、
    # 直近のリリースも順に見る
    $list = Get-Json ($base + "?per_page=20")
    if ($list) { $candidates += $list }
}
if ($candidates.Count -eq 0) {
    Write-Host "llama.cpp のリリース情報を取得できませんでした。" -ForegroundColor Red
    Write-Host "  $base"
    Exit-Script 1
}

$rel = $null
$asset = $null
foreach ($r in $candidates) {
    $a = Find-WinCpuAsset $r.assets
    if ($a) { $rel = $r; $asset = $a; break }
}

if (-not $asset) {
    Write-Host "Windows CPU版のバイナリが見つかりませんでした。" -ForegroundColor Red
    Write-Host "配布の命名が変わった可能性があります。実際に公開されている名前は次のとおりです:"
    $shown = 0
    foreach ($r in $candidates) {
        if ($shown -ge 3) { break }
        Write-Host ("  [" + $r.tag_name + "]") -ForegroundColor Yellow
        if ($r.assets) {
            foreach ($a in $r.assets) { Write-Host ("    " + $a.name) }
        }
        else { Write-Host "    (添付なし)" }
        $shown = $shown + 1
    }
    Write-Host ""
    Write-Host "この一覧を伝えていただければ対応できます。"
    Write-Host "特定のリリースを使う場合: -Tag v0.3.0 のように指定してください。"
    Exit-Script 1
}

$tag = $rel.tag_name
Write-Host ("  " + $tag + " / " + $asset.name) -ForegroundColor DarkGray

$binZip = Join-Path $llmRoot $asset.name
# ここも再開ありで取る。数十MBあり、社内回線では途中で切れることがある
# （切れたまま展開すると壊れたzipになる）
$binOk = Get-BigFile -Url $asset.browser_download_url -Out $binZip -MinBytes ([long]$asset.size)
if (-not $binOk) {
    Write-Host "llama.cpp バイナリを取得できませんでした。" -ForegroundColor Red
    Write-Host "ブラウザで次のURLを開いて $llmRoot に置き、もう一度実行してください:"
    Write-Host ("  " + $asset.browser_download_url)
    Exit-Script 1
}

$binDir = Join-Path $llmRoot "bin"
if (Test-Path $binDir) { Remove-Item -Recurse -Force $binDir }
Expand-Archive -Path $binZip -DestinationPath $binDir -Force

$server = Get-ChildItem -Path $binDir -Recurse -Include "llama-server.exe" | Select-Object -First 1
if (-not $server) {
    Write-Host "llama-server.exe が見つかりませんでした。" -ForegroundColor Red
    Exit-Script 1
}
# 展開が途中で終わった・ウイルス対策ソフトに削られた等を捕まえる。ただし **exe の大きさでは
# 判断しない**。llama.cpp は llama-server.exe を 9KB の薄いランチャにし、中身を
# llama-server-impl.dll（約 9MB）へ移した。exe に床を置くと正常な配布物を止めてしまう。
# 見るのは展開物ぜんたいの合計。
$sum = (Get-ChildItem -Path $binDir -Recurse -File | Measure-Object -Property Length -Sum).Sum
if ($null -eq $sum -or $sum -lt 5MB) {
    $mb = [math]::Round(([long]$sum) / 1MB, 1)
    Write-Host ("展開が不完全です（合計 " + $mb + " MB）。") -ForegroundColor Red
    Write-Host "展開が途中で終わったか、ウイルス対策ソフトに削られた可能性があります。"
    Write-Host "もう一度実行してください。直らない場合は、ウイルス対策ソフトの除外設定に次のフォルダを追加してください:"
    Write-Host ("  " + $binDir)
    Exit-Script 1
}
# ここまで来て初めて zip を捨てる（失敗したら残しておき、再実行で取り直しから始めない）
Remove-Item $binZip

# ---------------------------------------------------------------------
# 2) 要約用LLMモデル（GGUF形式）
# ---------------------------------------------------------------------
$modelPath = Join-Path $llmRoot $modelFile
$minBytes  = $minMB * 1MB

if (Test-Path $modelPath) {
    $len = (Get-Item $modelPath).Length
    if ($len -lt $minBytes) {
        $lenMB = [math]::Round($len / 1MB)
        Write-Host "[2/2] 既存のモデルが不完全です（$lenMB MB / 期待 $minMB MB以上）。続きから再開します。" -ForegroundColor Yellow
    }
    else {
        Write-Host "[2/2] モデルは既に存在します: $modelFile" -ForegroundColor Yellow
    }
}

if (-not (Test-Path $modelPath) -or ((Get-Item $modelPath).Length -lt $minBytes)) {
    Write-Host "[2/2] モデルをダウンロード中: $modelFile （数GB・切断されても自動で再開します）..." -ForegroundColor Cyan
    $ok = Get-BigFile -Url $modelUrl -Out $modelPath -MinBytes $minBytes
    if (-not $ok) {
        Write-Host "再開を繰り返しても完了できませんでした。" -ForegroundColor Red
        Write-Host "ブラウザで次のURLを開いてダウンロードし、local-engine\llm フォルダに置いてください:"
        Write-Host "  $modelUrl"
        Exit-Script 1
    }
    $lenMB = [math]::Round((Get-Item $modelPath).Length / 1MB)
    Write-Host "ダウンロード完了（$lenMB MB・サイズ検証OK）" -ForegroundColor Green
}

# ---------------------------------------------------------------------
# 完了
# ---------------------------------------------------------------------
Write-Host ""
Write-Host "========================= セットアップ完了 =========================" -ForegroundColor Green
Write-Host "NaTsu の [設定] -> [エンジン] -> [詳細設定] の「要約」に以下を貼り付けてください。"
Write-Host ""
Write-Host ("  llama-server.exe : " + $server.FullName) -ForegroundColor White
Write-Host ("  モデルファイル   : " + $modelPath) -ForegroundColor White
Write-Host ""
Write-Host "詳細設定の「要約」にある「起動テスト」で OK が出れば、議事録の自動要約が完全オフラインで使えます。"

Wait-BeforeClose "セットアップが終わりました。上のパスを NaTsu の設定に貼り付けてから閉じてください。"
