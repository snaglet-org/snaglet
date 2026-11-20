import crossSpawn from 'cross-spawn';
import { readFileSync } from 'node:fs';

const baseline = JSON.parse(
  readFileSync(new URL('../quality-baseline.json', import.meta.url), 'utf8')
);

function run(command, args) {
  const result = crossSpawn.sync(command, args, {
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0' },
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw new Error(`Could not start ${command}`, { cause: result.error });
  return { stderr: result.stderr, stdout: result.stdout };
}

const eslintRun = run('pnpm', ['exec', 'eslint', '.', '--format', 'json']);
const eslintReport = JSON.parse(eslintRun.stdout);
const eslint = eslintReport.reduce(
  (counts, file) => ({
    errors: counts.errors + file.errorCount,
    warnings: counts.warnings + file.warningCount,
  }),
  { errors: 0, warnings: 0 }
);

const knipRun = run('pnpm', ['exec', 'knip', '--reporter', 'json']);
const jsonStart = knipRun.stdout.indexOf('{"issues"');
if (jsonStart < 0)
  throw new Error(`Knip did not produce JSON:\n${knipRun.stdout}\n${knipRun.stderr}`);
const knipReport = JSON.parse(knipRun.stdout.slice(jsonStart));
const knip = knipReport.issues.reduce((counts, issue) => {
  for (const [category, findings] of Object.entries(issue)) {
    if (category !== 'file' && Array.isArray(findings))
      counts[category] = (counts[category] ?? 0) + findings.length;
  }
  return counts;
}, {});

const regressions = [];
for (const key of ['errors', 'warnings']) {
  if (eslint[key] > baseline.eslint[key])
    regressions.push(`ESLint ${key}: ${eslint[key]} > ${baseline.eslint[key]}`);
}
for (const [category, count] of Object.entries(knip)) {
  if (count > (baseline.knip[category] ?? 0))
    regressions.push(`Knip ${category}: ${count} > ${baseline.knip[category] ?? 0}`);
}

console.log(`ESLint baseline: ${eslint.errors} errors, ${eslint.warnings} warnings`);
console.log(
  `Knip baseline: ${Object.values(knip).reduce((total, count) => total + count, 0)} findings`
);
if (regressions.length > 0)
  throw new Error(`Quality baseline regressed:\n${regressions.join('\n')}`);
