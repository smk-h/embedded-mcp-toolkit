#!/usr/bin/env node
import { existsSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, '..');
const outIndex = resolve(rootDir, 'out', 'index.js');

// 确保 TS 已编译
if (!existsSync(outIndex)) {
  console.log('[embedded-mcp-toolkit] out/index.js 未编译，正在自动构建...');
  execSync('npm run build', { cwd: rootDir, stdio: 'inherit' });
  console.log('[embedded-mcp-toolkit] 构建完成，启动服务...');
}

// ---- init 子命令 ----
const subCommand = process.argv[2];
if (subCommand === 'init') {
  import('../out/command/init.js')
    .then((mod) => mod.runInit(process.argv.slice(3)))
    .catch((err) => {
      console.error('init 命令执行失败:', err.message);
      process.exit(1);
    });
} else {
  // ---- 正常 MCP 服务器启动 ----
  import('../out/index.js');
}
