# BFF 启动脚本 (Windows PowerShell)
# 双击运行或在 PowerShell 中执行：.\start.ps1
# 关闭窗口即停止 BFF，不做后台运行。

$ErrorActionPreference = "Stop"
$BFF_ROOT = Split-Path -Parent $PSScriptRoot

function Write-Step($msg) { Write-Host "`n========== $msg ==========" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  [!!] $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "  [XX] $msg" -ForegroundColor Red }

# ── 1. 检测 nvm ──
Write-Step "检测 nvm"
$nvmInstalled = $false
try {
    $nvmVersion = & nvm version 2>$null
    if ($LASTEXITCODE -eq 0 -and $nvmVersion) {
        $nvmInstalled = $true
        Write-Ok "nvm 已安装：$nvmVersion"
    }
} catch {}

if (-not $nvmInstalled) {
    Write-Warn "nvm 未安装，尝试通过 winget 安装..."
    try {
        winget install CoreyButler.NVMforWindows --accept-package-agreements --accept-source-agreements 2>$null
        # 刷新环境变量
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
        $nvmVersion = & nvm version 2>$null
        if ($nvmVersion) {
            Write-Ok "nvm 安装成功：$nvmVersion"
        } else {
            Write-Err "nvm 安装失败。请手动安装：https://github.com/coreybutler/nvm-windows/releases"
            Read-Host "按回车键退出"
            exit 1
        }
    } catch {
        Write-Err "winget 不可用。请手动安装 nvm：https://github.com/coreybutler/nvm-windows/releases"
        Read-Host "按回车键退出"
        exit 1
    }
}

# ── 2. 安装 Node 22 ──
Write-Step "安装 Node.js 22"
& nvm install 22
& nvm use 22
# 刷新 PATH
$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")

# ── 3. 检测 node 和 npm 版本 ──
Write-Step "检测 Node 和 npm"
$nodeVersion = & node --version
$npmVersion = & npm --version
Write-Ok "Node: $nodeVersion"
Write-Ok "npm: v$npmVersion"

# ── 4. 检测 nrm ──
Write-Step "检测 nrm"
$nrmInstalled = $false
try {
    $nrmVersion = & nrm --version 2>$null
    if ($LASTEXITCODE -eq 0 -and $nrmVersion) {
        $nrmInstalled = $true
        Write-Ok "nrm 已安装：v$nrmVersion"
    }
} catch {}

if (-not $nrmInstalled) {
    Write-Warn "nrm 未安装，正在安装..."
    & npm install -g nrm
    Write-Ok "nrm 安装完成"
}

# ── 5. 切换淘宝源 ──
Write-Step "切换 npm 源到淘宝镜像"
& nrm use taobao 2>$null
if ($LASTEXITCODE -ne 0) {
    # 某些 nrm 版本用不同名称
    & nrm use cnpm 2>$null
}
$currentRegistry = & npm config get registry
Write-Ok "当前 npm 源：$currentRegistry"

# ── 6. 检测 pnpm ──
Write-Step "检测 pnpm"
$pnpmInstalled = $false
try {
    $pnpmVersion = & pnpm --version 2>$null
    if ($LASTEXITCODE -eq 0 -and $pnpmVersion) {
        $pnpmInstalled = $true
        Write-Ok "pnpm 已安装：v$pnpmVersion"
    }
} catch {}

if (-not $pnpmInstalled) {
    Write-Warn "pnpm 未安装，正在安装..."
    & npm install -g pnpm
    Write-Ok "pnpm 安装完成"
}

# ── 7. 安装 BFF 依赖 ──
Write-Step "安装 BFF 依赖"
Write-Host "  项目目录：$BFF_ROOT"
Set-Location $BFF_ROOT
# 需要在 agent-kit 根目录安装 workspace 依赖
$repoRoot = Split-Path -Parent (Split-Path -Parent $BFF_ROOT)
Write-Host "  workspace 根目录：$repoRoot"
Set-Location $repoRoot
& pnpm install
if ($LASTEXITCODE -ne 0) {
    Write-Err "依赖安装失败"
    Read-Host "按回车键退出"
    exit 1
}
Write-Ok "依赖安装完成"

# ── 8. 启动 BFF ──
Write-Step "环境检查完毕，启动 BFF"
Write-Host "  首次启动会自动生成 .env 配置文件模板" -ForegroundColor Yellow
Write-Host "  请填写后重新运行本脚本" -ForegroundColor Yellow
Write-Host ""
Set-Location $BFF_ROOT
& pnpm start

# ── 9. 等待用户按键 ──
Write-Host ""
Write-Host "BFF 已停止运行。" -ForegroundColor Cyan
Read-Host "按回车键关闭窗口"
