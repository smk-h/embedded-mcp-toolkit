# build.ps1 —— 一键重建 embedded-mcp-toolkit 项目介绍 PPT
# 用法：powershell -ExecutionPolicy Bypass -File build.ps1
#       成品/中间产物若正被 PowerPoint 打开，会自动关掉这几个文档再继续（不影响其他打开的文档）；
#       仅当自动关闭失败时需要加 -Force 强制结束 POWERPNT 进程
param([switch]$Force)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$target = Join-Path $PSScriptRoot 'embedded-mcp-toolkit-项目介绍.pptx'
$tmpNew = Join-Path $PSScriptRoot '.tmp\out_new.pptx'
$tmpFix = Join-Path $PSScriptRoot '.tmp\out_fixed.pptx'

# ---- 0. 依赖检查 ----
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host '[X] 未找到 node，请先安装 Node.js' -ForegroundColor Red; exit 1 }
if (-not (Get-Command python -ErrorAction SilentlyContinue)) { Write-Host '[X] 未找到 python，请先安装 Python' -ForegroundColor Red; exit 1 }
if (-not (Test-Path (Join-Path $PSScriptRoot '..\node_modules\pptxgenjs'))) {
    Write-Host '[X] 缺少 pptxgenjs：在仓库根目录执行  npm i -D pptxgenjs' -ForegroundColor Red; exit 1
}
New-Item -ItemType Directory -Force (Join-Path $PSScriptRoot '.tmp') | Out-Null

# ---- 1. 占用预检：被 PowerPoint 打开的文件自动关闭 ----
function Test-Locked([string]$f) {
    try { $fs = [System.IO.File]::Open($f, 'Open', 'ReadWrite', 'None'); $fs.Close(); return $false }
    catch { return $true }
}
$watched = @($tmpNew, $tmpFix, $target) | Where-Object { Test-Path $_ }
$locked  = @($watched | Where-Object { Test-Locked $_ })

if ($locked.Count -gt 0 -and (Get-Process POWERPNT -ErrorAction SilentlyContinue)) {
    try {
        # 只关掉这几个演示文稿：标记为已保存以免弹窗；其他打开的文档不动
        $app = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application')
        foreach ($p in @($app.Presentations)) {
            if ($locked -contains $p.FullName) { $p.Saved = $true; $p.Close() }
        }
        if ($app.Presentations.Count -eq 0) { $app.Quit() }
    } catch { }
    Start-Sleep -Seconds 1
    $locked = @($watched | Where-Object { Test-Locked $_ })
}

if ($locked.Count -gt 0 -and $Force) {
    Get-Process POWERPNT -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 1
    $locked = @($watched | Where-Object { Test-Locked $_ })
}

if ($locked.Count -gt 0) {
    Write-Host '[X] 以下文件仍被占用（非 PowerPoint 或自动关闭失败），请手动关闭后重试：' -ForegroundColor Red
    $locked | ForEach-Object { Write-Host "    $_" -ForegroundColor Yellow }
    exit 1
}

# ---- 2. 生成 ----
Write-Host '[2/4] node build_ppt.mjs' -ForegroundColor Cyan
node build_ppt.mjs
if ($LASTEXITCODE -ne 0) { Write-Host '[X] 生成失败' -ForegroundColor Red; exit 1 }

# ---- 3. 后处理（修复 pptxgenjs 的 <a:pPr> 重复，否则 PowerPoint 打不开）----
Write-Host '[3/4] python post_fix.py' -ForegroundColor Cyan
python post_fix.py .tmp\out_new.pptx .tmp\out_fixed.pptx
if ($LASTEXITCODE -ne 0) { Write-Host '[X] 后处理失败' -ForegroundColor Red; exit 1 }

# ---- 4. 覆盖成品 ----
Copy-Item $tmpFix $target -Force
Write-Host "[OK] 已生成 $target" -ForegroundColor Green
