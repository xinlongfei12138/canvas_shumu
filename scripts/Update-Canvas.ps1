param(
    [switch]$CheckOnly,
    [switch]$NoPrompt,
    [switch]$SkipDependencies
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ConfigPath = Join-Path $Root ".update-config.json"
$DefaultConfigPath = Join-Path $Root "update.config.example.json"

function Read-UpdateConfig {
    $path = if (Test-Path -LiteralPath $ConfigPath) { $ConfigPath } else { $DefaultConfigPath }
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    try { return Get-Content -LiteralPath $path -Raw | ConvertFrom-Json }
    catch { throw "Cannot read .update-config.json. Check its JSON format." }
}

function Get-VersionParts([string]$Version) {
    $match = [regex]::Match($Version.Trim(), '^v?(\d+)\.(\d+)\.(\d+)')
    if (-not $match.Success) { return $null }
    return @([int]$match.Groups[1].Value, [int]$match.Groups[2].Value, [int]$match.Groups[3].Value)
}

function Test-NewerVersion([string]$Latest, [string]$Current) {
    $latestParts = Get-VersionParts $Latest
    $currentParts = Get-VersionParts $Current
    if (-not $latestParts -or -not $currentParts) { return $false }
    for ($index = 0; $index -lt 3; $index++) {
        if ($latestParts[$index] -gt $currentParts[$index]) { return $true }
        if ($latestParts[$index] -lt $currentParts[$index]) { return $false }
    }
    return $false
}

function ConvertTo-UpdatePathKey([string]$Path) {
    $separator = [IO.Path]::DirectorySeparatorChar
    return $Path.Replace([IO.Path]::AltDirectorySeparatorChar, $separator).Trim([char[]]@($separator)).ToLowerInvariant()
}

function Test-PreservedUpdatePath([string]$RelativePath, [hashtable]$PreserveKeys) {
    $relativeKey = ConvertTo-UpdatePathKey $RelativePath
    $separator = [string][IO.Path]::DirectorySeparatorChar
    foreach ($preserveKey in $PreserveKeys.Keys) {
        if ($relativeKey -eq $preserveKey -or $relativeKey.StartsWith($preserveKey + $separator, [StringComparison]::Ordinal)) { return $true }
    }
    return $false
}

$config = Read-UpdateConfig
if (-not $config -or -not $config.repository -or ([string]$config.repository) -like "YOUR_GITHUB_*") {
    Write-Host "No GitHub update repository is configured; skipping remote update."
    exit 0
}

$repository = ([string]$config.repository).Trim().Trim('/') -replace '^https?://github\.com/', '' -replace '\.git$', ''
if ($repository -notmatch '^[^/\s]+/[^/\s]+$') { throw "Invalid repository format. Use owner/repository." }

$api = ([string]$config.releaseApi).TrimEnd('/')
if (-not $api) { $api = "https://api.github.com" }
$headers = @{ "User-Agent" = "infinite-canvas-local-updater"; "Accept" = "application/vnd.github+json" }
$branch = ([string]$config.branch).Trim()
if (-not $branch) { $branch = "main" }
$candidates = @()
$errors = @()

try {
    $release = Invoke-RestMethod -Uri "$api/repos/$repository/releases/latest" -Headers $headers
    if (Get-VersionParts ([string]$release.tag_name)) {
        $candidates += [PSCustomObject]@{ Version = [string]$release.tag_name; Ref = [string]$release.tag_name; Kind = "release" }
    }
} catch {
    $errors += "Release: $($_.Exception.Message)"
}

try {
    $encodedBranch = [Uri]::EscapeDataString($branch)
    $versionFile = Invoke-RestMethod -Uri "$api/repos/$repository/contents/VERSION`?ref=$encodedBranch" -Headers $headers
    $content = ([string]$versionFile.content) -replace '\s', ''
    $branchVersion = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($content)).Trim()
    if (Get-VersionParts $branchVersion) {
        $candidates += [PSCustomObject]@{ Version = $branchVersion; Ref = $branch; Kind = "branch" }
    }
} catch {
    $errors += "Branch ${branch}: $($_.Exception.Message)"
}

if ($candidates.Count -eq 0) {
    throw "Cannot read a valid remote version. $($errors -join ' | ')"
}

$remote = $candidates[0]
foreach ($candidate in $candidates) {
    if (Test-NewerVersion $candidate.Version $remote.Version) { $remote = $candidate }
}

$latest = [string]$remote.Version
$current = (Get-Content -LiteralPath (Join-Path $Root "VERSION") -Raw).Trim()
if (-not (Test-NewerVersion $latest $current)) {
    Write-Host "Current version $current is up to date (remote $latest from $($remote.Kind))."
    if ($CheckOnly) { exit 0 }
} else {
    Write-Host "New version available: $current -> $latest ($($remote.Kind): $($remote.Ref))"
    if ($CheckOnly) { exit 10 }
    $confirmed = $NoPrompt
    if (-not $NoPrompt) {
        $answer = Read-Host "Download and apply this update now? Enter Y to confirm"
        $confirmed = $answer -match '^(?i)y(es)?$'
    }

    if ($confirmed) {
        $temp = Join-Path ([IO.Path]::GetTempPath()) ("infinite-canvas-update-" + [guid]::NewGuid().ToString("N"))
        $zip = Join-Path $temp "source.zip"
        $extract = Join-Path $temp "extract"
        New-Item -ItemType Directory -Path $temp, $extract | Out-Null

        try {
            $encodedRef = [Uri]::EscapeDataString([string]$remote.Ref)
            Invoke-WebRequest -Uri "$api/repos/$repository/zipball/$encodedRef" -Headers $headers -OutFile $zip
            Expand-Archive -LiteralPath $zip -DestinationPath $extract -Force
            $source = Get-ChildItem -LiteralPath $extract -Directory | Select-Object -First 1
            if (-not $source) { throw "The GitHub source archive is empty." }

            $preserve = @("web/node_modules", "canvas-agent/node_modules", "canvas-proxy/node_modules", "data", ".update-config.json")
            if ($config.preserve) { $preserve = @($config.preserve) }
            foreach ($buildPath in @("web/dist", "canvas-agent/dist", "canvas-proxy/dist")) {
                $buildDirectory = Join-Path $Root $buildPath
                if (Test-Path -LiteralPath $buildDirectory) { Remove-Item -LiteralPath $buildDirectory -Recurse -Force }
            }
            $preserveKeys = @{}
            foreach ($item in $preserve) {
                $key = ConvertTo-UpdatePathKey ([string]$item)
                if ($key) { $preserveKeys[$key] = $true }
            }

            Get-ChildItem -LiteralPath $source.FullName -Recurse -File | ForEach-Object {
                $relative = $_.FullName.Substring($source.FullName.Length).TrimStart([char[]]@([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar))
                if (-not (Test-PreservedUpdatePath $relative $preserveKeys)) {
                    $target = Join-Path $Root $relative
                    New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
                    Copy-Item -LiteralPath $_.FullName -Destination $target -Force
                }
            }
            Write-Host "Source updated to $latest."
            $updateApplied = $true
        } finally {
            if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue }
        }
    }
}

if (-not $SkipDependencies) {
    Write-Host "Checking dependencies and build output..."
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "scripts\Prepare-Canvas.ps1") -Build -ForceBuild:$updateApplied
    if ($LASTEXITCODE -ne 0) { throw "Canvas dependency check or build failed." }
}
