$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$LogRoot = Join-Path $ProjectRoot ".logs"
$StdoutLog = Join-Path $LogRoot "kokoro-dev.stdout.log"
$StderrLog = Join-Path $LogRoot "kokoro-dev.stderr.log"
$OwnedKokoro = $null

. (Join-Path $PSScriptRoot "kokoro_config.ps1")
$config = Resolve-KokoroConfig -ProjectRoot $ProjectRoot
Assert-KokoroConfig -Config $config

try {
    if (Test-KokoroHealth -BaseUrl $config.BaseUrl) {
        Write-Host "Kokoro ready (existing server)."
    }
    else {
        $occupied = Get-NetTCPConnection -LocalPort $config.Port -State Listen -ErrorAction SilentlyContinue
        if ($occupied) {
            throw "Port $($config.Port) is occupied, but Kokoro health failed at $($config.BaseUrl)/health."
        }

        New-Item -ItemType Directory -Path $LogRoot -Force | Out-Null
        Write-Host "Starting Kokoro. Logs: $StdoutLog and $StderrLog"
        # Some hosts provide both Path and PATH. Windows PowerShell Start-Process rejects that
        # duplicate case-insensitive key, so normalize it in this launcher process.
        $processPath = $env:PATH
        Remove-Item Env:Path -ErrorAction SilentlyContinue
        $env:PATH = $processPath
        $arguments = @(
            "`"$($config.Server)`"",
            "--host", $config.Host,
            "--port", $config.Port,
            "--model", "`"$($config.Model)`"",
            "--voices", "`"$($config.Voices)`""
        )
        $OwnedKokoro = Start-Process `
            -FilePath $config.Python `
            -ArgumentList $arguments `
            -WorkingDirectory $ProjectRoot `
            -RedirectStandardOutput $StdoutLog `
            -RedirectStandardError $StderrLog `
            -WindowStyle Hidden `
            -PassThru

        $ready = $false
        for ($attempt = 0; $attempt -lt 90; $attempt++) {
            if ($OwnedKokoro.HasExited) {
                break
            }
            if (Test-KokoroHealth -BaseUrl $config.BaseUrl) {
                $ready = $true
                break
            }
            Start-Sleep -Seconds 1
        }
        if (-not $ready) {
            $details = if (Test-Path -LiteralPath $StderrLog) {
                (Get-Content -LiteralPath $StderrLog -Tail 20) -join [Environment]::NewLine
            } else {
                "No stderr log was created."
            }
            throw "Kokoro health did not become ready. See $StderrLog`n$details"
        }
        Write-Host "Kokoro ready."
    }

    $appHealth = "http://127.0.0.1:3000/api/storage/health"
    try {
        $existingApp = Invoke-RestMethod -Uri $appHealth -TimeoutSec 2
    }
    catch {
        $existingApp = $null
    }
    if ($existingApp.status -eq "ok") {
        throw "Personal English Lab is already running at http://127.0.0.1:3000."
    }
    $appPort = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
    if ($appPort) {
        throw "Port 3000 is occupied by another process. Personal English Lab was not started."
    }
    Write-Host "Starting Next.js at http://127.0.0.1:3000"
    Push-Location $ProjectRoot
    try {
        & npm.cmd run dev
    }
    finally {
        Pop-Location
    }
}
finally {
    if ($OwnedKokoro -and -not $OwnedKokoro.HasExited) {
        Write-Host "Stopping Kokoro process started by this launcher."
        Stop-Process -Id $OwnedKokoro.Id
    }
}
