# PowerShell script for building psh using Docker cross-compiler
# Usage: .\build-docker.ps1 [-Clean]

param(
    [switch]$Clean
)

# Configuration
$ImageName = "docker.cnb.cool/smk.k/alpha/dev-env/alpha-dev-env"
$ContainerName = "psh-builder"
$SourceDir = $PSScriptRoot
# Cross-compiler path in container
$CrossCompilerPath = "/opt/gcc-arm-8.3-2019.03-x86_64-arm-linux-gnueabihf/bin"

Write-Host "=== psh Docker Build Script ===" -ForegroundColor Cyan
Write-Host "Source directory: $SourceDir" -ForegroundColor Gray

# Check if Docker is available
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Error "Docker is not installed or not in PATH"
    exit 1
}

# Build docker run arguments
$DockerArgs = @(
    "run",
    "--rm",
    "--name", $ContainerName,
    "-v", "${SourceDir}:/workspace",
    "-w", "/workspace",
    "-e", "PATH=${CrossCompilerPath}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    $ImageName
)

if ($Clean) {
    Write-Host "Cleaning build artifacts..." -ForegroundColor Yellow
    $DockerArgs += "make", "clean"
} else {
    Write-Host "Building psh..." -ForegroundColor Yellow
    $DockerArgs += "make", "psh"
}

Write-Host "Running: docker $($DockerArgs -join ' ')" -ForegroundColor Gray

# Execute docker command
& docker $DockerArgs

if ($LASTEXITCODE -eq 0) {
    Write-Host "`nBuild completed successfully!" -ForegroundColor Green
    
    # List generated files
    $artifacts = @("psh", "bg-demo")
    foreach ($file in $artifacts) {
        $filePath = Join-Path $SourceDir $file
        if (Test-Path $filePath) {
            $size = (Get-Item $filePath).Length
            Write-Host "  - $file ($size bytes)" -ForegroundColor Gray
        }
    }
} else {
    Write-Error "Build failed with exit code: $LASTEXITCODE"
    exit $LASTEXITCODE
}
