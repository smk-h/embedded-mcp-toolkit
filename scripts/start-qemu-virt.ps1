# =====================================================
# QEMU virt 虚拟板卡启动脚本（arm64 + Alpine netboot 内核）
#
#   启动一台 QEMU virt 虚拟开发板，串口以 TCP 服务端形式监听，
#   供 embedded-mcp-toolkit 以 tcp:// 端点接入（等效真实板卡插着串口线）：
#     - toolkit 侧  : serial_open 的 port 参数填 tcp://127.0.0.1:4444
#     - 引导完成    : 应急 shell 提示符 "~ #"（Alpine initramfs 应急模式，
#                     无启动介质时属预期行为）
#     - 停止        : 本终端 Ctrl+C，或 telnet monitor 里执行 quit
#
#   用法：
#     powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-qemu-virt.ps1
#     npm run qemu                                              # package.json 同款
#     npm run qemu -- -SerialPort 5566 -MonitorPort 5567        # 自定义端口
#
#   内核/initramfs 默认取 <仓库根>\qemu\ 目录（vmlinuz-virt / initramfs-virt，
#   下载自 https://dl-cdn.alpinelinux.org/alpine/latest-stable/releases/aarch64/netboot/）。
# =====================================================
param(
    [int]$SerialPort = 4444,      # TCP 串口监听端口
    [int]$MonitorPort = 5555,     # telnet monitor 监听端口
    [string]$Memory = "512M",     # 虚拟机内存
    [string]$Kernel = "",         # 内核路径，默认 <仓库根>\qemu\vmlinuz-virt
    [string]$Initrd = ""          # initramfs 路径，默认 <仓库根>\qemu\initramfs-virt
)

$ErrorActionPreference = "Stop"

# 仓库根 = 本脚本（scripts/）的上一级
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $Kernel) { $Kernel = Join-Path $repoRoot "qemu\vmlinuz-virt" }
if (-not $Initrd) { $Initrd = Join-Path $repoRoot "qemu\initramfs-virt" }

foreach ($f in @($Kernel, $Initrd)) {
    if (-not (Test-Path $f)) {
        Write-Error "未找到 $f ，请确认 qemu/ 目录下的内核与 initramfs 文件存在。"
    }
}

# 定位 qemu-system-aarch64：优先 PATH，回退默认安装目录
$qemuCmd = Get-Command qemu-system-aarch64.exe -ErrorAction SilentlyContinue
if ($qemuCmd) {
    $qemuExe = $qemuCmd.Source
}
elseif (Test-Path "C:\Program Files\qemu\qemu-system-aarch64.exe") {
    $qemuExe = "C:\Program Files\qemu\qemu-system-aarch64.exe"
}
else {
    Write-Error "未找到 qemu-system-aarch64.exe，请确认 QEMU 已安装并加入 PATH。"
}

Write-Host "内核     : $Kernel"
Write-Host "initrd   : $Initrd"
Write-Host "TCP 串口 : tcp://127.0.0.1:$SerialPort  <- toolkit serial_open 的 port 参数"
Write-Host "monitor  : telnet 127.0.0.1 $MonitorPort（执行 quit 关机）"
Write-Host "停止     : 本终端 Ctrl+C"
Write-Host ""

# -cpu cortex-a57 必须显式指定：Windows 官方安装包的 virt 机型默认 CPU 是
# AArch32，arm64 内核无法引导（实测 11.1.0 安装包如此）
& $qemuExe -M virt -cpu cortex-a57 -m $Memory -display none `
    -kernel $Kernel -initrd $Initrd `
    -append "console=ttyAMA0" `
    -serial "tcp:127.0.0.1:$SerialPort,server,nowait" `
    -monitor "telnet:127.0.0.1:$MonitorPort,server,nowait"
