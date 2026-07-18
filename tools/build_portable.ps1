param(
    [string] $PythonSource = $env:PORTABLE_PYTHON_SOURCE,
    [string] $TtsSource = $env:KOKORO_TOOL_DIR,
    [string] $OutputRoot
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $OutputRoot = Join-Path (Split-Path -Parent $ProjectRoot) "Personal-English-Lab-Portable"
}
$OutputRoot = [System.IO.Path]::GetFullPath($OutputRoot)
$ZipPath = "$OutputRoot.zip"
$Standalone = Join-Path $ProjectRoot ".next\standalone"
$NodeSource = (Get-Command node.exe -ErrorAction Stop).Source

if ([string]::IsNullOrWhiteSpace($PythonSource)) {
    $relativePython = Join-Path $ProjectRoot "runtime\python"
    if (Test-Path -LiteralPath $relativePython -PathType Container) {
        $PythonSource = $relativePython
    }
}
if ([string]::IsNullOrWhiteSpace($TtsSource)) {
    $relativeTts = Join-Path $ProjectRoot "tts"
    if (Test-Path -LiteralPath $relativeTts -PathType Container) {
        $TtsSource = $relativeTts
    }
}

if ([string]::IsNullOrWhiteSpace($PythonSource)) {
    throw "Portable Python is not configured. Use -PythonSource or PORTABLE_PYTHON_SOURCE."
}
if ([string]::IsNullOrWhiteSpace($TtsSource)) {
    throw "Kokoro source is not configured. Use -TtsSource or KOKORO_TOOL_DIR."
}

$PythonExecutable = Join-Path $PythonSource "python.exe"
$KokoroSitePackages = Join-Path $TtsSource ".venv\Lib\site-packages"
$ModelSource = Join-Path $TtsSource "models\kokoro-v1.0.onnx"
$VoicesSource = Join-Path $TtsSource "models\voices-v1.0.bin"
$KokoroServerSource = Join-Path $ProjectRoot "tools\kokoro_server.py"

$requiredDirectories = @($PythonSource, $TtsSource, $KokoroSitePackages)
foreach ($path in $requiredDirectories) {
    if (-not (Test-Path -LiteralPath $path -PathType Container)) {
        throw "Required directory was not found: $path"
    }
}
$requiredFiles = @($PythonExecutable, $ModelSource, $VoicesSource, $KokoroServerSource)
foreach ($path in $requiredFiles) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Required file was not found: $path"
    }
}

$NodeMajorVersion = [int]((& $NodeSource -p "process.versions.node.split('.')[0]").Trim())
if ($NodeMajorVersion -lt 24) {
    throw "Portable SQLite storage requires Node.js 24 or newer. Found: $(& $NodeSource --version)"
}

Push-Location $ProjectRoot
try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "Next.js build failed." }
}
finally { Pop-Location }

if (-not (Test-Path -LiteralPath $Standalone -PathType Container)) {
    throw "Standalone build was not found: $Standalone"
}
if (Test-Path -LiteralPath $OutputRoot) {
    Remove-Item -LiteralPath $OutputRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $OutputRoot | Out-Null

$AppRoot = Join-Path $OutputRoot "app"
Copy-Item -LiteralPath $Standalone -Destination $AppRoot -Recurse
Copy-Item -LiteralPath (Join-Path $ProjectRoot ".next\static") -Destination (Join-Path $AppRoot ".next\static") -Recurse
Copy-Item -LiteralPath (Join-Path $ProjectRoot "public") -Destination (Join-Path $AppRoot "public") -Recurse

New-Item -ItemType Directory -Path (Join-Path $OutputRoot "runtime") | Out-Null
Copy-Item -LiteralPath $NodeSource -Destination (Join-Path $OutputRoot "runtime\node.exe")

$PortablePython = Join-Path $OutputRoot "tts\python"
New-Item -ItemType Directory -Path $PortablePython | Out-Null
& robocopy $PythonSource $PortablePython /E /XD __pycache__ /XF *.pyc | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Could not copy Python runtime from: $PythonSource" }

$SitePackages = Join-Path $PortablePython "Lib\site-packages"
& robocopy $KokoroSitePackages $SitePackages /E /XD __pycache__ /XF *.pyc | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Could not copy Kokoro dependencies from: $KokoroSitePackages" }

$PortableModels = Join-Path $OutputRoot "tts\models"
New-Item -ItemType Directory -Path $PortableModels | Out-Null
Copy-Item -LiteralPath $KokoroServerSource -Destination (Join-Path $OutputRoot "tts\kokoro_server.py")
Copy-Item -LiteralPath $ModelSource -Destination (Join-Path $PortableModels "kokoro-v1.0.onnx")
Copy-Item -LiteralPath $VoicesSource -Destination (Join-Path $PortableModels "voices-v1.0.bin")
Copy-Item -LiteralPath (Join-Path $ProjectRoot "tools\portable_start.ps1") -Destination (Join-Path $OutputRoot "portable_start.ps1")

@'
@echo off
set "ROOT=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%portable_start.ps1"
if errorlevel 1 pause
'@ | Set-Content -LiteralPath (Join-Path $OutputRoot "Start Personal English Lab.bat") -Encoding ascii

@'
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File " & Chr(34) & root & "\portable_start.ps1" & Chr(34)
shell.Run cmd, 0, False
'@ | Set-Content -LiteralPath (Join-Path $OutputRoot "Start Personal English Lab.vbs") -Encoding ascii

@'
PERSONAL ENGLISH LAB - PORTABLE

1. Giai nen toan bo file ZIP vao mot thu muc.
2. Nhan dup "Start Personal English Lab.vbs".
3. App se mo tai http://localhost:3000.

Goi nay da kem Node.js, Python, Kokoro TTS va model giong doc.
Khong can cai Node.js hay Python. Can Internet khi dung Gemini API.
Dat GEMINI_API_KEY trong moi truong cua may neu muon dung Gemini.
Du lieu SQLite duoc luu ngoai thu muc app trong Local AppData cua nguoi dung.
'@ | Set-Content -LiteralPath (Join-Path $OutputRoot "HUONG-DAN.txt") -Encoding utf8

if (Test-Path -LiteralPath $ZipPath) {
    Remove-Item -LiteralPath $ZipPath -Force
}
Compress-Archive -LiteralPath $OutputRoot -DestinationPath $ZipPath -CompressionLevel Optimal
Write-Host "Portable package: $ZipPath"
