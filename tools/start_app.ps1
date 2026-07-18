$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$KokoroPython = $env:KOKORO_PYTHON_PATH
$KokoroToolDir = $env:KOKORO_TOOL_DIR
$KokoroServer = Join-Path $ProjectRoot "tools\kokoro_server.py"
$KokoroModel = $env:KOKORO_MODEL_PATH
$KokoroVoices = $env:KOKORO_VOICES_PATH
$NodeAppUrl = "http://localhost:3000"
$KokoroHealthUrl = "http://127.0.0.1:5050/health"

function Test-Url {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Url
    )

    try {
        Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2 | Out-Null
        return $true
    }
    catch {
        return $false
    }
}

function Start-KokoroServer {
    if (Test-Url -Url $KokoroHealthUrl) {
        return
    }

    if ([string]::IsNullOrWhiteSpace($KokoroPython) -and -not [string]::IsNullOrWhiteSpace($KokoroToolDir)) {
        $script:KokoroPython = Join-Path $KokoroToolDir ".venv\Scripts\python.exe"
    }
    if ([string]::IsNullOrWhiteSpace($KokoroModel) -and -not [string]::IsNullOrWhiteSpace($KokoroToolDir)) {
        $script:KokoroModel = Join-Path $KokoroToolDir "models\kokoro-v1.0.onnx"
    }
    if ([string]::IsNullOrWhiteSpace($KokoroVoices) -and -not [string]::IsNullOrWhiteSpace($KokoroToolDir)) {
        $script:KokoroVoices = Join-Path $KokoroToolDir "models\voices-v1.0.bin"
    }

    if ([string]::IsNullOrWhiteSpace($KokoroPython)) {
        throw "Kokoro Python is not configured. Set KOKORO_PYTHON_PATH or KOKORO_TOOL_DIR."
    }
    if (-not (Test-Path -LiteralPath $KokoroPython)) {
        throw "Khong tim thay Python Kokoro: $KokoroPython"
    }

    if (-not (Test-Path -LiteralPath $KokoroServer)) {
        throw "Khong tim thay Kokoro server: $KokoroServer"
    }
    if ([string]::IsNullOrWhiteSpace($KokoroModel) -or -not (Test-Path -LiteralPath $KokoroModel)) {
        throw "Kokoro model was not found: $KokoroModel"
    }
    if ([string]::IsNullOrWhiteSpace($KokoroVoices) -or -not (Test-Path -LiteralPath $KokoroVoices)) {
        throw "Kokoro voices file was not found: $KokoroVoices"
    }

    Start-Process `
        -FilePath $KokoroPython `
        -ArgumentList @("`"$KokoroServer`"", "--model", "`"$KokoroModel`"", "--voices", "`"$KokoroVoices`"") `
        -WorkingDirectory $ProjectRoot `
        -WindowStyle Hidden
}

function Start-NextApp {
    if (Test-Url -Url $NodeAppUrl) {
        return
    }

    Start-Process `
        -FilePath "npm.cmd" `
        -ArgumentList @("run", "dev") `
        -WorkingDirectory $ProjectRoot `
        -WindowStyle Hidden
}

Start-KokoroServer
Start-Sleep -Seconds 2

Start-NextApp

for ($i = 0; $i -lt 20; $i++) {
    if (Test-Url -Url $NodeAppUrl) {
        Start-Process $NodeAppUrl
        exit 0
    }

    Start-Sleep -Seconds 1
}

Start-Process $NodeAppUrl
