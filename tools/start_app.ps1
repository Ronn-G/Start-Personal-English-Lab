$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$LogRoot = Join-Path $ProjectRoot ".logs"
$LauncherLog = Join-Path $LogRoot "launcher.log"
$KokoroStdout = Join-Path $LogRoot "kokoro-app.stdout.log"
$KokoroStderr = Join-Path $LogRoot "kokoro-app.stderr.log"
$NextStdout = Join-Path $LogRoot "next-app.stdout.log"
$NextStderr = Join-Path $LogRoot "next-app.stderr.log"
$NodeAppUrl = "http://localhost:3000"

. (Join-Path $PSScriptRoot "kokoro_config.ps1")

function Test-Url {
    param([Parameter(Mandatory = $true)][string] $Url)
    try {
        Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2 | Out-Null
        return $true
    }
    catch {
        return $false
    }
}

function Wait-Until {
    param(
        [Parameter(Mandatory = $true)][scriptblock] $Condition,
        [Parameter(Mandatory = $true)][int] $TimeoutSeconds
    )
    for ($attempt = 0; $attempt -lt $TimeoutSeconds; $attempt++) {
        if (& $Condition) { return $true }
        Start-Sleep -Seconds 1
    }
    return $false
}

New-Item -ItemType Directory -Path $LogRoot -Force | Out-Null

try {
    "[$(Get-Date -Format s)] Starting Personal English Lab." | Set-Content -LiteralPath $LauncherLog
    $config = Resolve-KokoroConfig -ProjectRoot $ProjectRoot
    Assert-KokoroConfig -Config $config

    if (-not (Test-KokoroHealth -BaseUrl $config.BaseUrl)) {
        $arguments = @(
            "`"$($config.Server)`"",
            "--host", $config.Host,
            "--port", $config.Port,
            "--model", "`"$($config.Model)`"",
            "--voices", "`"$($config.Voices)`""
        )
        Start-Process `
            -FilePath $config.Python `
            -ArgumentList $arguments `
            -WorkingDirectory $ProjectRoot `
            -RedirectStandardOutput $KokoroStdout `
            -RedirectStandardError $KokoroStderr `
            -WindowStyle Hidden | Out-Null

        if (-not (Wait-Until -TimeoutSeconds 90 -Condition { Test-KokoroHealth -BaseUrl $config.BaseUrl })) {
            throw "Kokoro did not become ready. See $KokoroStderr"
        }
    }

    if (-not (Test-Url -Url $NodeAppUrl)) {
        Start-Process `
            -FilePath "npm.cmd" `
            -ArgumentList @("run", "dev") `
            -WorkingDirectory $ProjectRoot `
            -RedirectStandardOutput $NextStdout `
            -RedirectStandardError $NextStderr `
            -WindowStyle Hidden | Out-Null

        if (-not (Wait-Until -TimeoutSeconds 60 -Condition { Test-Url -Url $NodeAppUrl })) {
            throw "Next.js did not become ready. See $NextStderr"
        }
    }

    "[$(Get-Date -Format s)] App ready at $NodeAppUrl" | Add-Content -LiteralPath $LauncherLog
    Start-Process $NodeAppUrl
    exit 0
}
catch {
    $message = "[$(Get-Date -Format s)] $($_.Exception.Message)"
    $message | Add-Content -LiteralPath $LauncherLog
    Write-Error $message
    exit 1
}
