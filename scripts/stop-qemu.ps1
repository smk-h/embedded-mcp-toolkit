# =====================================================
# QEMU 后台进程清理脚本
#
#   杀掉所有仍在运行的 qemu-system-*.exe 进程。典型场景：
#   上一次启动的 QEMU 没退干净、仍占用 TCP 串口/monitor 端口，
#   再次 npm run qemu 时报 "Failed to find an available port"。
#
#   用法：
#     powershell -NoProfile -ExecutionPolicy Bypass -File scripts\stop-qemu.ps1
#     npm run qemu:kill
# =====================================================
param(
    [string]$Name = "qemu-system*",    # 要清理的进程名匹配模式
    [int[]]$CheckPorts = @(4444, 5555) # 清理后复查的监听端口
)

$ErrorActionPreference = "Stop"

$targets = @(Get-Process -Name $Name -ErrorAction SilentlyContinue)
if ($targets.Count -eq 0) {
    Write-Host "没有发现运行中的 QEMU 进程（$Name）。"
}
else {
    Write-Host "发现 $($targets.Count) 个 QEMU 进程："
    foreach ($p in $targets) {
        Write-Host ("  PID {0,-8} {1}" -f $p.Id, $p.ProcessName)
    }

    foreach ($p in $targets) {
        try {
            Stop-Process -Id $p.Id -Force -ErrorAction Stop
            Write-Host ("已结束 PID {0}" -f $p.Id)
        }
        catch {
            Write-Warning ("结束 PID {0} 失败：{1}" -f $p.Id, $_.Exception.Message)
        }
    }
    Write-Host ""
}

# 复查端口占用：端口仍被监听说明有其他进程占用，需另行排查
foreach ($port in $CheckPorts) {
    $conn = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
    if ($conn.Count -gt 0) {
        Write-Warning ("端口 {0} 仍被 PID {1} 监听，可能另有其他进程占用。" -f $port, $conn[0].OwningProcess)
    }
    else {
        Write-Host ("端口 {0} 已空闲" -f $port)
    }
}
