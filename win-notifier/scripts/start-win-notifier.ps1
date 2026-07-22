$ErrorActionPreference = 'Stop'

$executable = Join-Path $env:UPM_PACKAGE_DIR 'bin\WinNotifier.exe'
if (-not (Test-Path -LiteralPath $executable)) {
    throw "WinNotifier executable was not found: $executable"
}

Get-Process -Name 'WinNotifier' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Process -FilePath $executable -WindowStyle Hidden
