import { interactiveShell, pshDemoSsh } from "./ssh.js";
import { interactiveSerialShell, pshDemoSerial } from "./serial.js";
import { getSSHConfig, getSerialConfig, getAllConfig } from "./config.js";
import { startMcpServer } from "./mcp.js";

const mode = process.argv[2] || "mcp";   // 默认无参数时为 MCP 服务器模式

switch (mode) {
  case "mcp": {
    startMcpServer().catch((err: unknown) => {
      console.error("MCP Server fatal:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
    break;
  }
  case "ssh": {
    interactiveShell(getSSHConfig()).catch((err: unknown) => {
      console.error("Fatal:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
    break;
  }
  case "serial": {
    interactiveSerialShell(getSerialConfig()).catch((err: unknown) => {
      console.error("Fatal:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
    break;
  }
  case "psh-demo-ssh": {
    pshDemoSsh(getSSHConfig()).catch((err: unknown) => {
      console.error("Fatal:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
    break;
  }
  case "psh-demo-serial": {
    pshDemoSerial(getSerialConfig()).catch((err: unknown) => {
      console.error("Fatal:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
    break;
  }
  case "config": {
    const cfg = getAllConfig();
    console.log(`Device: ${cfg.deviceName}`);
    console.log("");
    console.log("[SSH]");
    console.log(JSON.stringify(cfg.ssh, null, 2));
    console.log("");
    console.log("[Serial]");
    console.log(JSON.stringify(cfg.serial, null, 2));
    console.log("");
    console.log("[SSH KeyProvider]");
    console.log(JSON.stringify(cfg.sshKeyProvider, null, 2));
    console.log("");
    console.log("[Serial KeyProvider]");
    console.log(JSON.stringify(cfg.serialKeyProvider, null, 2));
    break;
  }
  default:
    console.error("Usage: node index.js [mcp|ssh|serial|psh-demo-ssh|psh-demo-serial|config]");
    console.error("");
    console.error("  mcp              MCP 服务器模式（默认）");
    console.error("  ssh              SSH 交互式 shell");
    console.error("  serial           串口交互式 shell");
    console.error("  psh-demo-ssh     SSH 方式 PSH 探测 + 解锁演示");
    console.error("  psh-demo-serial  串口方式 PSH 探测 + 解锁演示");
    console.error("  config           打印当前默认设备的配置信息");
    console.error("");
    console.error("Configure via config.yaml (copy from config.example.yaml).");
    console.error("Set DEVICE env var to select a device, e.g. DEVICE=board-b node out/index.js ssh");
    process.exit(1);
}
