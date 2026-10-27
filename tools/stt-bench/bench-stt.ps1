# =====================================================================
# bench-stt.ps1 — PC の中の文字起こしの候補を、この PC で比べる（計画 docs/plans/2026-10-27-stt-bench.md）
#
# NaTsu には組み込まない、測るためだけのスクリプトです。NaTsu の設定も、取り込んだエンジンも変えません。
#
# やること:
#   1. 候補のエンジンとモデルを落とし、大きさと SHA-256 を照らす（続きから取り直せる）
#   2. あなたの会議の WAV（2〜3本）を、16kHz・モノラルの形と 75 秒ずつの区切りに直す（頭から 10 分。-MaxMinutes で変えられる）
#   3. 同じ会議の NaTsu の文字起こし（クラウド）を、比べの元（参照）としてメモ帳で保存してもらう
#   4. 候補ごとに文字起こしをして、時間・CPU・GPU・メモリ・ほかのアプリのもたつきの目安・文字誤り率（CER）を測る
#   5. 数だけの表（summary.md・summary.csv）を作る。会議の文はどこにも入らない
#
# 2026-10-27 の答え（GPU から先に）で、測りを2段にした:
#   段1（既定）: A0（今の形・CPU）と D・Dn（同じモデルを Iris Xe の GPU〔Vulkan〕で）だけを比べる
#   段2（-Step 2）: 段1 で GPU が線に届かない・動かないときだけ、CPU の候補（A1・A6・A4・B・C）を同じ音声で測る
# D が GPU を使えなかった回（Vulkan を読めない・初期化に失敗・途中で落ちた）は、表にそのまま書く。CPU に戻って出た数を GPU の数として扱わない。
#
# 置き場所: %LOCALAPPDATA%\natsu-bench\stt（C ドライブ直下には作れないため。OneDrive で同期される所も使わない）
# 結果:     %LOCALAPPDATA%\natsu-bench\stt\results\summary.md（数だけ。そのまま貼って送れる）
# 音声・参照・候補の文字起こしは、この PC の中にだけ残る（送らない・git に入れない）。
#
# 実行方法（PowerShell。このファイルと同じフォルダに wavprep.js・cer.js・probe.js を置く）:
#   powershell -ExecutionPolicy Bypass -File .\bench-stt.ps1
#   -Step 2      … 段2（CPU の候補 A1 A6 A4 B C）を測る。既定は段1（A0 D Dn）
#   -Only A0,C   … 測る候補をしぼる（A0 D Dn A1 A6 A4 B C G。段に関係なく、書いたものだけ）
#   -Extra       … 段2 で任意の候補 G（parakeet-tdt_ctc-0.6b-ja）も測る（約 0.66GB 多く落とす）
#   -MaxMinutes 10 … 音声の頭から何分を使うか（0 で全部）
#   -CerOnly     … 測り直さず、参照を足し直した後の CER と表だけを作り直す
#   -Clean       … 音声・参照・候補の文字起こしを消す（表の数は残す）
#
# Windows PowerShell 5.1 / PowerShell 7 の両方で動作します。
# =====================================================================
param(
    [int]$Step = 1,
    [string]$Only = "",
    [switch]$Extra,
    [int]$MaxMinutes = 10,
    [switch]$CerOnly,
    [switch]$Clean
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

$Here = $PSScriptRoot
$Root = Join-Path $env:LOCALAPPDATA "natsu-bench"
$Stt = Join-Path $Root "stt"
$Dirs = @{
    dl      = Join-Path $Stt "dl"
    whisper = Join-Path $Stt "whisper"
    whisperVk = Join-Path $Stt "whisper-vk"
    sherpa  = Join-Path $Stt "sherpa"
    models  = Join-Path $Stt "models"
    wav     = Join-Path $Stt "wav"
    ref     = Join-Path $Stt "ref"
    results = Join-Path $Stt "results"
    runs    = Join-Path $Stt "results\runs"
    raw     = Join-Path $Stt "raw"
    tmp     = Join-Path $Stt "tmp"
}
foreach ($d in $Dirs.Values) { if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d | Out-Null } }
$Log = Join-Path $Dirs.results "log.txt"
function Write-Log { param([string]$Text) Write-Host $Text; Add-Content -Path $Log -Value ((Get-Date).ToString("yyyy-MM-dd HH:mm:ss") + " " + $Text) -Encoding UTF8 }

# ---------------------------------------------------------------------
# ピン（版・URL・大きさ・SHA-256）。計画の「候補の表」と同じ値。URL は版か commit で固定する
$Pins = @{
    whisperZip = @{ Label = "whisper.cpp b5454（= v1.9.5。CPU 版。NaTsu と同じ）"
        Url = "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip"
        File = "whisper-bin-x64-b5454.zip"; Size = [long]8928640
        Sha = "6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb" }
    # D・Dn の whisper.cpp（同じ v1.9.5 = commit d1be6fde を、Vulkan 付きで NaTsu の CI が作ったもの）。
    # 上流には Windows の Vulkan 版が無いので、計画の「段1」の作り方（手で起こす CI）で作り、NaTsu の配布のリポジトリに
    # 「先行版（prerelease）」として置く（latest にはしない。NaTsu の自動更新は latest と natsu-v の札しか読まない）。
    # Size と Sha は、その CI が出した数を写す。0 と空のあいだは D・Dn を測らない（取得先がまだ無い）。
    whisperVkZip = @{ Label = "whisper.cpp v1.9.5 の Vulkan 版（NaTsu の CI で作ったもの）"
        Url = "https://github.com/Kishi-Satoshi/natsu/releases/download/whisper-vulkan-d1be6fd/whisper-vulkan-bin-x64-d1be6fd.zip"
        File = "whisper-vulkan-bin-x64-d1be6fd.zip"; Size = [long]20440811
        Sha = "d3d6957113b179667eb770592a544ebc290518c30f29c7952b2b58e8f2614510" }
    turbo = @{ Label = "large-v3-turbo q5_0（今のモデル）"
        Url = "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo-q5_0.bin"
        File = "ggml-large-v3-turbo-q5_0.bin"; Size = [long]574041195
        Sha = "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2" }
    vadGgml = @{ Label = "Silero VAD v6.2.0（whisper 用。NaTsu と同じ）"
        Url = "https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin"
        File = "ggml-silero-v6.2.0.bin"; Size = [long]885098
        Sha = "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987" }
    small = @{ Label = "whisper small q8_0"
        Url = "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-small-q8_0.bin"
        File = "ggml-small-q8_0.bin"; Size = [long]264464607
        Sha = "49c8fb02b65e6049d5fa6c04f81f53b867b5ec9540406812c643f177317f779f" }
    sherpaTar = @{ Label = "sherpa-onnx v1.13.8（Windows x64・shared・MT）"
        Url = "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-v1.13.8-win-x64-shared-MT-Release.tar.bz2"
        File = "sherpa-onnx-v1.13.8-win-x64-shared-MT-Release.tar.bz2"; Size = [long]24805859
        Sha = "6dffdc715a4465b989446a6105265d2cb345e7101591a17d35534b6758f6e8df" }
    vadOnnx = @{ Label = "Silero VAD（sherpa-onnx 用）"
        Url = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx"
        File = "silero_vad.onnx"; Size = [long]643854
        Sha = "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6" }
    reazonEnc = @{ Label = "ReazonSpeech k2 v2 の encoder（int8）"
        Url = "https://huggingface.co/reazon-research/reazonspeech-k2-v2/resolve/291488c8151be24d7da4bf7af26e533fad96e407/encoder-epoch-99-avg-1.int8.onnx"
        File = "reazon\encoder-epoch-99-avg-1.int8.onnx"; Size = [long]154670139
        Sha = "2c7bd08a8a99f9ddd0d9e458456577b1f6279214e51426f114f9eced44c54e1d" }
    reazonDec = @{ Label = "ReazonSpeech k2 v2 の decoder（int8）"
        Url = "https://huggingface.co/reazon-research/reazonspeech-k2-v2/resolve/291488c8151be24d7da4bf7af26e533fad96e407/decoder-epoch-99-avg-1.int8.onnx"
        File = "reazon\decoder-epoch-99-avg-1.int8.onnx"; Size = [long]2959337
        Sha = "8f0bff94d38797b03b762634ed03211a8e303d06cc4603cdd0cf4199d6eb1485" }
    reazonJoin = @{ Label = "ReazonSpeech k2 v2 の joiner（int8）"
        Url = "https://huggingface.co/reazon-research/reazonspeech-k2-v2/resolve/291488c8151be24d7da4bf7af26e533fad96e407/joiner-epoch-99-avg-1.int8.onnx"
        File = "reazon\joiner-epoch-99-avg-1.int8.onnx"; Size = [long]2696970
        Sha = "49cc7ea1d3d35a40a27442db5e89996da64bf0e683a903dce76e99e57a12e4de" }
    reazonTok = @{ Label = "ReazonSpeech k2 v2 の tokens"
        Url = "https://huggingface.co/reazon-research/reazonspeech-k2-v2/resolve/291488c8151be24d7da4bf7af26e533fad96e407/tokens.txt"
        File = "reazon\tokens.txt"; Size = [long]45754
        Sha = "2c3ac659818a48a0c04010e0593bbc4d7c8a24a054340b01131499c05fd52def" }
    pkModel = @{ Label = "parakeet-tdt_ctc-0.6b-ja（int8。任意の候補 G）"
        Url = "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt_ctc-0.6b-ja-35000-int8/resolve/bef18eb066808c90bd0f5df5be685767b0732de8/model.int8.onnx"
        File = "parakeet-ja\model.int8.onnx"; Size = [long]655542604
        Sha = "3addd00ef5bd1742078389e540b77394e4a508bdf2f4c9ad1b4a76d93e76598e" }
    pkTok = @{ Label = "parakeet-tdt_ctc-0.6b-ja の tokens"
        Url = "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt_ctc-0.6b-ja-35000-int8/resolve/bef18eb066808c90bd0f5df5be685767b0732de8/tokens.txt"
        File = "parakeet-ja\tokens.txt"; Size = [long]28557
        Sha = "732f64c53909f2620c713f4106b487d92e6f54a6915b3cd3d1dbd32f9f4f392a" }
}

