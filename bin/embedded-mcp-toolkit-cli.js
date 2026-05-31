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

// 所有命令统一由 Commander 在 src/index.ts 中路由解析
import('../out/index.js').catch((err) => {
  console.error('Failed to load CLI:', err);
  process.exit(1);
});
