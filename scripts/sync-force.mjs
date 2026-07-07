import { execSync } from 'node:child_process';

const branch = execSync('git symbolic-ref --short HEAD').toString().trim();
execSync('git fetch origin', { stdio: 'inherit' });
execSync(`git reset --hard origin/${branch}`, { stdio: 'inherit' });
