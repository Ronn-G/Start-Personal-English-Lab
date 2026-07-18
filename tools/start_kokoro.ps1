param(
    [string] $PythonPath = $env:KOKORO_PYTHON_PATH,
    [string] $TtsSource = $env:KOKORO_TOOL_DIR,
    [string] $ModelPath = $env:KOKORO_MODEL_PATH,
    [string] $VoicesPath = $env:KOKORO_VOICES_PATH
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ServerScript = Join-Path $ProjectRoot "tools\kokoro_server.py"

if ([string]::IsNullOrWhiteSpace($PythonPath) -and -not [string]::IsNullOrWhiteSpace($TtsSource)) {
    $PythonPath = Join-Path $TtsSource ".venv\Scripts\python.exe"
}
if ([string]::IsNullOrWhiteSpace($ModelPath) -and -not [string]::IsNullOrWhiteSpace($TtsSource)) {
    $ModelPath = Join-Path $TtsSource "models\kokoro-v1.0.onnx"
}
if ([string]::IsNullOrWhiteSpace($VoicesPath) -and -not [string]::IsNullOrWhiteSpace($TtsSource)) {
    $VoicesPath = Join-Path $TtsSource "models\voices-v1.0.bin"
}

if ([string]::IsNullOrWhiteSpace($PythonPath)) {
    throw "Kokoro Python is not configured. Set KOKORO_PYTHON_PATH or KOKORO_TOOL_DIR."
}
if (-not (Test-Path -LiteralPath $PythonPath -PathType Leaf)) {
    throw "Kokoro Python was not found: $PythonPath"
}
if (-not (Test-Path -LiteralPath $ServerScript -PathType Leaf)) {
    throw "Kokoro server was not found: $ServerScript"
}
if ([string]::IsNullOrWhiteSpace($ModelPath) -or -not (Test-Path -LiteralPath $ModelPath -PathType Leaf)) {
    throw "Kokoro model was not found: $ModelPath"
}
if ([string]::IsNullOrWhiteSpace($VoicesPath) -or -not (Test-Path -LiteralPath $VoicesPath -PathType Leaf)) {
    throw "Kokoro voices file was not found: $VoicesPath"
}

& $PythonPath $ServerScript --model $ModelPath --voices $VoicesPath
if ($LASTEXITCODE -ne 0) {
    throw "Kokoro server stopped with exit code $LASTEXITCODE."
}
