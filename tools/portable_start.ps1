$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppRoot = Join-Path $Root "app"
$Node = Join-Path $Root "runtime\node.exe"
$Python = Join-Path $Root "tts\python\python.exe"
$KokoroServer = Join-Path $Root "tts\kokoro_server.py"
$Model = Join-Path $Root "tts\models\kokoro-v1.0.onnx"
$Voices = Join-Path $Root "tts\models\voices-v1.0.bin"
$AppUrl = "http://127.0.0.1:3000"
$HealthUrl = "http://127.0.0.1:5050/health"

$DataBase = $env:LOCALAPPDATA
if ([string]::IsNullOrWhiteSpace($DataBase)) {
    $DataBase = $env:APPDATA
}
if ([string]::IsNullOrWhiteSpace($DataBase)) {
    $DataBase = Join-Path $env:USERPROFILE "AppData\Local"
}
$env:PERSONAL_ENGLISH_LAB_DATA_DIR = Join-Path $DataBase "PersonalEnglishLab"

function Test-Url([string] $Url) {
    try {
        Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2 | Out-Null
        return $true
    }
    catch { return $false }
}

foreach ($requiredFile in @($Node, $Python, $KokoroServer, $Model, $Voices)) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw "Portable required file was not found: $requiredFile"
    }
}

if (-not (Test-Url $HealthUrl)) {
    $occupied = Get-NetTCPConnection -LocalPort 5050 -State Listen -ErrorAction SilentlyContinue
    if ($occupied) {
        throw "Port 5050 is occupied, but Kokoro health failed at $HealthUrl."
    }
    Start-Process -FilePath $Python `
        -ArgumentList @("`"$KokoroServer`"", "--model", "`"$Model`"", "--voices", "`"$Voices`"") `
        -WorkingDirectory (Join-Path $Root "tts") `
        -WindowStyle Hidden
}

if (-not (Test-Url $AppUrl)) {
    $occupied = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
    if ($occupied) {
        throw "Port 3000 is occupied by another process. Personal English Lab was not started."
    }
    $env:HOSTNAME = "127.0.0.1"
    $env:PORT = "3000"
    Start-Process -FilePath $Node `
        -ArgumentList @("server.js") `
        -WorkingDirectory $AppRoot `
        -WindowStyle Hidden
}

for ($i = 0; $i -lt 30; $i++) {
    if (Test-Url $AppUrl) {
        Start-Process $AppUrl
        exit 0
    }
    Start-Sleep -Seconds 1
}

throw "App khong khoi dong duoc. Hay chay Start Personal English Lab.bat de xem loi."
