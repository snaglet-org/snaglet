/**
 * Writes @snaglet/theme's committed outputs from src/: `index.js` and
 * `index.d.ts` (the package entry), `defaultTheme.json`, `theme.css` and
 * `tokens.scss`.
 *
 *   pnpm --filter @snaglet/theme generate          write them
 *   pnpm --filter @snaglet/theme generate --check  fail when one is stale
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { defaultTheme, THEME_TOKEN_KEYS } from '../src/index';
import { renderThemeCss, renderTokensScss } from '../src/stylesheet';

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY_SOURCE = path.join(PACKAGE_DIR, 'src/index.ts');
const GENERATED = '// Generated from src/index.ts by scripts/generate.ts. Do not edit by hand.\n';

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  skipLibCheck: true,
  types: [],
  newLine: ts.NewLineKind.LineFeed,
};

/** The package entry compiled from src/index.ts: its JavaScript and its declarations. */
function compileEntry(): { js: string; dts: string } {
  const source = readFileSync(ENTRY_SOURCE, 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: COMPILER_OPTIONS,
    fileName: ENTRY_SOURCE,
  }).outputText;
  let dts = '';
  const program = ts.createProgram([ENTRY_SOURCE], {
    ...COMPILER_OPTIONS,
    declaration: true,
    emitDeclarationOnly: true,
  });
  const result = program.emit(undefined, (_file, text) => {
    dts = text;
  });
  const errors = ts
    .getPreEmitDiagnostics(program)
    .concat(result.diagnostics)
    .filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length)
    throw new Error(ts.formatDiagnostics(errors, ts.createCompilerHost(COMPILER_OPTIONS)));
  return { js: GENERATED + js, dts: GENERATED + dts };
}

/** `defaultTheme.json`: token key to color, keys sorted, 2-space indent, trailing newline. */
function renderJson(): string {
  const sorted = Object.fromEntries(
    [...THEME_TOKEN_KEYS].sort().map((key) => [key, defaultTheme[key]])
  );
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

/** Every generated file, by its path in the package, with its content. */
export function renderThemeFiles(): Record<string, string> {
  const entry = compileEntry();
  return {
    'index.js': entry.js,
    'index.d.ts': entry.dts,
    'defaultTheme.json': renderJson(),
    'theme.css': renderThemeCss(),
    'tokens.scss': renderTokensScss(),
  };
}

/** The generated files whose committed copy differs from what src/ produces. */
export function staleThemeFiles(): string[] {
  return Object.entries(renderThemeFiles())
    .filter(([file, content]) => {
      try {
        return readFileSync(path.join(PACKAGE_DIR, file), 'utf8') !== content;
      } catch {
        return true;
      }
    })
    .map(([file]) => file);
}

function main(): void {
  if (process.argv.includes('--check')) {
    const stale = staleThemeFiles();
    if (stale.length) {
      console.error(
        `@snaglet/theme: ${stale.join(', ')} out of date with src/. ` +
          'Run `pnpm --filter @snaglet/theme generate` and commit the result.'
      );
      process.exit(1);
    }
    console.log('@snaglet/theme: generated files are up to date.');
    return;
  }
  for (const [file, content] of Object.entries(renderThemeFiles()))
    writeFileSync(path.join(PACKAGE_DIR, file), content);
  console.log(
    '@snaglet/theme: wrote index.js, index.d.ts, defaultTheme.json, theme.css, tokens.scss.'
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
