# =====================================================================
# bench-summarizer.ps1 — 要約のモデルを3つ、この PC で比べる（第0b回 Task 0）
#
# やること（モデルごとに、1つずつ）:
#   1. llama.cpp（b11669）とモデルを落とし、大きさと SHA-256 を照らす（続きから取り直せる）
#   2. llama-bench で速さを測る（数十分かかる。放っておいてよい）
#   3. NaTsu で実際の議事録3本を要約してもらい、時間とメモリを記録する（画面の案内どおりに Enter を押す）
#   4. そのモデルを消してから、次のモデルへ進む（空きが少ない PC でも一度に約 5GB しか使わない）
#
# 置き場所: %LOCALAPPDATA%\natsu-bench（C ドライブ直下には作れないため）
# 結果: %LOCALAPPDATA%\natsu-bench\results.zip（数とあなたのメモだけ。議事録の本文は入らない）
#
# 実行方法（PowerShell）:
#   powershell -ExecutionPolicy Bypass -File .\bench-summarizer.ps1
#   powershell -ExecutionPolicy Bypass -File .\bench-summarizer.ps1 -Only E4B     （1つだけ: E4B / Qwen3 / E2B）
#   -SkipVulkan : GPU（Vulkan）の比べを飛ばす   -SkipSpeed : llama-bench を飛ばす   -KeepModels : モデルを消さない
#
# Windows PowerShell 5.1 / PowerShell 7 の両方で動作します。
# =====================================================================
param(
    [string]$Only = "",
    [switch]$SkipVulkan,
    [switch]$SkipSpeed,
    [switch]$KeepModels
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

$Root = Join-Path $env:LOCALAPPDATA "natsu-bench"
$Dirs = @{
    llama   = Join-Path $Root "llama"
    vulkan  = Join-Path $Root "llama-vulkan"
    models  = Join-Path $Root "models"
    dl      = Join-Path $Root "dl"
    results = Join-Path $Root "results"
}
foreach ($d in $Dirs.Values) { if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d | Out-Null } }

$Engines = @{
    cpu = @{
        Url  = "https://github.com/ggml-org/llama.cpp/releases/download/b11669/llama-b11669-bin-win-cpu-x64.zip"
        File = "llama-b11669-bin-win-cpu-x64.zip"; Size = [long]19537886
        Sha  = "37b3efcf962847ca869745fd4ccf7f5e7e8dacfeff9fa3523b4ca8cdc66d632b"
    }
    vulkan = @{
        Url  = "https://github.com/ggml-org/llama.cpp/releases/download/b11669/llama-b11669-bin-win-vulkan-x64.zip"
        File = "llama-b11669-bin-win-vulkan-x64.zip"; Size = [long]32182350
        Sha  = "2c07574e7bde71321cb785282b20cc821e951132149eeceeea32ddebdbf0598e"
    }
}
$Models = @(
    @{ Key = "E4B"; Name = "Gemma 4 E4B-it Q4_K_M（第一候補）"
       Url = "https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/resolve/bfc15c382204943c3a8fff0c750b94ae2364d7a3/gemma-4-E4B-it-Q4_K_M.gguf"
       File = "gemma-4-E4B-it-Q4_K_M.gguf"; Size = [long]4977171584
       Sha = "85a896a047553e842f25297ee5b031d64ff30147d9c4af17b1e4b394cd1fab87" },
    @{ Key = "Qwen3"; Name = "Qwen3-4B-Instruct-2507 Q4_K_M（次点）"
       Url = "https://huggingface.co/bartowski/Qwen_Qwen3-4B-Instruct-2507-GGUF/resolve/ae44f08e1392f39c0e474af10c3ff8355c8b6688/Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf"
       File = "Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf"; Size = [long]2497280736
       Sha = "2fde00ce69dd4899c70d020845e2638353015bba0fdf161b3eb965f2bca4464e" },
    @{ Key = "E2B"; Name = "Gemma 4 E2B-it Q4_K_M（軽い代わり）"
       Url = "https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/0314792d7f1f7e229411f620751375812bb9faf2/gemma-4-E2B-it-Q4_K_M.gguf"
       File = "gemma-4-E2B-it-Q4_K_M.gguf"; Size = [long]3106738272
       Sha = "740185b21d22ceb83a11c3aa62ad5842ef32c70f6096d756bbee85a1e4ec34b8" }
)
if ($Only) {
    $Models = @($Models | Where-Object { $_.Key -eq $Only })
    if ($Models.Count -eq 0) { Write-Host "-Only には E4B・Qwen3・E2B のどれかを書いてください。" -ForegroundColor Red; exit 2 }
}

