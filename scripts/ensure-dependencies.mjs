import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 17)) {
  console.error(`[Cluevia] Node.js 22.17 이상이 필요합니다. 현재 버전: ${process.versions.node}`);
  process.exit(1);
}

const rootDirectory = fileURLToPath(new URL('..', import.meta.url));
const binSuffix = process.platform === 'win32' ? '.cmd' : '';
const requiredFiles = [
  'vite/bin/vite.js',
  'typescript/bin/tsc',
  ...['vite', 'tsc'].map((name) => `.bin/${name}${binSuffix}`),
];

function dependenciesReady() {
  if (requiredFiles.some((file) => !existsSync(join(rootDirectory, 'node_modules', file)))) return false;

  // Probe in a child so Windows releases native modules before npm replaces them.
  const probe = spawnSync(process.execPath, ['-e', `
    require('rollup');
    require('esbuild').transformSync('const ready = true;');
  `], { cwd: rootDirectory, stdio: 'ignore', timeout: 30_000, windowsHide: true });
  return probe.status === 0;
}

if (!dependenciesReady()) {
  console.log(`[Cluevia] ${process.platform}/${process.arch} 환경에 맞는 앱 의존성을 설치합니다.`);
  const npmCli = process.env.npm_execpath;
  if (!npmCli || !existsSync(npmCli)) {
    console.error('프로젝트 루트에서 npm ci --include=dev --include=optional을 실행한 뒤 다시 시도하세요.');
    process.exit(1);
  }

  // Use npm's JS entry with the current Node, avoiding npm.cmd shell quoting.
  const install = spawnSync(process.execPath, [npmCli, 'ci', '--include=dev', '--include=optional'], {
    cwd: rootDirectory,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (install.error || install.status !== 0) {
    console.error('앱 의존성 설치에 실패했습니다. 위 npm 오류를 확인한 뒤 npm ci --include=dev --include=optional을 실행하세요.');
    process.exit(install.status || 1);
  }
  if (!dependenciesReady()) {
    console.error('설치 후에도 앱 빌드 의존성을 읽을 수 없습니다. 같은 환경에서 npm ci --include=dev --include=optional을 실행하세요.');
    process.exit(1);
  }
}
