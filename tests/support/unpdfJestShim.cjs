/**
 * Jest-only: let unpdf load its PDF.js bundle without a dynamic import().
 *
 * unpdf's CommonJS build resolves PDF.js lazily with `import('unpdf/pdfjs')`.
 * Jest's VM sandbox rejects dynamic import() unless Node runs with
 * --experimental-vm-modules (ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG), so
 * every PDF extraction failed under test. Production is unaffected: the app
 * runs on plain Node, where that import works.
 *
 * unpdf's supported hook, definePDFJSModule(resolver), replaces that import.
 * The resolver uses Node's own require, which on Node >= 22 can load the
 * synchronous ESM bundle pdfjs.mjs directly. It is reached through
 * process.getBuiltinModule because Jest wraps `require('node:module')` and its
 * createRequire would route back through Jest's CommonJS loader. The bundle is the same file production imports, so the
 * tests still exercise the real parser rather than a mock.
 */
const path = require('node:path');

const nodeRequire = process.getBuiltinModule('node:module').createRequire(__filename);
const unpdf = require('unpdf');
const pdfjsPath = path.join(path.dirname(nodeRequire.resolve('unpdf')), 'pdfjs.mjs');

unpdf
  .definePDFJSModule(() => nodeRequire(pdfjsPath))
  .catch((error) => {
    // Surface the reason in the failing test's output instead of failing setup
    // for every file in the project; extraction will then report its own error.
    console.warn(`[unpdfJestShim] could not preload PDF.js: ${error}`);
  });
