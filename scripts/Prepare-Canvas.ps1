param(
    [switch]$Build,
    [switch]$ForceBuild
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $Npm) { $Npm = Get-Command npm -ErrorAction SilentlyContinue }
if (-not $Npm) { throw "npm was not found. Install Node.js 20.19 or later first." }

function Invoke-Npm([string]$Directory, [string[]]$Arguments) {
    Push-Location $Directory
    try {
        & $Npm.Source @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "npm $($Arguments -join ' ') failed in $Directory (exit code $LASTEXITCODE)."
        }
    } finally {
        Pop-Location
    }
}

function Get-DependencyFingerprint([string]$Directory) {
    $lockPath = Join-Path $Directory "package-lock.json"
    $manifestPath = Join-Path $Directory "package.json"
    $sourcePath = if (Test-Path -LiteralPath $lockPath) { $lockPath } else { $manifestPath }
    return (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash
}

function Test-DirectDependencies([string]$Directory) {
    $manifest = Get-Content -LiteralPath (Join-Path $Directory "package.json") -Raw | ConvertFrom-Json
    $names = @(
        @($manifest.dependencies.PSObject.Properties.Name) +
        @($manifest.devDependencies.PSObject.Properties.Name)
    ) | Where-Object { $_ } | Sort-Object -Unique
    foreach ($name in $names) {
        if (-not (Test-Path -LiteralPath (Join-Path (Join-Path $Directory "node_modules") $name))) {
            return $false
        }
    }
    return $true
}

function Repair-WindowsNativeBinaries([string]$Directory) {
    if ($env:OS -ne "Windows_NT") { return }
    $architecture = switch ($env:PROCESSOR_ARCHITECTURE) {
        "ARM64" { "arm64" }
        "x86" { "ia32" }
        default { "x64" }
    }
    $nativePackages = @(
        @{ Manifest = "rollup\package.json"; Name = "@rollup/rollup-win32-$architecture-msvc" },
        @{ Manifest = "lightningcss\package.json"; Name = "lightningcss-win32-$architecture-msvc" },
        @{ Manifest = "@tailwindcss\oxide\package.json"; Name = "@tailwindcss/oxide-win32-$architecture-msvc" }
    )

    foreach ($nativePackage in $nativePackages) {
        $manifestPath = Join-Path (Join-Path $Directory "node_modules") $nativePackage.Manifest
        $packagePath = Join-Path (Join-Path $Directory "node_modules") $nativePackage.Name
        if (-not (Test-Path -LiteralPath $manifestPath) -or (Test-Path -LiteralPath $packagePath)) { continue }

        $version = (Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json).version
        Write-Host "Repairing missing Windows dependency $($nativePackage.Name)..."
        Invoke-Npm $Directory @(
            "install", "--no-save", "--package-lock=false", "--legacy-peer-deps",
            "--no-audit", "--no-fund", "$($nativePackage.Name)@$version"
        )
    }
}

function Ensure-Project([string]$RelativePath, [string]$Name, [string]$BuildOutput) {
    $directory = Join-Path $Root $RelativePath
    if (-not (Test-Path -LiteralPath (Join-Path $directory "package.json"))) { return }

    $modules = Join-Path $directory "node_modules"
    $stamp = Join-Path $modules ".canvas-dependencies.sha256"
    $fingerprint = Get-DependencyFingerprint $directory
    $installedFingerprint = if (Test-Path -LiteralPath $stamp) {
        (Get-Content -LiteralPath $stamp -Raw).Trim()
    } else {
        ""
    }
    $needsInstall = -not (Test-Path -LiteralPath $modules) -or
        $installedFingerprint -ne $fingerprint -or
        -not (Test-DirectDependencies $directory)

    if ($needsInstall) {
        Write-Host "Installing or repairing $Name dependencies..."
        Invoke-Npm $directory @("install", "--legacy-peer-deps", "--no-audit", "--no-fund")
        $fingerprint = Get-DependencyFingerprint $directory
        Set-Content -LiteralPath $stamp -Value $fingerprint -Encoding ASCII
        Write-Host "$Name dependencies are ready."
    } elseif (-not (Test-Path -LiteralPath $stamp)) {
        Set-Content -LiteralPath $stamp -Value $fingerprint -Encoding ASCII
    }

    Repair-WindowsNativeBinaries $directory

    if ($Build) {
        $output = Join-Path $directory $BuildOutput
        if ($ForceBuild -or $needsInstall -or -not (Test-Path -LiteralPath $output)) {
            Write-Host "Building $Name..."
            Invoke-Npm $directory @("run", "build")
            Write-Host "$Name build is ready."
        }
    }
}

Ensure-Project "web" "web app" "dist\index.html"
Ensure-Project "canvas-agent" "Canvas Agent" "dist\index.js"
