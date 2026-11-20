import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'apps/server/src/services/ToolService/generated/**',
      // Generated from packages/theme/src by its generate script.
      'packages/theme/index.js',
      'packages/theme/index.d.ts',
      'apps/desktop/src-tauri/binaries/**',
      'apps/desktop/src-tauri/resources/**',
      'apps/desktop/src-tauri/target/**',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsparser,
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'off',
      'no-console': 'off',
      // Relative and internal aliased module specifiers must be authored without
      // a file extension; runtime extensions are added on emit by tsc-alias.
      // Scoped third-party packages may require extensions in their exports.
      // `.mjs`/`.cjs` specifiers are deliberately not banned: they point at
      // real on-disk plain-JS files (e.g. scripts/lib/dev-ports.mjs) whose
      // extension is required at runtime and preserved verbatim by tsc.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'ImportDeclaration[source.value=/^(\\.{1,2}\\/|@(snaglet|server|desktop)\\/).*\\.(js|jsx|ts|tsx)$/]',
          message:
            'Do not author file extensions in import specifiers; tsc-alias adds them on emit.',
        },
        {
          selector:
            'ExportNamedDeclaration[source.value=/^(\\.{1,2}\\/|@(snaglet|server|desktop)\\/).*\\.(js|jsx|ts|tsx)$/]',
          message:
            'Do not author file extensions in export specifiers; tsc-alias adds them on emit.',
        },
        {
          selector:
            'ExportAllDeclaration[source.value=/^(\\.{1,2}\\/|@(snaglet|server|desktop)\\/).*\\.(js|jsx|ts|tsx)$/]',
          message:
            'Do not author file extensions in export specifiers; tsc-alias adds them on emit.',
        },
        // Ban silent error swallowing. Covers both the arrow-style promise
        // catch (`.catch(() => {})`) and the implicit-no-op return
        // (`.catch(() => undefined)`). Block-style `try {} catch {}` is caught
        // separately by `no-empty` with allowEmptyCatch:false.
        {
          selector:
            "CallExpression[callee.property.name='catch'] > ArrowFunctionExpression > BlockStatement[body.length=0]",
          message:
            'Do not swallow errors silently. Log via logger/console.error or handle the rejection.',
        },
        {
          selector:
            "CallExpression[callee.property.name='catch'] > ArrowFunctionExpression[body.type='Identifier'][body.name='undefined']",
          message:
            'Do not swallow errors silently with `.catch(() => undefined)`. Log or handle the rejection.',
        },
        // Synchronous-throw landmine: `new URL(getApiUrl(...))` throws on a
        // relative path in dev (Vite proxy) before fetch ever runs. Build the
        // query with URLSearchParams and pass the relative path through instead.
        {
          selector: "NewExpression[callee.name='URL'] > CallExpression[callee.name='getApiUrl']",
          message:
            'Do not wrap getApiUrl() in new URL() — it throws on relative dev paths. Use URLSearchParams + the relative path.',
        },
      ],
      'no-empty': ['error', { allowEmptyCatch: false }],
    },
  },
];
