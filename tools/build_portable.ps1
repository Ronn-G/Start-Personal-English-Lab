$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$OutputRoot = Join-Path (Split-Path -Parent $ProjectRoot) "Personal-English-Lab-Portable"
$ZipPath = "$OutputRoot.zip"
$Standalone = Join-Path $ProjectRoot ".next\standalone"
$PythonSource = "C:\Users\long\.cache\codex-runtimes\codex-primary-runtime\dependencies\python"
$TtsSource = "L:\tts_tool"
$NodeSource = (Get-Command node.exe -ErrorAction Stop).Source

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
if ($LASTEXITCODE -ge 8) { throw "Could not copy Python runtime." }

$SitePackages = Join-Path $PortablePython "Lib\site-packages"
& robocopy (Join-Path $TtsSource ".venv\Lib\site-packages") $SitePackages /E /XD __pycache__ /XF *.pyc | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Could not copy Kokoro dependencies." }

Copy-Item -LiteralPath (Join-Path $ProjectRoot "tools\kokoro_server.py") -Destination (Join-Path $OutputRoot "tts\kokoro_server.py")
Copy-Item -LiteralPath (Join-Path $TtsSource "models") -Destination (Join-Path $OutputRoot "tts\models") -Recurse
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
