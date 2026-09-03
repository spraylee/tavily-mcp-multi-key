[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $ServerArguments
)

$ErrorActionPreference = "Stop"

$Repository = if ($env:TAVILY_MCP_REPOSITORY) { $env:TAVILY_MCP_REPOSITORY } else { "spraylee/tavily-mcp-multi-key" }
$Version = if ($env:TAVILY_MCP_VERSION) { $env:TAVILY_MCP_VERSION } else { "v0.4.0" }
$ReleaseBaseUrl = if ($env:TAVILY_MCP_RELEASE_BASE_URL) {
    $env:TAVILY_MCP_RELEASE_BASE_URL.TrimEnd('/')
} else {
    "https://github.com/$Repository/releases/download/$Version"
}
$CacheRoot = if ($env:TAVILY_MCP_CACHE_DIR) {
    $env:TAVILY_MCP_CACHE_DIR
} elseif ($env:LOCALAPPDATA) {
    Join-Path $env:LOCALAPPDATA "spraylee\tavily-mcp-multi-key"
} else {
    Join-Path $HOME "AppData\Local\spraylee\tavily-mcp-multi-key"
}

if ($Version -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?$') {
    throw "Invalid TAVILY_MCP_VERSION: $Version"
}

$architecture = if ($env:PROCESSOR_ARCHITECTURE) {
    $env:PROCESSOR_ARCHITECTURE.ToUpperInvariant()
} else {
    "AMD64"
}
$Target = switch ($architecture) {
    "AMD64" { "x86_64-pc-windows-msvc"; break }
    default { throw "Unsupported Windows architecture: $architecture (only x64 is currently released)" }
}

$Asset = "tavily-mcp-multi-key-$Version-$Target.tar.gz"
$CacheDir = Join-Path $CacheRoot "$Version\$Target"
$Binary = Join-Path $CacheDir "tavily-mcp-multi-key.exe"
$ChecksumFile = Join-Path $CacheDir "tavily-mcp-multi-key.sha256"
$LockDir = Join-Path $CacheDir ".download.lock"
$ForceDownload = $env:TAVILY_MCP_FORCE_DOWNLOAD -eq "1"
$Offline = $env:TAVILY_MCP_OFFLINE -eq "1"
$lockHeld = $false
$tempDir = $null

function Download-File([string] $Url, [string] $Output) {
    # Use curl.exe explicitly: PowerShell aliases `curl` to Invoke-WebRequest.
    & curl.exe --fail --location --proto "=https" --tlsv1.2 --retry 3 --retry-delay 1 --output $Output $Url
    if ($LASTEXITCODE -ne 0) { throw "Download failed: $Url" }
}

function Test-Cache {
    if (-not (Test-Path -LiteralPath $Binary -PathType Leaf)) { return $false }
    # A manually provisioned binary remains usable. Downloads made by this
    # script carry a sidecar digest and are re-verified on every launch.
    if (-not (Test-Path -LiteralPath $ChecksumFile -PathType Leaf)) { return $true }
    $checksumLine = Get-Content -LiteralPath $ChecksumFile | Select-Object -First 1
    if (-not $checksumLine) { return $false }
    $expected = ($checksumLine -split '\s+')[0].ToLowerInvariant()
    if ($expected -notmatch '^[0-9a-f]{64}$') { return $false }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Binary).Hash.ToLowerInvariant()
    return $actual -eq $expected
}

try {
    if ($ForceDownload -or -not (Test-Cache)) {
        if ($Offline) { throw "Native binary is not cached and TAVILY_MCP_OFFLINE=1" }
        New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null

        for ($attempt = 0; $attempt -lt 300; $attempt++) {
            try {
                New-Item -ItemType Directory -Path $LockDir -ErrorAction Stop | Out-Null
                $lockHeld = $true
                break
            } catch [System.IO.IOException] {
                Start-Sleep -Milliseconds 100
            }
        }
        if (-not $lockHeld) { throw "Timed out waiting for download lock: $LockDir" }

        if ($ForceDownload -or -not (Test-Cache)) {
            $tempDir = Join-Path $CacheDir ".download.$PID"
            New-Item -ItemType Directory -Path $tempDir | Out-Null
            $archive = Join-Path $tempDir $Asset
            $checksums = Join-Path $tempDir "SHA256SUMS"
            $extracted = Join-Path $tempDir "extracted"

            [Console]::Error.WriteLine("[tavily-mcp-multi-key] downloading $Version ($Target)")
            Download-File "$ReleaseBaseUrl/$Asset" $archive
            Download-File "$ReleaseBaseUrl/SHA256SUMS" $checksums

            $checksumLine = Get-Content -LiteralPath $checksums |
                Where-Object { $_ -match ("\s\*?" + [regex]::Escape($Asset) + "$") } |
                Select-Object -First 1
            if (-not $checksumLine) { throw "SHA256SUMS has no entry for $Asset" }
            $expected = ($checksumLine -split '\s+')[0].ToLowerInvariant()
            if ($expected -notmatch '^[0-9a-f]{64}$') { throw "Invalid checksum for $Asset" }
            $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
            if ($actual -ne $expected) { throw "Checksum mismatch for $Asset" }

            New-Item -ItemType Directory -Path $extracted | Out-Null
            & tar.exe -xzf $archive -C $extracted
            if ($LASTEXITCODE -ne 0) { throw "Could not extract $Asset" }
            $candidate = Join-Path $extracted "tavily-mcp-multi-key.exe"
            if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
                throw "Release archive does not contain tavily-mcp-multi-key.exe"
            }

            $binaryDigest = (Get-FileHash -Algorithm SHA256 -LiteralPath $candidate).Hash.ToLowerInvariant()
            $newBinary = "$Binary.new"
            Copy-Item -LiteralPath $candidate -Destination $newBinary -Force
            Set-Content -LiteralPath "$ChecksumFile.new" -NoNewline -Value "$binaryDigest  tavily-mcp-multi-key.exe"
            Move-Item -LiteralPath $newBinary -Destination $Binary -Force
            Move-Item -LiteralPath "$ChecksumFile.new" -Destination $ChecksumFile -Force
        }
    }

    if (-not (Test-Path -LiteralPath $Binary -PathType Leaf)) {
        throw "Native binary is not executable: $Binary"
    }
} finally {
    if ($tempDir) { Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue }
    if ($lockHeld) { Remove-Item -LiteralPath $LockDir -Recurse -Force -ErrorAction SilentlyContinue }
}

# PowerShell has no POSIX exec; the native process still receives the same
# environment and stdio. POSIX users should use bootstrap.sh for true exec.
& $Binary @ServerArguments
exit $LASTEXITCODE
