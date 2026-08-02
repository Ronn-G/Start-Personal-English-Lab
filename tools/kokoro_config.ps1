function Import-KokoroLocalConfig {
    param([Parameter(Mandatory = $true)][string] $ProjectRoot)

    $configPath = Join-Path $ProjectRoot ".env.local"
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
        return
    }

    $allowed = @(
        "KOKORO_TOOL_DIR",
        "KOKORO_PYTHON_PATH",
        "KOKORO_MODEL_PATH",
        "KOKORO_VOICES_PATH",
        "KOKORO_HOST",
        "KOKORO_PORT",
        "KOKORO_BASE_URL"
    )

    foreach ($line in Get-Content -LiteralPath $configPath) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith("#") -or -not $trimmed.Contains("=")) {
            continue
        }

        $parts = $trimmed.Split("=", 2)
        $name = $parts[0].Trim()
        if ($allowed -notcontains $name -or -not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) {
            continue
        }

        $value = $parts[1].Trim()
        if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        [Environment]::SetEnvironmentVariable($name, $value, "Process")
    }
}

function Resolve-KokoroConfig {
    param([Parameter(Mandatory = $true)][string] $ProjectRoot)

    Import-KokoroLocalConfig -ProjectRoot $ProjectRoot
    $toolDir = $env:KOKORO_TOOL_DIR
    $python = $env:KOKORO_PYTHON_PATH
    $model = $env:KOKORO_MODEL_PATH
    $voices = $env:KOKORO_VOICES_PATH
    $hostName = if ($env:KOKORO_HOST) { $env:KOKORO_HOST } else { "127.0.0.1" }
    $port = if ($env:KOKORO_PORT) { [int] $env:KOKORO_PORT } else { 5050 }
    if ($hostName -notin @("127.0.0.1", "localhost")) {
        throw "KOKORO_HOST must be 127.0.0.1 or localhost. LAN/public binding is unsupported."
    }
    if ($port -lt 1 -or $port -gt 65535) {
        throw "KOKORO_PORT must be between 1 and 65535."
    }
    $baseUrl = if ($env:KOKORO_BASE_URL) { $env:KOKORO_BASE_URL.TrimEnd("/") } else { "http://${hostName}:${port}" }
    try {
        $baseUri = [Uri] $baseUrl
    }
    catch {
        throw "KOKORO_BASE_URL is invalid."
    }
    if (
        $baseUri.Scheme -ne "http" -or
        $baseUri.Host -ne $hostName -or
        $baseUri.Port -ne $port -or
        $baseUri.AbsolutePath -ne "/" -or
        $baseUri.UserInfo -or
        $baseUri.Query -or
        $baseUri.Fragment
    ) {
        throw "KOKORO_BASE_URL must exactly match the configured loopback host and port."
    }

    if ($toolDir) {
        if (-not $python) { $python = Join-Path $toolDir ".venv\Scripts\python.exe" }
        if (-not $model) { $model = Join-Path $toolDir "models\kokoro-v1.0.onnx" }
        if (-not $voices) { $voices = Join-Path $toolDir "models\voices-v1.0.bin" }
    }

    [pscustomobject]@{
        Python = $python
        Model = $model
        Voices = $voices
        Host = $hostName
        Port = $port
        BaseUrl = $baseUrl
        Server = Join-Path $ProjectRoot "tools\kokoro_server.py"
    }
}

function Assert-KokoroConfig {
    param([Parameter(Mandatory = $true)] $Config)

    $required = @(
        @("Python executable", $Config.Python),
        @("Kokoro server", $Config.Server),
        @("Kokoro model", $Config.Model),
        @("Kokoro voices", $Config.Voices)
    )
    foreach ($item in $required) {
        if ([string]::IsNullOrWhiteSpace($item[1]) -or -not (Test-Path -LiteralPath $item[1] -PathType Leaf)) {
            throw "$($item[0]) was not found: $($item[1])"
        }
    }
}

function Test-KokoroHealth {
    param([Parameter(Mandatory = $true)][string] $BaseUrl)
    try {
        $health = Invoke-RestMethod -Uri "$BaseUrl/health" -TimeoutSec 2
        return $health.status -eq "ok" -and $health.modelLoaded -eq $true
    }
    catch {
        return $false
    }
}
