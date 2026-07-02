/* Sequential test runner: node tests/run.mjs (or `npm test`). */
import { spawn } from 'child_process';
import { readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const suites = readdirSync(dir).filter(f => f.endsWith('.test.mjs')).sort();
let failed = 0;

for (const f of suites){
  const code = await new Promise(res => {
    const p = spawn(process.execPath, [path.join(dir, f)], { stdio: ['ignore','pipe','pipe'] });
    let out = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => out += d);
    p.on('close', c => {
      const tail = out.trim().split('\n').filter(l => l.includes('pass') || l.includes('FAIL'));
      console.log(`${c === 0 ? '✓' : '✗'} ${f}`);
      tail.forEach(l => console.log('   ' + l));
      res(c);
    });
  });
  if (code !== 0) failed++;
}
console.log(failed ? `\n${failed} suite(s) FAILED` : `\nAll ${suites.length} suites passed`);
process.exit(failed ? 1 : 0);
