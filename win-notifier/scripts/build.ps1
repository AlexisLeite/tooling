$ErrorActionPreference = 'Stop'
$compiler = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$packageRoot = Split-Path -Parent $PSScriptRoot
$sourceRoot = Join-Path $packageRoot 'src'
$output = Join-Path $packageRoot 'bin\WinNotifier.exe'
$manifest = Join-Path $sourceRoot 'app.manifest'
$source = Join-Path $sourceRoot 'Program.cs'
& $compiler /nologo /codepage:65001 /target:winexe /optimize+ ('/win32manifest:' + $manifest) ('/out:' + $output) /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll $source
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "Compilado: $output"
