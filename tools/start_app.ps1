$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$KokoroPython = "L:\tts_tool\.venv\Scripts\python.exe"
$KokoroServer = Join-Path $ProjectRoot "tools\kokoro_server.py"
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

    if (-not (Test-Path -LiteralPath $KokoroPython)) {
        throw "Khong tim thay Python Kokoro: $KokoroPython"
    }

    if (-not (Test-Path -LiteralPath $KokoroServer)) {
        throw "Khong tim thay Kokoro server: $KokoroServer"
    }

    Start-Process `
        -FilePath $KokoroPython `
        -ArgumentList @("`"$KokoroServer`"") `
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
