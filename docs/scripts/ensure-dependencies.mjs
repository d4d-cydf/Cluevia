import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const docsDirectory = fileURLToPath(new URL('..', import.meta.url));
const binSuffix = process.platform === 'win32' ? '.cmd' : '';
const requiredFiles = [
  'next/dist/bin/next',
  'fumadocs-mdx/bin.js',
  'typescript/bin/tsc',
  ...['next', 'fumadocs-mdx', 'tsc'].map((name) => `.bin/${name}${binSuffix}`),
];

function dependenciesReady() {
  if (requiredFiles.some((file) => !existsSync(join(docsDirectory, 'node_modules', file)))) return false;

  // Windows also writes Unix shell shims. Check native packages to detect a
  // Windows -> WSL switch too. The child exits before npm ci so Windows releases
  // any loaded DLLs before npm replaces node_modules.
  const probe = spawnSync(process.execPath, ['-e', `
    require('@tailwindcss/oxide');
    require('lightningcss');
    require('esbuild').transformSync('const ready = true;');
    const prefix = '@next/swc-' + process.platform + '-' + process.arch;
    const candidates = Object.keys(require('next/package.json').optionalDependencies)
      .filter((name) => name.startsWith(prefix));
    if (!candidates.some((name) => {
      try { require(name); return true; } catch { return false; }
    })) throw new Error('Next.js native compiler is missing for this platform.');
  `], { cwd: docsDirectory, stdio: 'ignore', timeout: 30_000, windowsHide: true });
  return probe.status === 0;
}

if (!dependenciesReady()) {
  console.log(`[Cluevia Docs] ${process.platform}/${process.arch} 환경에 맞는 문서 의존성을 설치합니다.`);
  const npmCli = process.env.npm_execpath;
  if (!npmCli || !existsSync(npmCli)) {
    console.error('프로젝트 루트에서 npm run docs:install을 실행한 뒤 다시 시도하세요.');
    process.exit(1);
  }

  // Invoke npm's JS entry with the current Node, avoiding npm.cmd shell quoting.
  const install = spawnSync(process.execPath, [npmCli, 'ci', '--include=dev', '--include=optional'], {
    cwd: docsDirectory,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (install.error || install.status !== 0) {
    console.error('문서 의존성 설치에 실패했습니다. 위 npm 오류를 확인한 뒤 npm run docs:install을 실행하세요.');
    process.exit(install.status || 1);
  }
  if (!dependenciesReady()) {
    console.error('설치 후에도 실행 파일을 읽을 수 없습니다. Node.js 22.12 이상인지 확인하고, 같은 환경에서 npm run docs:install을 실행하세요.');
    process.exit(1);
  }
}
