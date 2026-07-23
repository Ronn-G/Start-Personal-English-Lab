param(
    [string] $PythonPath,
    [string] $TtsSource,
    [string] $ModelPath,
    [string] $VoicesPath
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "kokoro_config.ps1")

Import-KokoroLocalConfig -ProjectRoot $ProjectRoot
if ($PythonPath) { $env:KOKORO_PYTHON_PATH = $PythonPath }
if ($TtsSource) { $env:KOKORO_TOOL_DIR = $TtsSource }
if ($ModelPath) { $env:KOKORO_MODEL_PATH = $ModelPath }
if ($VoicesPath) { $env:KOKORO_VOICES_PATH = $VoicesPath }

$config = Resolve-KokoroConfig -ProjectRoot $ProjectRoot
Assert-KokoroConfig -Config $config

Write-Host "Starting Kokoro at $($config.BaseUrl). Model loading may take a moment."
& $config.Python $config.Server `
    --host $config.Host `
    --port $config.Port `
    --model $config.Model `
    --voices $config.Voices

if ($LASTEXITCODE -ne 0) {
    throw "Kokoro server stopped with exit code $LASTEXITCODE."
}
