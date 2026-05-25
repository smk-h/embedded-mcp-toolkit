#!/usr/bin/env node
import { existsSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, '..');
const outIndex = resolve(rootDir, 'out', 'index.js');

if (!existsSync(outIndex)) {
  console.log('[embedded-mcp-toolkit] out/index.js 未编译，正在自动构建...');
  execSync('npm run build', { cwd: rootDir, stdio: 'inherit' });
  console.log('[embedded-mcp-toolkit] 构建完成，启动服务...');
}

import('../out/index.js');
