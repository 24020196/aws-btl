<#
.SYNOPSIS
    XRegion Playwright E2E Test Runner (One-Click).
#>

[CmdletBinding()]
param (
    [Parameter(Position = 0)]
    [string]$BaseUrl = "http://localhost:8080",

    [switch]$Headless,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ExtraArgs
)

$ErrorActionPreference = "Continue"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "       XRegion: Playwright E2E Test Runner (One-Click)    " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

$ScriptDir = $PSScriptRoot
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $ScriptDir)

try {
    # 1. Nap bien moi truong tu file .env neu co
    $envFile = Join-Path $ProjectRoot ".env"
    if (Test-Path $envFile) {
        Write-Host "[1/3] Dang nap cau hinh tu .env..." -ForegroundColor DarkCyan
        Get-Content $envFile | ForEach-Object {
            $line = $_.Trim()
            if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
                $parts = $line.Split("=", 2)
                $name = $parts[0].Trim()
                $val = $parts[1].Trim()
                if (-not [Environment]::GetEnvironmentVariable($name, [EnvironmentVariableTarget]::Process)) {
                    [Environment]::SetEnvironmentVariable($name, $val, [EnvironmentVariableTarget]::Process)
                }
            }
        }
    }

    # 2. Thiet lap thong so moi truong E2E
    $env:BASE_URL = $BaseUrl.TrimEnd("/")
    $env:E2E_ALLOW_REAL_AWS = "1"
    Write-Host "[2/3] Thiet lap moi truong:" -ForegroundColor DarkCyan
    Write-Host "      - BASE_URL            = $env:BASE_URL" -ForegroundColor Yellow
    Write-Host "      - E2E_ALLOW_REAL_AWS  = $env:E2E_ALLOW_REAL_AWS" -ForegroundColor Yellow

    # 3. Kiem tra trang thai Backend
    Write-Host "[3/3] Dang kiem tra ket noi Backend ($env:BASE_URL)..." -ForegroundColor DarkCyan
    
    $checkUrl = "$env:BASE_URL/login.html"
    $isAlive = $false
    try {
        $res = curl.exe -I -s --max-time 3 $checkUrl
        if ($res -and $res -match "HTTP/\S+\s+200") {
            $isAlive = $true
        }
    } catch {
        $isAlive = $false
    }

    if (-not $isAlive) {
        Write-Host ""
        Write-Host "----------------------------------------------------------" -ForegroundColor Red
        Write-Host " [!] CHUA PHAT HIEN BACKEND SPRING BOOT DANG CHAY" -ForegroundColor Red
        Write-Host "----------------------------------------------------------" -ForegroundColor Red
        Write-Host " Backend chua phan hoi tai: $env:BASE_URL" -ForegroundColor Yellow
        Write-Host ""
        Write-Host " HUONG DAN BAT BACKEND:" -ForegroundColor Cyan
        Write-Host " 1. Mo cua so VS Code cua du an xregion." -ForegroundColor White
        Write-Host " 2. Chuyen sang tab 'Run and Debug' (Ctrl + Shift + D)." -ForegroundColor White
        Write-Host " 3. Chon cau hinh 'Spring Boot-XRegionApplication' va nhan F5." -ForegroundColor White
        Write-Host " 4. Doi thong bao Spring Boot khoi dong hoan tat." -ForegroundColor White
        Write-Host " 5. Chay lai file run.bat de bat dau kiem thu E2E!" -ForegroundColor Green
        Write-Host "----------------------------------------------------------" -ForegroundColor Red
        return
    }

    Write-Host "[Backend] Da ket noi thanh cong toi Backend (HTTP 200 OK)!" -ForegroundColor Green

    # 4. Thuc thi Playwright E2E Suite
    Set-Location $ScriptDir

    $pwArgs = @("test", "--project=chromium")
    if (-not $Headless) {
        # Mac dinh chay HEADED theo yeu cau de quan sat truc quan giao dien
        $pwArgs += "--headed"
    }
    if ($ExtraArgs) {
        $pwArgs += $ExtraArgs
    }

    Write-Host ""
    Write-Host "Bat dau thuc thi Playwright E2E Suite (Serial Mode)..." -ForegroundColor Cyan
    Write-Host "Lenh: npx playwright $($pwArgs -join ' ')" -ForegroundColor Gray
    Write-Host "==========================================================" -ForegroundColor Cyan

    # Tim lenh npx phu hop (npx.cmd hoac npx)
    $npxCmd = if (Get-Command npx.cmd -ErrorAction SilentlyContinue) { "npx.cmd" } else { "npx" }
    & $npxCmd playwright @pwArgs

} catch {
    Write-Host "`n[LOI] Da xay ra loi ngoai y muon: $_" -ForegroundColor Red
} finally {
    Set-Location $ScriptDir
    Write-Host "`n==========================================================" -ForegroundColor Cyan
    Write-Host "  Qua trinh kiem thu ket thuc." -ForegroundColor Cyan
    Write-Host "==========================================================" -ForegroundColor Cyan
    Write-Host ""
    $null = Read-Host "Nhan phim Enter de dong cua so nay..."
}
