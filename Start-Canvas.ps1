param(
    [switch]$SkipUpdate,
    [switch]$NoPrompt,
    [switch]$SkipDependencies
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path $PSScriptRoot).Path
$Web = Join-Path $Root "web"

if (-not $SkipUpdate) {
    try {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "scripts\Update-Canvas.ps1") -NoPrompt:$NoPrompt -SkipDependencies:$SkipDependencies
        if ($LASTEXITCODE -ne 0) { Write-Warning "Automatic update did not complete; starting the current version." }
    } catch {
        Write-Warning "Automatic update failed; starting the current version: $($_.Exception.Message)"
    }
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "npm was not found. Install Node.js 20.19 or later first."
}

if (-not (Test-Path (Join-Path $Web "node_modules"))) {
    Push-Location $Web
    try {
        if (Test-Path (Join-Path $Web "package-lock.json")) { npm ci } else { npm install }
    } finally { Pop-Location }
}

if (-not (Test-Path (Join-Path $Web "dist"))) {
    Push-Location $Web
    try { npm run build } finally { Pop-Location }
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
