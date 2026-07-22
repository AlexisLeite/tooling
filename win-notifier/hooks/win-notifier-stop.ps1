$ErrorActionPreference = 'Stop'
$logFolder = Join-Path $env:LOCALAPPDATA 'WinNotifier'
$logPath = Join-Path $logFolder 'codex-hook.log'

function Write-HookLog([string]$message) {
    try {
        if (-not (Test-Path -LiteralPath $logFolder)) { New-Item -ItemType Directory -Path $logFolder -Force | Out-Null }
        Add-Content -LiteralPath $logPath -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff') + ' ' + $message) -Encoding UTF8
    }
    catch { }
}

try {
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $inputReader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8, $false)
    $inputText = $inputReader.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($inputText)) { throw 'Missing hook input.' }
    $hookInput = $inputText | ConvertFrom-Json
    $assistantText = [string]$hookInput.last_assistant_message
    $cwd = [string]$hookInput.cwd
    if ([string]::IsNullOrWhiteSpace($assistantText)) { throw 'No assistant message to notify.' }

    $port = 8765
    $settingsPath = Join-Path $env:APPDATA 'WinNotifier\settings.json'
    if (Test-Path -LiteralPath $settingsPath) {
        $settings = Get-Content -Raw -LiteralPath $settingsPath | ConvertFrom-Json
        if ($settings.Port -ge 1 -and $settings.Port -le 65535) { $port = [int]$settings.Port }
    }

    $payload = @{ title = 'Tarea completada'; body = $assistantText; cwd = $cwd } | ConvertTo-Json -Compress
    $payloadBytes = [Text.Encoding]::UTF8.GetBytes($payload)
    $response = Invoke-RestMethod -Method Post -Uri ("http://localhost:{0}/" -f $port) -ContentType 'application/json; charset=utf-8' -Body $payloadBytes -TimeoutSec 2
    Write-HookLog ("event=Stop port={0} ok={1} shown={2}" -f $port, $response.ok, $response.shown)
}
catch {
    Write-HookLog ("event=Stop error={0}" -f $_.Exception.Message)
}

'{"continue":true}'