$Csv = Join-Path $Dirs.results "summary-runs.csv"
if (-not (Test-Path $Csv)) {
    "モデル,議事録,時間(分),llama最大GB,whisper最大GB,使用中GB,途中で切れた,作り話の数,見出しと書式,繰り返し,メモ" | Set-Content -Path $Csv -Encoding UTF8
}
$Log = Join-Path $Dirs.results "log.txt"
function Write-Log { param([string]$Text) Write-Host $Text; Add-Content -Path $Log -Value ((Get-Date).ToString("yyyy-MM-dd HH:mm:ss") + " " + $Text) -Encoding UTF8 }

function Get-FreeBytes {
    $q = (Split-Path $Root -Qualifier)
    return [long](New-Object System.IO.DriveInfo($q)).AvailableFreeSpace
}

function Test-Hash {
    param([string]$Path, [string]$Sha)
    $h = (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLower()
    return ($h -eq $Sha)
}

# 落として照らす。合っていればそのまま使い、違えば1回だけ全部取り直す
function Get-Verified {
    param([string]$Url, [string]$Out, [long]$Size, [string]$Sha, [string]$Label)
    for ($round = 1; $round -le 2; $round++) {
        if ((Test-Path $Out) -and ((Get-Item $Out).Length -eq $Size)) {
            Write-Log ("照合中: " + $Label + "（数分かかることがあります）")
            if (Test-Hash $Out $Sha) { Write-Log ("OK: " + $Label); return }
            Write-Log ("中身が違うので取り直します: " + $Label)
            Remove-Item $Out -Force
        }
        if ((Test-Path $Out) -and ((Get-Item $Out).Length -gt $Size)) { Remove-Item $Out -Force }
        $have = 0
        if (Test-Path $Out) { $have = (Get-Item $Out).Length }
        $need = $Size - $have + 1GB
        $free = Get-FreeBytes
        if ($free -lt $need) {
            Write-Host ("空きが足りません。あと " + [math]::Round(($need - $free) / 1GB, 1) + " GB 空けてから、もう一度実行してください。") -ForegroundColor Red
            exit 1
        }
        Write-Log ("取得中: " + $Label + "（" + [math]::Round($Size / 1GB, 2) + " GB。止まっても続きから取ります）")
        $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
        for ($i = 1; $i -le 30; $i++) {
            $old = $ErrorActionPreference; $ErrorActionPreference = "Continue"
            try {
                if ($curl) { & curl.exe -L -sS --retry 3 --retry-delay 2 -C - -o $Out $Url }
                else { Invoke-WebRequest -Uri $Url -OutFile $Out }
            }
            catch { Write-Host ("  " + $_.Exception.Message) -ForegroundColor Yellow }
            finally { $ErrorActionPreference = $old }
            if ((Test-Path $Out) -and ((Get-Item $Out).Length -ge $Size)) { break }
            $mb = 0
            if (Test-Path $Out) { $mb = [math]::Round((Get-Item $Out).Length / 1MB) }
            Write-Host ("  切れました（今 " + $mb + " MB）。続きから取ります… " + $i + "/30") -ForegroundColor Yellow
            Start-Sleep -Seconds 5
        }
        if (-not ((Test-Path $Out) -and ((Get-Item $Out).Length -eq $Size))) {
            Write-Host ("取得できませんでした: " + $Label + "。会社の回線で止められている場合は、この画面を写して担当に見せてください。") -ForegroundColor Red
            exit 1
        }
    }
    Write-Host ("2回取っても中身が合いませんでした: " + $Label + "。会社の回線で中身が書き換えられているおそれがあります。この画面を写して送ってください。") -ForegroundColor Red
    exit 1
}

function Expand-Engine {
    param([string]$Zip, [string]$Dir)
    if (Test-Path (Join-Path $Dir "llama-bench.exe")) { return }
    Write-Log ("展開中: " + (Split-Path -Leaf $Zip))
    Expand-Archive -Path $Zip -DestinationPath $Dir -Force
    if (-not (Test-Path (Join-Path $Dir "llama-bench.exe"))) {
        $found = Get-ChildItem -Path $Dir -Recurse -Filter "llama-bench.exe" | Select-Object -First 1
        if ($found) { Get-ChildItem -Path $found.DirectoryName | Move-Item -Destination $Dir -Force }
    }
}

# エンジンを動かし、出た行を画面と結果のファイルの両方に残す
function Invoke-Engine {
    param([string]$Dir, [string]$Exe, [string[]]$ArgList, [string]$OutFile)
    Push-Location $Dir
    $old = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    $lines = @()
    $code = 1
    try {
        $lines = & (Join-Path $Dir $Exe) @ArgList 2>&1 | ForEach-Object { $s = "$_"; Write-Host $s; $s }
        $code = $LASTEXITCODE
    }
    catch {
        $lines += ("起動できませんでした: " + $_.Exception.Message)
        Write-Host ("起動できませんでした: " + $_.Exception.Message) -ForegroundColor Red
        Write-Host "会社の設定で、このフォルダの exe の実行が止められているかもしれません。NaTsu の取り込み先にも関わるので、この画面を写して送ってください。" -ForegroundColor Red
    }
    finally { $ErrorActionPreference = $old; Pop-Location }
    $lines | Set-Content -Path $OutFile -Encoding UTF8
    return $code
}

# llama-bench の表から、スレッド数ごとの速さを読む
function Get-BestThreads {
    param([string]$File, [string]$Test)
    $best = $null; $bestV = 0
    $hdr = $null
    foreach ($line in (Get-Content -Path $File -Encoding UTF8)) {
        if ($line -notmatch '^\|') { continue }
        $cells = @($line.Trim('|').Split('|') | ForEach-Object { $_.Trim() })
        if ($cells -contains "threads" -and $cells -contains "test") { $hdr = $cells; continue }
        if (-not $hdr) { continue }
        $ti = [array]::IndexOf($hdr, "threads"); $si = [array]::IndexOf($hdr, "test"); $vi = [array]::IndexOf($hdr, "t/s")
        if ($ti -lt 0 -or $si -lt 0 -or $vi -lt 0 -or $cells.Count -le $vi) { continue }
        if ($cells[$si] -ne $Test) { continue }
        $v = 0.0
        if ([double]::TryParse(($cells[$vi] -split '\s')[0], [ref]$v) -and $v -gt $bestV) { $bestV = $v; $best = $cells[$ti] }
    }
    return $best
}

function Read-YesNo {
    param([string]$Prompt)
    $a = Read-Host ($Prompt + " (y/n)")
    return ($a -match '^[yYｙＹはい]')
}

function Get-PeakGB {
    param([string]$Name)
    $p = Get-Process -Name $Name -ErrorAction SilentlyContinue | Sort-Object PeakWorkingSet64 -Descending | Select-Object -First 1
    if (-not $p) { return "" }
    return [string][math]::Round($p.PeakWorkingSet64 / 1GB, 2)
}

function Get-UsedGB {
    $os = Get-CimInstance -ClassName Win32_OperatingSystem
    return [string][math]::Round(($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / 1MB, 2)
}

# ---------------------------------------------------------------------
Write-Log "=== 要約のモデルの比べ（第0b回 Task 0）を始めます ==="
Write-Log ("置き場所: " + $Root + "   空き: " + [math]::Round((Get-FreeBytes) / 1GB, 1) + " GB")

$cpuZip = Join-Path $Dirs.dl $Engines.cpu.File
Get-Verified $Engines.cpu.Url $cpuZip $Engines.cpu.Size $Engines.cpu.Sha "llama.cpp b11669（CPU 版）"
Expand-Engine $cpuZip $Dirs.llama
if (-not $SkipVulkan) {
    $vkZip = Join-Path $Dirs.dl $Engines.vulkan.File
    Get-Verified $Engines.vulkan.Url $vkZip $Engines.vulkan.Size $Engines.vulkan.Sha "llama.cpp b11669（Vulkan 版。比べるだけ）"
    Expand-Engine $vkZip $Dirs.vulkan
}

$threads = ""
$firstNatsu = $true
foreach ($m in $Models) {
    Write-Host ""
    Write-Log ("=== " + $m.Name + " ===")
    $modelPath = Join-Path $Dirs.models $m.File
    Get-Verified $m.Url $modelPath $m.Size $m.Sha $m.Name

    # 測り1: llama-bench（速さだけ）
    $benchFile = Join-Path $Dirs.results ("bench-" + $m.Key + "-cpu.md")
    if ($SkipSpeed) { Write-Log "速さの測り（llama-bench）は飛ばします（-SkipSpeed）" }
    elseif ((Test-Path $benchFile) -and ((Get-Item $benchFile).Length -gt 200)) { Write-Log ("速さは測り済みです: " + (Split-Path -Leaf $benchFile)) }
    else {
        Write-Log "速さを測ります（llama-bench。数十分かかります。この間 PC を使うと数が乱れるので、なるべく触らないでください）"
        $args1 = @("-m", ("..\models\" + $m.File), "-p", "512,4096", "-n", "128", "-t", "4,6,8,10", "-fa", "on", "-r", "3", "-o", "md")
        [void](Invoke-Engine $Dirs.llama "llama-bench.exe" $args1 $benchFile)
        if ((-not $SkipVulkan) -and ($m.Key -eq "E4B")) {
            Write-Log "比べるだけ: Vulkan 版（Iris Xe の GPU）で同じ測り"
            $args2 = $args1 + @("-ngl", "99")
            [void](Invoke-Engine $Dirs.vulkan "llama-bench.exe" $args2 (Join-Path $Dirs.results "bench-E4B-vulkan.md"))
        }
    }
    if ((Test-Path $benchFile) -and -not $threads) {
        $t = Get-BestThreads $benchFile "pp4096"
        if ($t) { $threads = $t }
    }
    if (-not $threads) { $threads = "6" }

    # 測り2: NaTsu で実際の要約
    Write-Host ""
    Write-Log "--- NaTsu で実際の議事録3本を要約します ---"
    if ($true) {  # モデルごとに NaTsu を測り用の設定で起動し直す
        if ($firstNatsu) {
            Write-Host "1. 今の NaTsu の詳細設定（実行ファイル・モデル・文脈長・スレッド数）をメモ帳に写してください（終わったら戻します）。" -ForegroundColor Cyan
        }
        Write-Host "NaTsu をタスクトレイのアイコンから［終了］してください（測り用の設定で起動し直します）。" -ForegroundColor Cyan
        [void](Read-Host "終了したら Enter")
        while (Get-Process -Name "NaTsu" -ErrorAction SilentlyContinue) {
            [void](Read-Host "NaTsu がまだ動いています。タスクトレイから終了してから Enter")
        }
        $exe = Join-Path $env:LOCALAPPDATA "Programs\NaTsu\NaTsu.exe"
        while (-not (Test-Path $exe)) {
            $exe = (Read-Host "NaTsu.exe が見つかりません。NaTsu.exe をこの窓へドラッグして Enter").Trim('"', ' ')
        }
        # 取り込んだ llama と同じ旗を、環境変数で llama-server に渡す（第0b回 Task 16 と同じ）
        $env:LLAMA_ARG_N_PARALLEL = "1"
        $env:LLAMA_ARG_FLASH_ATTN = "on"
        $env:LLAMA_ARG_REASONING = "off"
        $env:LLAMA_ARG_CACHE_RAM = "0"
        Start-Process -FilePath $exe
        $firstNatsu = $false
        Write-Log "NaTsu を測り用の設定で起動しました"
    }
    $server = Join-Path $Dirs.llama "llama-server.exe"
    Write-Host ""
    Write-Host "NaTsu の［設定］→ 詳細設定で、次のように入れてください:" -ForegroundColor Cyan
    Write-Host ("  要約の実行ファイル : " + $server)
    Write-Host ("  要約のモデル       : " + $modelPath + "   ← クリップボードに写しました")
    Write-Host  "  要約の文脈長       : 16384"
    Write-Host ("  要約のスレッド数   : " + $threads + "（速さの測りでいちばん速かった数。3つのモデルで同じにします）")
    try { Set-Clipboard -Value $modelPath } catch { }
    [void](Read-Host "入れ終えたら Enter")

    $labels = @("30分の議事録", "60分の議事録", "90分の議事録")
    foreach ($lab in $labels) {
        Write-Host ""
        Write-Host ("[" + $m.Key + "] " + $lab + ": 先に1分ほど記録して文字起こしのエンジンを起こしておくと、メモリを正しく測れます。") -ForegroundColor Cyan
        [void](Read-Host ("この Enter を押したら、すぐ NaTsu で " + $lab + " を開いて［要約を再生成］を押してください"))
        $t0 = Get-Date
        [void](Read-Host "要約が出たら、すぐ Enter")
        $min = [math]::Round(((Get-Date) - $t0).TotalMinutes, 1)
        $llamaGB = Get-PeakGB "llama-server"
        $whisperGB = Get-PeakGB "whisper-server"
        $usedGB = Get-UsedGB
        Write-Log ("  時間 " + $min + " 分 / llama 最大 " + $llamaGB + " GB / whisper 最大 " + $whisperGB + " GB / 使用中 " + $usedGB + " GB")
        $cut = "いいえ"; if (Read-YesNo "「途中で切れました」の知らせが出ましたか") { $cut = "はい" }
        $fab = Read-Host "文字起こしに無い人名・数・期限を書いていた数（なければ 0）"
        $fmt = Read-Host "見出しと書き方はそろっていましたか（◯ / △ / ×）"
        $rep = "いいえ"; if (Read-YesNo "同じ文や項目の繰り返しがありましたか") { $rep = "はい" }
        $memo = (Read-Host "ほかに気づいたこと（なければ Enter）") -replace ',', '、'
        ($m.Key + "," + $lab + "," + $min + "," + $llamaGB + "," + $whisperGB + "," + $usedGB + "," + $cut + "," + $fab + "," + $fmt + "," + $rep + "," + $memo) | Add-Content -Path $Csv -Encoding UTF8
    }

    if (-not $KeepModels) {
        Write-Host ""
        Write-Host "このモデルのファイルを消して空きを戻します。NaTsu がファイルを開いたままだと消せないので、タスクトレイから NaTsu を［終了］してください。" -ForegroundColor Cyan
        [void](Read-Host "終了したら Enter")
        for ($k = 1; $k -le 5; $k++) {
            try { Remove-Item $modelPath -Force; Write-Log ("消しました: " + $m.File); break }
            catch { [void](Read-Host "まだ使われていて消せません。NaTsu を終了してから Enter") }
        }
    }
}

Write-Host ""
Write-Log "=== 測りが終わりました ==="
$zip = Join-Path $Root "results.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $Dirs.results "*") -DestinationPath $zip
Write-Host "1. NaTsu の詳細設定を、メモ帳に写した元の値に戻してください。" -ForegroundColor Cyan
Write-Host "2. NaTsu をいったん終了し、いつもどおり起動し直してください（測り用の設定を外すため）。" -ForegroundColor Cyan
Write-Host ("3. 次のファイルを送ってください（数とあなたのメモだけで、議事録の本文は入っていません）: " + $zip) -ForegroundColor Cyan
Write-Host ("4. 送った後は、フォルダごと消して空きを戻してください: " + $Root) -ForegroundColor Cyan
try { Start-Process explorer.exe -ArgumentList ("/select,`"" + $zip + "`"") } catch { }
[void](Read-Host "Enter キーを押すと閉じます")
