param(
    [switch]$SkipUpdate,
    [switch]$NoPrompt,
    [switch]$SkipDependencies
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path $PSScriptRoot).Path
$Web = Join-Path $Root "web"

if (-not $SkipUpdate) {
    Write-Host "Checking for Canvas updates..."
    try {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "scripts\Update-Canvas.ps1") -NoPrompt:$NoPrompt -SkipDependencies
        if ($LASTEXITCODE -ne 0) { Write-Warning "Automatic update did not complete; starting the current version." }
    } catch {
        Write-Warning "Automatic update failed; starting the current version: $($_.Exception.Message)"
    }
}

if (-not $SkipDependencies) {
    Write-Host "Checking dependencies and build output..."
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "scripts\Prepare-Canvas.ps1") -Build
    if ($LASTEXITCODE -ne 0) { throw "Canvas dependency check or build failed." }
} elseif (-not (Test-Path -LiteralPath (Join-Path $Web "dist\index.html"))) {
    throw "web/dist is missing. Start again without -SkipDependencies so it can be built automatically."
}

function Stop-CanvasPreview {
    $connections = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
    foreach ($connection in ($connections | Sort-Object OwningProcess -Unique)) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($connection.OwningProcess)" -ErrorAction SilentlyContinue
        if ($process -and $process.CommandLine -and $process.CommandLine.Contains($Web) -and $process.CommandLine -match "vite|npm run start") {
            Stop-Process -Id $connection.OwningProcess -Force -ErrorAction SilentlyContinue
        } else {
            Write-Warning "Port 3000 is already used by another process; it was not stopped."
        }
    }
    Start-Sleep -Milliseconds 500
}

Stop-CanvasPreview
$command = "Set-Location -LiteralPath '$Web'; npm run start"
Start-Process powershell.exe -ArgumentList @("-NoProfile", "-NoExit", "-Command", $command) | Out-Null
Start-Sleep -Seconds 2
Start-Process "http://127.0.0.1:3000" | Out-Null
