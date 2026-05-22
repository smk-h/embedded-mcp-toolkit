#!/bin/bash
# setup-systemd.sh — psh systemd 部署脚本
# 用法:
#   ./setup-systemd.sh           # 编译 + 安装 + 启用服务
#   ./setup-systemd.sh install   # 仅安装(假设已编译)
#   ./setup-systemd.sh remove    # 卸载

set -e

# 脚本所在目录 (docker/ 或 Docker 内 /app/)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PSH_BIN="/bin/psh"
BG_BIN="/usr/local/bin/bg-demo"
PSH_SVC="/etc/systemd/system/psh.service"
BG_SVC="/etc/systemd/system/psh-bg.service"
LOG_FILE="/var/log/psh.log"

die() {
    echo "ERROR: $*" >&2
    exit 1
}

do_build() {
    echo "=== Building ==="
    make all
}

do_install() {
    echo "=== Installing binaries ==="
    install -m 0755 psh     "$PSH_BIN"
    install -m 0755 bg-demo "$BG_BIN"

    echo "=== Installing service files ==="
    cp "$SCRIPT_DIR/psh.service"    "$PSH_SVC"
    cp "$SCRIPT_DIR/psh-bg.service" "$BG_SVC"

    echo "=== Creating log file ==="
    touch "$LOG_FILE"
    chmod 0666 "$LOG_FILE"

    echo "=== Enabling services ==="
    systemctl daemon-reload
    systemctl enable psh.service psh-bg.service
    systemctl start psh.service psh-bg.service

    echo ""
    echo "Done. Check status:"
    echo "  systemctl status psh.service psh-bg.service"
    echo "  journalctl -u psh.service -f"
}

do_remove() {
    echo "=== Stopping services ==="
    systemctl stop psh.service psh-bg.service 2>/dev/null || true
    systemctl disable psh.service psh-bg.service 2>/dev/null || true

    echo "=== Removing files ==="
    rm -f "$PSH_BIN" "$BG_BIN" "$PSH_SVC" "$BG_SVC" "$LOG_FILE"

    systemctl daemon-reload
    echo "Removed."
}

# --- Docker 构建模式(无 systemd 运行时) ---
do_docker_install() {
    echo "=== Docker build: installing binaries ==="
    install -m 0755 psh     "$PSH_BIN"
    install -m 0755 bg-demo "$BG_BIN"

    echo "=== Docker build: installing service files ==="
    cp "$SCRIPT_DIR/psh.service"    "$PSH_SVC"
    cp "$SCRIPT_DIR/psh-bg.service" "$BG_SVC"

    # systemctl 在构建期不可用, 手动创建 symlink
    mkdir -p /etc/systemd/system/multi-user.target.wants
    mkdir -p /etc/systemd/system/getty.target.wants
    ln -sf "$BG_SVC"  /etc/systemd/system/multi-user.target.wants/psh-bg.service
    ln -sf "$PSH_SVC" /etc/systemd/system/getty.target.wants/psh.service

    touch "$LOG_FILE"
    chmod 0666 "$LOG_FILE"

    echo "Docker build install done."
}

# --- 入口 ---
case "${1:-}" in
    install)
        do_install
        ;;
    remove|uninstall)
        do_remove
        ;;
    docker)
        do_build
        do_docker_install
        ;;
    *)
        do_build
        do_install
        ;;
esac
