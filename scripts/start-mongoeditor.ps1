param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$url = 'http://127.0.0.1:3000'
$runtimeDirectory = Join-Path $projectRoot '.mongoeditor'
$mutex = New-Object System.Threading.Mutex($false, 'Local\MongoEditor-Launcher-3000')
$ownsMutex = $false
$server = $null
$Host.UI.RawUI.WindowTitle = 'MongoEditor'

function Test-MongoEditor {
    try {
        $page = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3
        return $page.StatusCode -eq 200 -and $page.Content.Contains('Mongo Browser')
    } catch { return $false }
}

try {
    try { $ownsMutex = $mutex.WaitOne(60000) }
    catch [System.Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) { throw 'MongoEditor is still starting. Please try again shortly.' }

    if (-not (Test-MongoEditor)) {
        $client = New-Object System.Net.Sockets.TcpClient
        try {
            $occupied = $false
            try { $client.Connect('127.0.0.1', 3000); $occupied = $true } catch {}
            if ($occupied) { throw 'Port 3000 is already in use. Wait for the existing service to finish starting, or free this port and try again.' }
        } finally { $client.Dispose() }

        $node = (Get-Command node.exe -ErrorAction Stop).Source
        $next = Join-Path $projectRoot 'node_modules\next\dist\bin\next'
        if (-not (Test-Path -LiteralPath $next)) { throw "Run npm install in $projectRoot first." }
        New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
        # Match npm run dev so the shortcut uses current source and development configuration.
        Write-Host 'MongoEditor - close this terminal or press Ctrl+C to stop the server.' -ForegroundColor Green
        # Share this console so closing its window also closes the server and its children.
        $server = Start-Process -FilePath $node -ArgumentList @(('"{0}"' -f $next), 'dev', '--hostname', '127.0.0.1', '--port', '3000') -WorkingDirectory $projectRoot -NoNewWindow -PassThru
        $server.Id | Set-Content -LiteralPath (Join-Path $runtimeDirectory 'server.pid')
        $deadline = (Get-Date).AddSeconds(60)
        while (-not (Test-MongoEditor)) {
            if ($server.HasExited) { throw 'MongoEditor could not start. Check the server output above.' }
            if ((Get-Date) -ge $deadline) { throw 'MongoEditor did not become ready within 60 seconds. Check the server output above.' }
            Start-Sleep -Milliseconds 500
        }
    }
    if (-not $NoBrowser) { Start-Process $url }
    $mutex.ReleaseMutex()
    $ownsMutex = $false
    if ($server) { Wait-Process -Id $server.Id }
} catch {
    if ($NoBrowser) { throw }
    Write-Host $_.Exception.Message -ForegroundColor Red
    Read-Host 'Press Enter to close' | Out-Null
    exit 1
} finally {
    if ($server -and -not $server.HasExited) {
        & "$env:SystemRoot\System32\taskkill.exe" /PID $server.Id /T /F | Out-Null
    }
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
