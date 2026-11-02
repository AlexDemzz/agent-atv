import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export default function setup(): void {
  const packageDir = fileURLToPath(new URL('../..', import.meta.url));
  const tsc = fileURLToPath(new URL('../../../../node_modules/typescript/bin/tsc', import.meta.url));
  execFileSync(process.execPath, [tsc, '-p', 'tsconfig.json'], { cwd: packageDir, stdio: 'inherit' });
}