# ---------------------------------------------------------------------
# 今の NaTsu のスレッド数（設定に無ければ NaTsu の既定 = 論理コア数 - 2。4 より少なくしない）
$Logical = [Environment]::ProcessorCount
$CurThreads = [math]::Max(4, $Logical - 2)
try {
    $sp = Join-Path $env:APPDATA "natsu\settings.json"
    if (Test-Path $sp) {
        $s = Get-Content -Path $sp -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($s.localThreads -and [int]$s.localThreads -ge 1) { $CurThreads = [int]$s.localThreads }
    }
} catch { }

# 候補。Files: all = 全部の音声 / first = 1本目だけ（スレッドと優先度の違いは速さと重さだけが変わるので、1本で足りる）
# Step: 0 = どちらの段でも測る（A0 は比べの元。測り済みなら測り直さない）/ 1 = 段1（GPU）/ 2 = 段2（CPU の候補）
# Gpu: 真なら、Vulkan 付きの whisper（whisper-vk）で動かし、GPU を本当に使ったかを記録から確かめる
$Cands = @(
    @{ Key = "A0"; Name = ("今の形（large-v3-turbo q5_0・スレッド " + $CurThreads + "・ふつうの優先度）"); Engine = "whisper"; Model = "turbo"; Threads = $CurThreads; Prio = "Normal"; Files = "all"; Step = 0 },
    @{ Key = "D"; Name = "今のモデルを Iris Xe の GPU（Vulkan）で・スレッド 4・低い優先度"; Engine = "whisper-vk"; Model = "turbo"; Threads = 4; Prio = "BelowNormal"; Files = "all"; Step = 1; Gpu = $true },
    @{ Key = "Dn"; Name = "D と同じで、flash attention を切る（-nfa）"; Engine = "whisper-vk"; Model = "turbo"; Threads = 4; Prio = "BelowNormal"; Files = "first"; Step = 1; Gpu = $true; NoFa = $true },
    @{ Key = "A1"; Name = ("今のモデル・スレッド " + $CurThreads + "・低い優先度"); Engine = "whisper"; Model = "turbo"; Threads = $CurThreads; Prio = "BelowNormal"; Files = "first"; Step = 2 },
    @{ Key = "A6"; Name = "今のモデル・スレッド 6・低い優先度"; Engine = "whisper"; Model = "turbo"; Threads = 6; Prio = "BelowNormal"; Files = "first"; Step = 2 },
    @{ Key = "A4"; Name = "今のモデル・スレッド 4・低い優先度"; Engine = "whisper"; Model = "turbo"; Threads = 4; Prio = "BelowNormal"; Files = "first"; Step = 2 },
    @{ Key = "B"; Name = "whisper small q8_0・スレッド 4・低い優先度"; Engine = "whisper"; Model = "small"; Threads = 4; Prio = "BelowNormal"; Files = "all"; Step = 2 },
    @{ Key = "C"; Name = "ReazonSpeech k2 v2（sherpa-onnx・int8）・スレッド 4・低い優先度"; Engine = "sherpa"; Model = "reazon"; Threads = 4; Prio = "BelowNormal"; Files = "all"; Step = 2 },
    @{ Key = "G"; Name = "parakeet-tdt_ctc-0.6b-ja（sherpa-onnx・int8）・スレッド 4・低い優先度（任意）"; Engine = "sherpa"; Model = "parakeet"; Threads = 4; Prio = "BelowNormal"; Files = "all"; Step = 2; Extra = $true }
)
$AllKeys = @($Cands | ForEach-Object { $_.Key })
$Cands = @($Cands | Where-Object { $Extra -or -not $_.Extra })
# 今のスレッド数が 6 か 4 なら、A6・A4 は A1 と同じなので外す
$Cands = @($Cands | Where-Object { -not (($_.Key -eq "A6" -or $_.Key -eq "A4") -and $_.Threads -eq $CurThreads) })
if ($Only) {
    $want = @($Only.Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    $bad = @($want | Where-Object { $AllKeys -notcontains $_ })
    $Cands = @($Cands | Where-Object { $want -contains $_.Key })
    if ($bad.Count -gt 0 -or $Cands.Count -eq 0) { Write-Host "-Only には A0・D・Dn・A1・A6・A4・B・C（-Extra のときは G も）を , で区切って書いてください。" -ForegroundColor Red; exit 2 }
}
else {
    if ($Step -ne 1 -and $Step -ne 2) { Write-Host "-Step は 1（GPU）か 2（CPU の候補）です。" -ForegroundColor Red; exit 2 }
    $Cands = @($Cands | Where-Object { $_.Step -eq 0 -or $_.Step -eq $Step })
}
# D・Dn の取得先（NaTsu の CI が作った zip）がまだ書かれていなければ、D・Dn は測らない
$VkReady = ($Pins.whisperVkZip.Size -gt 0 -and $Pins.whisperVkZip.Sha.Length -eq 64)
if (-not $VkReady -and @($Cands | Where-Object { $_.Gpu }).Count -gt 0) {
    Write-Host "D・Dn（GPU）の取得先がまだこの道具に書かれていません（計画の段1の CI で作ってから、作り手が書き足します）。D・Dn は飛ばします。" -ForegroundColor Yellow
    $Cands = @($Cands | Where-Object { -not $_.Gpu })
    if (-not $Only -and $Step -eq 1) { Write-Host "段1 は D が無いと比べになりません。終わります。" -ForegroundColor Red; exit 2 }
}

# ---------------------------------------------------------------------
function Get-FreeBytes {
    $q = (Split-Path $Root -Qualifier)
    return [long](New-Object System.IO.DriveInfo($q)).AvailableFreeSpace
}

function Test-Hash {
    param([string]$Path, [string]$Sha)
    $h = (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLower()
    return ($h -eq $Sha)
}

# 落として照らす。合っていればそのまま使い、違えば1回だけ全部取り直す（第0b回 Task 0 の bench-summarizer.ps1 と同じ形）
function Get-Verified {
    param([string]$Url, [string]$Out, [long]$Size, [string]$Sha, [string]$Label)
    $dir = Split-Path -Parent $Out
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
    for ($round = 1; $round -le 2; $round++) {
        if ((Test-Path $Out) -and ((Get-Item $Out).Length -eq $Size)) {
            Write-Log ("照合中: " + $Label)
            if (Test-Hash $Out $Sha) { Write-Log ("OK: " + $Label); return }
            Write-Log ("中身が違うので取り直します: " + $Label)
            Remove-Item $Out -Force
        }
        if ((Test-Path $Out) -and ((Get-Item $Out).Length -gt $Size)) { Remove-Item $Out -Force }
        $have = 0
        if (Test-Path $Out) { $have = (Get-Item $Out).Length }
        $need = $Size - $have + 512MB
        $free = Get-FreeBytes
        if ($free -lt $need) {
            Write-Host ("空きが足りません。あと " + [math]::Round(($need - $free) / 1GB, 1) + " GB 空けてから、もう一度実行してください。") -ForegroundColor Red
            exit 1
        }
        Write-Log ("取得中: " + $Label + "（" + [math]::Round($Size / 1MB) + " MB。止まっても続きから取ります）")
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
            Write-Host ("取得できませんでした: " + $Label + "。会社の回線で止められている場合は、この画面を写して送ってください（取得元: " + ([Uri]$Url).Host + "）。") -ForegroundColor Red
            exit 1
        }
    }
    Write-Host ("2回取っても中身が合いませんでした: " + $Label + "。会社の回線で中身が書き換えられているおそれがあります。この画面を写して送ってください。") -ForegroundColor Red
    exit 1
}

function Get-Pin {
    param([string]$Key)
    $p = $Pins[$Key]
    $out = Join-Path $Dirs.models $p.File
    if ($Key -eq "whisperZip" -or $Key -eq "whisperVkZip" -or $Key -eq "sherpaTar") { $out = Join-Path $Dirs.dl $p.File }
    Get-Verified $p.Url $out $p.Size $p.Sha $p.Label
    return $out
}

# NaTsu が取り込んだモデルが同じ中身なら、落とさずにそれを使う（%LOCALAPPDATA%\natsu\engine\models。読むだけ）
function Get-ModelRel {
    param([string]$Key)
    $p = $Pins[$Key]
    $natsu = Join-Path $env:LOCALAPPDATA ("natsu\engine\models\" + $p.File)
    if ((Test-Path $natsu) -and ((Get-Item $natsu).Length -eq $p.Size)) {
        Write-Log ("照合中: NaTsu が取り込んだ " + $p.Label)
        if (Test-Hash $natsu $p.Sha) { Write-Log ("OK: NaTsu が取り込んだものを使います（落としません）: " + $p.Label); return ("..\..\..\natsu\engine\models\" + $p.File) }
    }
    [void](Get-Pin $Key)
    return ("..\models\" + $p.File)
}

# 引数を1つの文字列にする（空白のある所だけ " で囲む）
function Join-Args {
    param([string[]]$List)
    return (($List | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join " ")
}

# NaTsu.exe を Node として使い、同じフォルダの .js を動かす（ELECTRON_RUN_AS_NODE=1。NaTsu の MCP と同じ使い方）
$NatsuExe = Join-Path $env:LOCALAPPDATA "Programs\NaTsu\NaTsu.exe"
function Find-Natsu {
    while (-not (Test-Path $script:NatsuExe)) {
        $script:NatsuExe = (Read-Host "NaTsu.exe が見つかりません。NaTsu.exe をこの窓へドラッグして Enter").Trim('"', ' ')
    }
}
function Invoke-NodeJs {
    param([string]$Script, [string[]]$ArgList)
    $o = Join-Path $Dirs.tmp "node-out.txt"; $e = Join-Path $Dirs.tmp "node-err.txt"
    Remove-Item $o, $e -ErrorAction SilentlyContinue
    $env:ELECTRON_RUN_AS_NODE = "1"
    try {
        $p = Start-Process -FilePath $NatsuExe -ArgumentList (Join-Args (@((Join-Path $Here $Script)) + $ArgList)) -NoNewWindow -Wait -PassThru -RedirectStandardOutput $o -RedirectStandardError $e
    }
    finally { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
    $text = ""
    if (Test-Path $o) { $text = (Get-Content -Path $o -Raw -Encoding UTF8) }
    if ($p.ExitCode -ne 0) {
        $err = ""
        if (Test-Path $e) { $err = (Get-Content -Path $e -Raw -Encoding UTF8) }
        throw ($Script + " が失敗しました: " + $err)
    }
    return $text
}

function Start-Probe {
    param([string]$OutJson, [string]$Stop)
    Remove-Item $OutJson, $Stop, ($Stop + ".go") -ErrorAction SilentlyContinue
    $env:ELECTRON_RUN_AS_NODE = "1"
    try { $p = Start-Process -FilePath $NatsuExe -ArgumentList (Join-Args @((Join-Path $Here "probe.js"), $OutJson, $Stop)) -PassThru -WindowStyle Hidden }
    finally { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
    return $p
}

function Get-SysCpu {
    try { return [int](Get-CimInstance -ClassName Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'").PercentProcessorTime } catch { return $null }
}

# この候補のプロセスの GPU の使用率（%）。Windows の GPU エンジンのカウンター（WMI）を読み、エンジンの種類（3D・Compute など）ごとに足して、
# いちばん忙しい種類の数を取る。カウンターが読めない PC では $null（表は空になる）。名前は訳されない WMI のクラスなので、日本語の Windows でも同じ
function Get-GpuPct {
    param([int]$ProcId)
    try {
        $rows = @(Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction Stop | Where-Object { $_.Name -like ("pid_" + $ProcId + "_*") })
        if ($rows.Count -eq 0) { return 0 }
        $by = @{}
        foreach ($r in $rows) {
            $t = ($r.Name -replace '^.*engtype_', '')
            if (-not $by.ContainsKey($t)) { $by[$t] = 0 }
            $by[$t] += [int]$r.UtilizationPercentage
        }
        return [int](($by.Values | Measure-Object -Maximum).Maximum)
    } catch { return $null }
}

# 記録に残す誤りの文から、パス（利用者名が入る）を外す
function Hide-Paths {
    param([string]$Text)
    return ($Text -replace '[A-Za-z]:\\[^\s"]*', '<path>')
}

function Get-OnAc {
    try {
        $b = Get-CimInstance -ClassName Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $b) { return "AC" }
        if ($b.BatteryStatus -eq 1) { return "電池" }
        return "AC"
    } catch { return "?" }
}

function Read-YesNo {
    param([string]$Prompt)
    $a = Read-Host ($Prompt + " (y/n)")
    return ($a -match '^[yYｙＹはい]')
}

function Get-Meta {
    param([string]$Label)
    $f = Join-Path $Dirs.wav ($Label + "\meta.json")
    if (-not (Test-Path $f)) { return $null }
    return (Get-Content -Path $f -Raw -Encoding UTF8 | ConvertFrom-Json)
}

# 測り1回の結果は、全部そろってから1つのファイルとして置く（一時のファイルに書いて名前を替える。途中で止めても半端が残らない）
function Save-Run {
    param($Rec, [string]$File)
    $t = $File + ".tmp"
    ($Rec | ConvertTo-Json -Depth 4) | Set-Content -Path $t -Encoding UTF8
    Move-Item -Path $t -Destination $File -Force
}
# 読めない結果のファイルは消さずに .broken-<時刻> へ退け、その回を測り直す
function Read-Run {
    param([string]$File)
    try { return (Get-Content -Path $File -Raw -Encoding UTF8 | ConvertFrom-Json) }
    catch {
        $b = $File + ".broken-" + (Get-Date).ToString("yyyyMMddHHmmss")
        Move-Item -Path $File -Destination $b -Force
        Write-Log ("読めない結果を退けました（測り直します）: " + (Split-Path -Leaf $File))
        return $null
    }
}

# ---------------------------------------------------------------------
if ($Clean) {
    foreach ($d in @($Dirs.wav, $Dirs.ref, $Dirs.raw, $Dirs.tmp)) { if (Test-Path $d) { Remove-Item -Recurse -Force $d } }
    Write-Host "音声・参照・候補の文字起こしを消しました。表（results）は残しています。" -ForegroundColor Cyan
    exit 0
}

Write-Log "=== 文字起こしの候補の比べ（2026-10-27 の計画）を始めます ==="
Write-Log ("置き場所: " + $Stt + "   空き: " + [math]::Round((Get-FreeBytes) / 1GB, 1) + " GB   論理コア: " + $Logical + "   今のスレッド数: " + $CurThreads)
Find-Natsu
foreach ($js in @("wavprep.js", "cer.js", "probe.js")) {
    if (-not (Test-Path (Join-Path $Here $js))) { Write-Host ($js + " がこのスクリプトと同じフォルダにありません。4つのファイルを同じフォルダに置いてください。") -ForegroundColor Red; exit 1 }
}

# ---------------------------------------------------------------------
# 1. エンジンとモデル
$need = @{}
foreach ($c in $Cands) { $need[$c.Engine] = $true; $need[$c.Model] = $true }
$Rel = @{}
if (-not $CerOnly) {
    # whisper.cpp の zip を開き、whisper-cli.exe のあるフォルダの中身を置く（CPU 版と Vulkan 版は別のフォルダ。混ぜると CPU 版も GPU を使ってしまう）
    function Expand-Whisper {
        param([string]$PinKey, [string]$Dest, [string]$Label)
        $zip = Get-Pin $PinKey
        if (Test-Path (Join-Path $Dest "whisper-cli.exe")) { return }
        Write-Log ("展開中: " + $Label)
        $x = Join-Path $Dirs.tmp "whisper-x"
        if (Test-Path $x) { Remove-Item -Recurse -Force $x }
        Expand-Archive -Path $zip -DestinationPath $x -Force
        $found = Get-ChildItem -Path $x -Recurse -Filter "whisper-cli.exe" | Select-Object -First 1
        if (-not $found) { Write-Host "zip の中に whisper-cli.exe がありません。この画面を写して送ってください。" -ForegroundColor Red; exit 1 }
        if (-not (Test-Path $Dest)) { New-Item -ItemType Directory -Path $Dest | Out-Null }
        Get-ChildItem -Path $found.DirectoryName | Move-Item -Destination $Dest -Force
        Remove-Item -Recurse -Force $x
    }
    if ($need["whisper"]) { Expand-Whisper "whisperZip" $Dirs.whisper "whisper.cpp（CPU 版）" }
    if ($need["whisper-vk"]) {
        Expand-Whisper "whisperVkZip" $Dirs.whisperVk "whisper.cpp（Vulkan 版）"
        if (-not (Test-Path (Join-Path $Dirs.whisperVk "ggml-vulkan.dll"))) { Write-Host "Vulkan 版の zip に ggml-vulkan.dll がありません。この画面を写して送ってください。" -ForegroundColor Red; exit 1 }
    }
    if ($need["whisper"] -or $need["whisper-vk"]) { $Rel["vadGgml"] = Get-ModelRel "vadGgml" }
    if ($need["turbo"]) { $Rel["turbo"] = Get-ModelRel "turbo" }
    if ($need["small"]) { [void](Get-Pin "small"); $Rel["small"] = "..\models\" + $Pins.small.File }
    if ($need["sherpa"]) {
        $tarFile = Get-Pin "sherpaTar"
        if (-not (Test-Path (Join-Path $Dirs.sherpa "sherpa-onnx-vad-with-offline-asr.exe"))) {
            Write-Log "展開中: sherpa-onnx（Windows の tar.exe を使います）"
            $tarExe = Join-Path $env:SystemRoot "System32\tar.exe"
            $x = Join-Path $Dirs.tmp "sherpa-x"
            if (Test-Path $x) { Remove-Item -Recurse -Force $x }
            New-Item -ItemType Directory -Path $x | Out-Null
            $ok = $false
            if (Test-Path $tarExe) {
                Push-Location $x
                $old = $ErrorActionPreference; $ErrorActionPreference = "Continue"
                try { & $tarExe -xjf ("..\..\dl\" + $Pins.sherpaTar.File) 2>&1 | Out-Null; $ok = ($LASTEXITCODE -eq 0) }
                catch { $ok = $false }
                finally { $ErrorActionPreference = $old; Pop-Location }
            }
            $found = Get-ChildItem -Path $x -Recurse -Filter "sherpa-onnx-vad-with-offline-asr.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
            if (-not $ok -or -not $found) {
                Write-Host "sherpa-onnx の tar.bz2 を展開できませんでした（この PC の tar.exe が bzip2 を読めない可能性があります）。" -ForegroundColor Red
                Write-Host ("エクスプローラーで次のファイルを右クリック →［すべて展開］し、中の bin フォルダの中身を全部 " + $Dirs.sherpa + " に置いてから、もう一度実行してください: " + $tarFile) -ForegroundColor Red
                exit 1
            }
            Get-ChildItem -Path $found.DirectoryName | Move-Item -Destination $Dirs.sherpa -Force
            Remove-Item -Recurse -Force $x
        }
        [void](Get-Pin "vadOnnx")
    }
    if ($need["reazon"]) { foreach ($k in @("reazonEnc", "reazonDec", "reazonJoin", "reazonTok")) { [void](Get-Pin $k) } }
    if ($need["parakeet"]) { foreach ($k in @("pkModel", "pkTok")) { [void](Get-Pin $k) } }
}

# ---------------------------------------------------------------------
# 2. 音声（m1・m2・m3）
$Labels = @()
foreach ($l in @("m1", "m2", "m3")) { if (Get-Meta $l) { $Labels += $l } }
if (-not $CerOnly) {
    if ($Labels.Count -gt 0) {
        Write-Log ("用意済みの音声: " + ($Labels -join ", "))
        if (Read-YesNo "音声を入れ替えますか（入れ替えると、その音声の測りは消えます）") {
            foreach ($l in $Labels) {
                Remove-Item -Recurse -Force (Join-Path $Dirs.wav $l)
                Get-ChildItem -Path $Dirs.runs -Filter ("*-" + $l + ".json") -ErrorAction SilentlyContinue | Remove-Item -Force
            }
            $Labels = @()
        }
    }
    if ($Labels.Count -eq 0) {
        Write-Host ""
        Write-Host "会議の WAV を 2〜3 本使います（作り方は README の「音声の用意」）。1本ずつ、この窓へドラッグして Enter を押してください。" -ForegroundColor Cyan
        Write-Host ("頭から " + $MaxMinutes + " 分だけを使います（0 なら全部）。元のファイルは変えません。音声はこの PC の中にだけ置きます。") -ForegroundColor Cyan
        foreach ($l in @("m1", "m2", "m3")) {
            $in = (Read-Host ($l + " の WAV（もう無ければ空のまま Enter）")).Trim('"', ' ')
            if (-not $in) { break }
            if (-not (Test-Path $in)) { Write-Host "見つかりません。もう一度。" -ForegroundColor Yellow; continue }
            $out = Join-Path $Dirs.wav $l
            try {
                $j = Invoke-NodeJs "wavprep.js" @($in, $out, "--max-sec", [string]($MaxMinutes * 60), "--chunk-sec", "75")
                $m = $j | ConvertFrom-Json
                Write-Log ("  " + $l + ": " + $m.sec + " 秒（元は " + $m.inRate + " Hz・" + $m.inChannels + " ch・" + $m.inBits + " ビット。平均の大きさ " + $m.rmsDbfs + " dBFS）")
                if ($m.rmsDbfs -ne $null -and $m.rmsDbfs -lt -45) { Write-Host "  音がとても小さいです。マイクの位置や入力の大きさを見直して録り直すと、比べやすくなります。" -ForegroundColor Yellow }
                $Labels += $l
            }
            catch { Write-Host ("  " + $_.Exception.Message) -ForegroundColor Red }
        }
        if ($Labels.Count -eq 0) { Write-Host "音声がありません。終わります。" -ForegroundColor Red; exit 1 }
    }
}
if ($Labels.Count -eq 0) { Write-Host "音声がありません（-CerOnly の前に、ふつうに1回実行してください）。" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------------
# 3. 参照（同じ会議の NaTsu の文字起こし）
$missing = @($Labels | Where-Object { -not (Test-Path (Join-Path $Dirs.ref ($_ + ".txt"))) })
if ($missing.Count -gt 0) {
    Write-Host ""
    Write-Host "比べの元（参照）を用意します。NaTsu で同じ会議のページを開き、文字起こしのタブで［コピー］を押してください。" -ForegroundColor Cyan
    Write-Host "開いたメモ帳に貼り付けて、上書き保存（Ctrl+S）して閉じてください。参照はこの PC の中にだけ置き、送りません。" -ForegroundColor Cyan
    foreach ($l in $missing) {
        if (-not (Read-YesNo ($l + " の参照を今入れますか（後で入れて -CerOnly で作り直すこともできます）"))) { continue }
        $rf = Join-Path $Dirs.ref ($l + ".txt")
        [System.IO.File]::WriteAllText($rf, "", (New-Object System.Text.UTF8Encoding($false)))
        # Windows 11 のメモ帳は、開いている窓のタブとして開くと -Wait で待てないので、Enter で待つ
        Start-Process -FilePath "notepad.exe" -ArgumentList ('"' + $rf + '"')
        [void](Read-Host ("メモ帳に " + $l + " の文字起こしを貼って上書き保存したら Enter"))
        if ((Get-Item $rf).Length -eq 0) { Remove-Item $rf -Force; Write-Host ("  " + $l + " の参照は空でした（CER は出しません）") -ForegroundColor Yellow }
    }
}

function Get-Cer {
    param([string]$Label, [string]$RawFile)
    $rf = Join-Path $Dirs.ref ($Label + ".txt")
    if (-not (Test-Path $rf) -or -not (Test-Path $RawFile)) { return $null }
    try { return ((Invoke-NodeJs "cer.js" @($rf, $RawFile, "--max-sec", [string]($MaxMinutes * 60))) | ConvertFrom-Json) }
    catch { Write-Host ("  CER: " + $_.Exception.Message) -ForegroundColor Yellow; return $null }
}

# A0（今の形）の文と比べたずれ（%）。D・Dn の GPU が CPU と違う文を出していないかの目安（参照が無くても出せる）
function Get-VsA0 {
    param([string]$Key, [string]$Label, [string]$RawFile)
    if ($Key -eq "A0") { return $null }
    $a0 = Join-Path $Dirs.raw ("A0-" + $Label + ".txt")
    if (-not (Test-Path $a0) -or -not (Test-Path $RawFile)) { return $null }
    try { return (((Invoke-NodeJs "cer.js" @($a0, $RawFile)) | ConvertFrom-Json).cer) }
    catch { return $null }
}

# ---------------------------------------------------------------------
# 4. 測り
function Invoke-Candidate {
    param($Cand, [string]$Label)
    $meta = Get-Meta $Label
    $wavDir = Join-Path $Dirs.wav $Label
    $rawFile = Join-Path $Dirs.raw ($Cand.Key + "-" + $Label + ".txt")
    $t = [string]$Cand.Threads
    if ($Cand.Engine -eq "whisper" -or $Cand.Engine -eq "whisper-vk") {
        $cwd = $Dirs.whisper
        if ($Cand.Engine -eq "whisper-vk") { $cwd = $Dirs.whisperVk }
        $exe = Join-Path $cwd "whisper-cli.exe"
        # NaTsu の whisper-server と同じ解き方（-l ja・-sns・VAD・温度 0 から・best_of 2・ビーム探索なし・flash attention は既定の入）。区切りは NaTsu と同じ 75 秒
        # -np（記録を出さない）は付けない: GPU を本当に使ったか（load_backend・whisper_backend_init_gpu の行）を記録から読むため。記録は tmp に置き、表には入れない
        $a = @("-m", $Rel[$Cand.Model], "-t", $t, "-l", "ja", "-sns", "--vad", "-vm", $Rel["vadGgml"], "-bs", "1", "-bo", "2", "-otxt")
        if ($Cand.NoFa) { $a += @("-nfa") }
        $chunks = @(Get-ChildItem -Path $wavDir -Filter "c*.wav" | Sort-Object Name)
        foreach ($ch in $chunks) { $a += @("-f", ("..\wav\" + $Label + "\" + $ch.Name)); Remove-Item ($ch.FullName + ".txt") -ErrorAction SilentlyContinue }
    }
    else {
        $cwd = $Dirs.sherpa; $exe = Join-Path $cwd "sherpa-onnx-vad-with-offline-asr.exe"
        $a = @("--silero-vad-model=..\models\silero_vad.onnx", ("--num-threads=" + $t), "--decoding-method=greedy_search")
        if ($Cand.Model -eq "reazon") {
            $a += @("--tokens=..\models\reazon\tokens.txt", "--encoder=..\models\reazon\encoder-epoch-99-avg-1.int8.onnx",
                    "--decoder=..\models\reazon\decoder-epoch-99-avg-1.int8.onnx", "--joiner=..\models\reazon\joiner-epoch-99-avg-1.int8.onnx")
        }
        else {
            $a += @("--tokens=..\models\parakeet-ja\tokens.txt", "--nemo-ctc-model=..\models\parakeet-ja\model.int8.onnx")
        }
        $a += @("..\wav\" + $Label + "\full.wav")
    }
    $outF = Join-Path $Dirs.tmp "run-out.txt"; $errF = Join-Path $Dirs.tmp "run-err.txt"
    Remove-Item $outF, $errF -ErrorAction SilentlyContinue

    # 静かなときの目安（30 秒）→ 文字起こし → 止める
    $probeJson = Join-Path $Dirs.tmp "probe.json"; $stop = Join-Path $Dirs.tmp "probe.stop"
    $probe = Start-Probe $probeJson $stop
    Write-Host "  静かなときの目安を測っています（30 秒）…" -ForegroundColor DarkGray
    Start-Sleep -Seconds 30
    New-Item -ItemType File -Path ($stop + ".go") -Force | Out-Null

    $sw = [Diagnostics.Stopwatch]::StartNew()
    $p = Start-Process -FilePath $exe -ArgumentList (Join-Args $a) -WorkingDirectory $cwd -NoNewWindow -PassThru -RedirectStandardOutput $outF -RedirectStandardError $errF
    $null = $p.Handle   # 終わった後に終了コードを読むため（Windows PowerShell 5.1 の決まり）
    try { $p.PriorityClass = [System.Diagnostics.ProcessPriorityClass]$Cand.Prio } catch { Write-Host "  優先度を変えられませんでした" -ForegroundColor Yellow }
    $cpuPrev = [TimeSpan]::Zero; $tPrev = 0.0
    $cpuPeak = 0.0; $wsPeak = [long]0; $sys = @(); $gpuS = @(); $tick = 0
    while (-not $p.HasExited) {
        Start-Sleep -Milliseconds 1000
        $tick++
        try {
            $p.Refresh()
            $cpu = $p.TotalProcessorTime; $now = $sw.Elapsed.TotalSeconds
            if ($now -gt $tPrev) {
                $pct = (($cpu - $cpuPrev).TotalSeconds / ($now - $tPrev)) / $Logical * 100
                if ($pct -gt $cpuPeak) { $cpuPeak = $pct }
            }
            $cpuPrev = $cpu; $tPrev = $now
            if ($p.PeakWorkingSet64 -gt $wsPeak) { $wsPeak = $p.PeakWorkingSet64 }
        } catch { }
        if (($tick % 2) -eq 0) {
            $v = Get-SysCpu; if ($v -ne $null) { $sys += $v }
            $g = Get-GpuPct $p.Id; if ($g -ne $null) { $gpuS += $g }
        }
        if (($tick % 60) -eq 0) { Write-Host ("  " + [math]::Round($sw.Elapsed.TotalMinutes) + " 分たちました…") -ForegroundColor DarkGray }
    }
    $p.WaitForExit()
    $wall = $sw.Elapsed.TotalSeconds
    $cpuTotal = $null
    try { $cpuTotal = $p.TotalProcessorTime.TotalSeconds } catch { $cpuTotal = $cpuPrev.TotalSeconds }
    if ($cpuTotal -lt $cpuPrev.TotalSeconds) { $cpuTotal = $cpuPrev.TotalSeconds }   # 終わった後に読めなかったときは、最後に見た数
    $code = $p.ExitCode
    New-Item -ItemType File -Path $stop -Force | Out-Null
    for ($k = 0; $k -lt 20 -and -not (Test-Path $probeJson); $k++) { Start-Sleep -Milliseconds 500 }
    try { if (-not $probe.HasExited) { $probe.Kill() } } catch { }
    $pr = $null
    if (Test-Path $probeJson) { $pr = Get-Content -Path $probeJson -Raw -Encoding UTF8 | ConvertFrom-Json }

    # GPU を本当に使ったか（D・Dn）。whisper.cpp の記録の行で見分ける。CPU に戻って出た数を GPU の数として扱わないため
    $errText = ""
    if (Test-Path $errF) { $errText = [string](Get-Content -Path $errF -Raw -Encoding UTF8) }
    $gpuState = "CPU"; $gpuName = $null
    if ($Cand.Gpu) {
        # whisper.cpp は「using Vulkan0 backend」を出してから初期化し、失敗すると「failed to initialize Vulkan0 backend」を出して CPU で続ける。だから失敗の行を先に見る
        if ($errText -match 'DeviceLost|getFenceStatus') { $gpuState = "GPU で落ちた" }
        elseif ($errText -match 'failed to initialize Vulkan') { $gpuState = "CPU に戻った（GPU の初期化に失敗）" }
        elseif ($errText -match 'whisper_backend_init_gpu: using Vulkan') {
            $gpuState = "GPU"
            if ($code -ne 0) { $gpuState = "GPU で落ちた" }
        }
        elseif ($errText -match 'load_backend: loaded Vulkan backend') { $gpuState = "CPU に戻った（GPU が見つからない）" }
        else { $gpuState = "CPU に戻った（Vulkan を読めない）" }
        $mm = [regex]::Match($errText, 'ggml_vulkan: 0 = ([^|(\r\n]+)')
        if ($mm.Success) { $gpuName = $mm.Groups[1].Value.Trim() }
        if ($gpuState -ne "GPU") { Write-Host ("  " + $Cand.Key + ": " + $gpuState + "。この回の数は GPU の数ではありません。") -ForegroundColor Yellow }
    }

    # 候補の文字起こしは、この PC の中（raw）にだけ置く
    if ($Cand.Engine -eq "whisper" -or $Cand.Engine -eq "whisper-vk") {
        $parts = @()
        foreach ($ch in @(Get-ChildItem -Path $wavDir -Filter "c*.wav" | Sort-Object Name)) {
            $tf = $ch.FullName + ".txt"
            if (Test-Path $tf) { $parts += (Get-Content -Path $tf -Raw -Encoding UTF8); Remove-Item $tf -Force }
        }
        [System.IO.File]::WriteAllText($rawFile, ($parts -join "`n"), (New-Object System.Text.UTF8Encoding($false)))
    }
    else {
        if (Test-Path $outF) { Copy-Item $outF $rawFile -Force } else { [System.IO.File]::WriteAllText($rawFile, "", (New-Object System.Text.UTF8Encoding($false))) }
    }
    if ($code -ne 0 -and (Test-Path $errF)) {
        # 誤りの終わりの数行だけを記録に残す（音声の文は stderr に出ない）
        $tail = @(Get-Content -Path $errF -Encoding UTF8 | Select-Object -Last 5)
        Write-Log ("  終了コード " + $code + ": " + (Hide-Paths ($tail -join " / ")))
    }

    Remove-Item $outF, $errF -ErrorAction SilentlyContinue   # whisper-cli の画面の出力（文が入る）は残さない
    $cer = Get-Cer $Label $rawFile
    $vs = Get-VsA0 $Cand.Key $Label $rawFile
    $gpuAvg = $null; $gpuPeak = $null
    if ($gpuS.Count -gt 0) { $gpuAvg = [math]::Round((($gpuS | Measure-Object -Average).Average), 1); $gpuPeak = ($gpuS | Measure-Object -Maximum).Maximum }
    $sysAvg = $null; $sysPeak = $null
    if ($sys.Count -gt 0) { $sysAvg = [math]::Round((($sys | Measure-Object -Average).Average), 1); $sysPeak = ($sys | Measure-Object -Maximum).Maximum }
    $workX = $null
    if ($pr -and $pr.idle.work.p50 -and $pr.load.work.p50) { $workX = [math]::Round($pr.load.work.p50 / $pr.idle.work.p50, 2) }
    $rec = [ordered]@{
        cand = $Cand.Key; file = $Label; audioSec = $meta.sec; wallSec = [math]::Round($wall, 1)
        rtf = [math]::Round($wall / [math]::Max(1, $meta.sec), 3)
        cpuAvgPct = [math]::Round(($cpuTotal / [math]::Max(0.001, $wall)) / $Logical * 100, 1)
        cpuPeakPct = [math]::Round($cpuPeak, 1)
        coresAvg = [math]::Round($cpuTotal / [math]::Max(0.001, $wall), 2)
        sysCpuAvgPct = $sysAvg; sysCpuPeakPct = $sysPeak
        peakMemMB = [math]::Round($wsPeak / 1MB)
        lagP95IdleMs = $null; lagP95LoadMs = $null; lagMaxLoadMs = $null; workX = $workX
        cer = $null; lenRatio = $null; refChars = $null; hypPeriods = $null; vsA0 = $vs
        gpu = $gpuState; gpuName = $gpuName; gpuAvgPct = $gpuAvg; gpuPeakPct = $gpuPeak
        exit = $code; power = (Get-OnAc); threads = $Cand.Threads; prio = $Cand.Prio
        at = (Get-Date).ToString("yyyy-MM-dd HH:mm")
    }
    if ($pr) { $rec.lagP95IdleMs = $pr.idle.lag.p95; $rec.lagP95LoadMs = $pr.load.lag.p95; $rec.lagMaxLoadMs = $pr.load.lag.max }
    if ($cer) { $rec.cer = $cer.cer; $rec.lenRatio = $cer.lenRatio; $rec.refChars = $cer.refChars; $rec.hypPeriods = $cer.hypPeriods }
    Save-Run $rec (Join-Path $Dirs.runs ($Cand.Key + "-" + $Label + ".json"))
    Write-Log ("  " + $Cand.Key + " " + $Label + ": 処理 " + $rec.wallSec + " 秒（RTF " + $rec.rtf + "）・CPU 平均 " + $rec.cpuAvgPct + "%・GPU 平均 " + $rec.gpuAvgPct + "%（" + $rec.gpu + "）・最大メモリ " + $rec.peakMemMB + " MB・CER " + $rec.cer + "・A0 とのずれ " + $rec.vsA0)
    return $rec
}

if (-not $CerOnly) {
    $plan = @()
    foreach ($l in $Labels) {
        foreach ($c in $Cands) {
            if ($c.Files -eq "first" -and $l -ne $Labels[0]) { continue }
            $rj = Join-Path $Dirs.runs ($c.Key + "-" + $l + ".json")
            if ((Test-Path $rj) -and (Read-Run $rj)) { continue }
            $plan += , @($c, $l)
        }
    }
    if ($plan.Count -gt 0) {
        $est = 0.0
        foreach ($x in $plan) {
            $r = 0.3
            if ($x[0].Gpu) { $r = 0.8 } elseif ($x[0].Model -eq "turbo") { $r = 2.0 } elseif ($x[0].Model -eq "small") { $r = 0.6 }
            $est += (Get-Meta $x[1]).sec * $r + 40
        }
        Write-Host ""
        Write-Log ("測りは " + $plan.Count + " 回。目安 " + [math]::Ceiling($est / 60) + " 分（今のモデルは音声の約 2 倍の時間がかかる見込み）。途中で止めても、次は続きから測ります。")
        Write-Host "測りの間は PC を使わないでください（数が乱れます）。電源につなぎ、ふたを開けたままにしてください。" -ForegroundColor Cyan
        Write-Host "NaTsu をタスクトレイのアイコンから［終了］してください（NaTsu の文字起こしと CPU を取り合わないため）。" -ForegroundColor Cyan
        [void](Read-Host "終了したら Enter")
        while (Get-Process -Name "whisper-server" -ErrorAction SilentlyContinue) {
            [void](Read-Host "NaTsu の文字起こしのエンジン（whisper-server）がまだ動いています。NaTsu を終了してから Enter")
        }
        if ((Get-OnAc) -eq "電池") { Write-Host "電池で動いています。電源につなぐと、数が安定します。" -ForegroundColor Yellow }
        $gpuBroken = $false
        foreach ($x in $plan) {
            Write-Host ""
            if ($x[0].Gpu -and $gpuBroken) {
                # 一度 GPU を使えなかったら、残りの D・Dn は飛ばす（CPU に戻った D を何時間も回さない）。次に実行すると、もう一度試す
                Write-Log ("--- " + $x[0].Key + " × " + $x[1] + " は飛ばします（前の回で GPU を使えませんでした） ---")
                continue
            }
            Write-Log ("--- " + $x[0].Key + "（" + $x[0].Name + "）× " + $x[1] + " ---")
            $r = @(Invoke-Candidate $x[0] $x[1]) | Select-Object -Last 1
            if ($x[0].Gpu -and $r -and $r.gpu -ne "GPU") { $gpuBroken = $true }
        }
    }
}
else {
    # 参照を足した後: raw から CER だけ計算し直す
    foreach ($f in @(Get-ChildItem -Path $Dirs.runs -Filter "*.json" -ErrorAction SilentlyContinue)) {
        $r = Read-Run $f.FullName
        if (-not $r) { continue }
        $cer = Get-Cer $r.file (Join-Path $Dirs.raw ($r.cand + "-" + $r.file + ".txt"))
        if ($cer) { $r.cer = $cer.cer; $r.lenRatio = $cer.lenRatio; $r.refChars = $cer.refChars; $r.hypPeriods = $cer.hypPeriods }
        $vs = Get-VsA0 $r.cand $r.file (Join-Path $Dirs.raw ($r.cand + "-" + $r.file + ".txt"))
        if ($vs -ne $null) { $r | Add-Member -NotePropertyName vsA0 -NotePropertyValue $vs -Force }
        if ($cer -or $vs -ne $null) { Save-Run $r $f.FullName }
    }
}

# ---------------------------------------------------------------------
# 5. 表（数だけ）
$runs = @(Get-ChildItem -Path $Dirs.runs -Filter "*.json" -ErrorAction SilentlyContinue | ForEach-Object { Read-Run $_.FullName } | Where-Object { $_ })
if ($runs.Count -eq 0) { Write-Host "測りの結果がまだありません。" -ForegroundColor Yellow; exit 0 }
$order = @("A0", "D", "Dn", "A1", "A6", "A4", "B", "C", "G")
$runs = @($runs | Sort-Object @{ Expression = { [array]::IndexOf($order, $_.cand) } }, file)

$rows = foreach ($r in $runs) {
    [pscustomobject][ordered]@{
        "候補" = $r.cand; "音声" = $r.file; "音声秒" = $r.audioSec; "処理秒" = $r.wallSec; "RTF" = $r.rtf
        "候補CPU平均%" = $r.cpuAvgPct; "候補CPU最大%" = $r.cpuPeakPct; "使ったコア数" = $r.coresAvg
        "PC全体CPU平均%" = $r.sysCpuAvgPct; "PC全体CPU最大%" = $r.sysCpuPeakPct; "最大メモリMB" = $r.peakMemMB
        "時計の遅れp95ms静か" = $r.lagP95IdleMs; "時計の遅れp95ms測り中" = $r.lagP95LoadMs; "時計の遅れ最大ms測り中" = $r.lagMaxLoadMs
        "仕事の時間の倍率" = $r.workX; "CER%" = $r.cer; "A0とのずれ%" = $r.vsA0; "長さの比" = $r.lenRatio; "句点の数" = $r.hypPeriods
        "GPU" = $r.gpu; "GPU平均%" = $r.gpuAvgPct; "GPU最大%" = $r.gpuPeakPct
        "スレッド" = $r.threads; "優先度" = $r.prio; "終了コード" = $r.exit; "電源" = $r.power
    }
}
$csv = Join-Path $Dirs.results "summary.csv"
$rows | Export-Csv -Path $csv -NoTypeInformation -Encoding UTF8

$cpuName = ""
try { $cpuName = (Get-CimInstance -ClassName Win32_Processor | Select-Object -First 1).Name.Trim() } catch { }
$ramGB = ""
try { $ramGB = [math]::Round((Get-CimInstance -ClassName Win32_ComputerSystem).TotalPhysicalMemory / 1GB) } catch { }
$osBuild = ""
try { $osBuild = (Get-CimInstance -ClassName Win32_OperatingSystem).Version } catch { }
# GPU の名前とドライバの版（会社の IT が入れたもの。ドライバが変わると GPU の数も変わりうるので、表に残す）
$gpuInfo = ""
try {
    $vc = Get-CimInstance -ClassName Win32_VideoController | Where-Object { $_.Name -match 'Intel' } | Select-Object -First 1
    if ($vc) {
        $gpuInfo = $vc.Name + "・ドライバ " + $vc.DriverVersion
        try { $gpuInfo += "（" + ([datetime]$vc.DriverDate).ToString("yyyy-MM-dd") + "）" } catch { }
    }
} catch { }

$md = @()
$md += "# 文字起こしの候補の比べ（数だけ）"
$md += ""
$md += ("- PC: " + $cpuName + "・論理コア " + $Logical + "・メモリ " + $ramGB + " GB・Windows " + $osBuild)
$md += ("- GPU: " + $gpuInfo)
$md += ("- 音声: " + (($Labels | ForEach-Object { $_ + " " + (Get-Meta $_).sec + " 秒" }) -join "・") + "（頭から " + $MaxMinutes + " 分まで）")
$md += "- RTF = 処理の秒 ÷ 音声の秒（1 より小さければ録音に追いつく）。CPU% は PC 全体（論理コア全部）を 100 とした割合"
$md += "- 時計の遅れ = ふつうの優先度の小さな見張りが 25 ミリ秒ごとに起きるときの遅れ。仕事の時間の倍率 = 同じ計算の時間（測り中 ÷ 静か）"
$md += "- CER = 参照（同じ会議の NaTsu の文字起こし）と比べた文字誤り率。長さの比 = 候補 ÷ 参照。A0とのずれ = 今の形（A0）の文と比べた文字の違い（GPU が CPU と違う文を出していないかの目安）"
$md += "- GPU = その回で GPU を本当に使ったか（whisper.cpp の記録で見分けた）。「CPU に戻った」「GPU で落ちた」の回の数は GPU の数ではない"
$bad = @($runs | Where-Object { $_.cand -eq "D" -or $_.cand -eq "Dn" } | Where-Object { $_.gpu -ne "GPU" })
if ($bad.Count -gt 0) { $md += ("- **注意: D・Dn のうち " + $bad.Count + " 回は GPU を使えなかった**（" + (($bad | ForEach-Object { $_.cand + " " + $_.file + ": " + $_.gpu }) -join "・") + "）。その後の D・Dn は飛ばした") }
$md += ""
$md += "## 候補ごと（全部の音声を合わせて）"
$md += ""
$md += "| 候補 | 音声秒 | 処理秒 | RTF | CPU平均% | GPU平均% | GPU を使えた回 | 最大メモリMB | 時計の遅れp95ms（静か→測り中） | 仕事の時間の倍率 | CER% | A0とのずれ%（最大） |"
$md += "| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- | ---: | ---: | ---: |"
foreach ($k in $order) {
    $g = @($runs | Where-Object { $_.cand -eq $k })
    if ($g.Count -eq 0) { continue }
    $a = ($g | Measure-Object -Property audioSec -Sum).Sum
    $w = ($g | Measure-Object -Property wallSec -Sum).Sum
    $cpuW = 0.0; foreach ($r in $g) { $cpuW += $r.cpuAvgPct * $r.wallSec }
    $mem = ($g | Measure-Object -Property peakMemMB -Maximum).Maximum
    $li = ($g | Where-Object { $_.lagP95IdleMs -ne $null } | Measure-Object -Property lagP95IdleMs -Maximum).Maximum
    $ll = ($g | Where-Object { $_.lagP95LoadMs -ne $null } | Measure-Object -Property lagP95LoadMs -Maximum).Maximum
    $wx = ($g | Where-Object { $_.workX -ne $null } | Measure-Object -Property workX -Maximum).Maximum
    $cerTxt = ""
    $withRef = @($g | Where-Object { $_.cer -ne $null -and $_.refChars })
    if ($withRef.Count -gt 0) {
        $e = 0.0; $n = 0.0
        foreach ($r in $withRef) { $e += $r.cer * $r.refChars; $n += $r.refChars }
        $cerTxt = [string][math]::Round($e / $n, 1)
    }
    $gw = 0.0; $gn = 0.0
    foreach ($r in $g) { if ($r.gpuAvgPct -ne $null) { $gw += $r.gpuAvgPct * $r.wallSec; $gn += $r.wallSec } }
    $gpuTxt = ""; if ($gn -gt 0) { $gpuTxt = [string][math]::Round($gw / $gn, 1) }
    $okN = @($g | Where-Object { $_.gpu -eq "GPU" }).Count
    $useTxt = "—"; if ($k -eq "D" -or $k -eq "Dn") { $useTxt = [string]$okN + "/" + $g.Count }
    $vsMax = ($g | Where-Object { $_.vsA0 -ne $null } | Measure-Object -Property vsA0 -Maximum).Maximum
    $md += ("| " + $k + " | " + $a + " | " + [math]::Round($w) + " | " + [math]::Round($w / [math]::Max(1, $a), 2) + " | " + [math]::Round($cpuW / [math]::Max(1, $w), 1) + " | " + $gpuTxt + " | " + $useTxt + " | " + $mem + " | " + $li + " → " + $ll + " | " + $wx + " | " + $cerTxt + " | " + $vsMax + " |")
}
$md += ""
$md += "## 1回ずつ"
$md += ""
$md += "| 候補 | 音声 | 音声秒 | 処理秒 | RTF | 候補CPU 平均/最大% | 使ったコア数 | PC全体CPU 平均/最大% | GPU 平均/最大% | GPU | 最大メモリMB | 時計の遅れp95ms 静か/測り中（最大） | 仕事の倍率 | CER% | A0とのずれ% | 長さの比 | 句点 | スレッド・優先度 | 終了 | 電源 |"
$md += "| --- | --- | ---: | ---: | ---: | --- | ---: | --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- |"
foreach ($r in $runs) {
    $md += ("| " + $r.cand + " | " + $r.file + " | " + $r.audioSec + " | " + $r.wallSec + " | " + $r.rtf + " | " + $r.cpuAvgPct + "/" + $r.cpuPeakPct + " | " + $r.coresAvg + " | " + $r.sysCpuAvgPct + "/" + $r.sysCpuPeakPct + " | " + $r.gpuAvgPct + "/" + $r.gpuPeakPct + " | " + $r.gpu + " | " + $r.peakMemMB + " | " + $r.lagP95IdleMs + "/" + $r.lagP95LoadMs + "（" + $r.lagMaxLoadMs + "） | " + $r.workX + " | " + $r.cer + " | " + $r.vsA0 + " | " + $r.lenRatio + " | " + $r.hypPeriods + " | " + $r.threads + "・" + $r.prio + " | " + $r.exit + " | " + $r.power + " |")
}
$md += ""
$md += "## 候補の中身（版の固定）"
$md += ""
foreach ($c in $Cands) { $md += ("- " + $c.Key + ": " + $c.Name) }
$md += "- whisper.cpp b5454（v1.9.5）の whisper-cli。D・Dn は同じ v1.9.5 を Vulkan 付きで NaTsu の CI が作ったもの（" + $Pins.whisperVkZip.File + "）。sherpa-onnx v1.13.8 の sherpa-onnx-vad-with-offline-asr（Silero VAD・20 秒まで）"
$mdFile = Join-Path $Dirs.results "summary.md"
$md | Set-Content -Path $mdFile -Encoding UTF8

Write-Host ""
Write-Log "=== 表を作りました ==="
Write-Host ("1. 次のファイルの中身を、そのままチャットに貼って送ってください（数だけで、会議の文は入っていません）: " + $mdFile) -ForegroundColor Cyan
Write-Host "2. 参照を後から入れたときは、-CerOnly を付けて実行し直すと CER だけ作り直します。" -ForegroundColor Cyan
Write-Host "3. 終わったら -Clean を付けて実行し、音声と文字起こしを消してください（表は残ります）。" -ForegroundColor Cyan
try { Start-Process notepad.exe -ArgumentList ('"' + $mdFile + '"') } catch { }
[void](Read-Host "Enter キーを押すと閉じます")
