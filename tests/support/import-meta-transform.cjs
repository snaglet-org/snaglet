/**
 * Custom Jest transform: ts-jest + import.meta.url polyfill for CJS runtime.
 *
 * ts-jest compiles TypeScript but preserves `import.meta.url` when module=ESNext.
 * Jest's CJS runtime then chokes on it. This wraps ts-jest and does a post-process
 * text replacement of `import.meta.url` -> CJS equivalent.
 *
 * Handles the common ESM pattern:
 *   const __filename = fileURLToPath(import.meta.url);
 *   const __dirname = path.dirname(__filename);
 * by removing the declarations entirely (Jest CJS already provides __filename/__dirname).
 */
'use strict';

const { TsJestTransformer } = require('ts-jest');

class ImportMetaTransformer extends TsJestTransformer {
  process(sourceText, sourcePath, options) {
    const result = super.process(sourceText, sourcePath, options);

    let code = result.code;
    const map = result.map;

    if (!code.includes('import.meta')) {
      return result;
    }

    // Step 1: Remove `const __filename = fileURLToPath(import.meta.url);`
    // This declaration shadows Jest's CJS-injected __filename and causes circular refs.
    code = code.replace(
      /(?:const|let|var)\s+__filename\s*=\s*[^;]*import\.meta\.url[^;]*;/g,
      '/* __filename provided by Jest CJS runtime */'
    );

    // Step 2: Remove `const __dirname = path.dirname(__filename);` or similar
    // Only if it immediately follows the __filename removal (to avoid removing unrelated __dirname decls)
    // Actually, __dirname is also provided by Jest CJS, so removing the shadow is always safe.
    code = code.replace(
      /(?:const|let|var)\s+__dirname\s*=\s*[^;]*__filename[^;]*;/g,
      '/* __dirname provided by Jest CJS runtime */'
    );

    // Step 3: Replace any remaining import.meta.url with CJS equivalent
    if (code.includes('import.meta.url')) {
      code = code.replace(/import\.meta\.url/g, 'require("url").pathToFileURL(__filename).href');
    }

    // Step 4: Replace import.meta.dirname / import.meta.filename if present
    if (code.includes('import.meta.dirname')) {
      code = code.replace(/import\.meta\.dirname/g, '__dirname');
    }
    if (code.includes('import.meta.filename')) {
      code = code.replace(/import\.meta\.filename/g, '__filename');
    }

    return { code, map };
  }
}

module.exports = {
  createTransformer: (options) => new ImportMetaTransformer(options),
};
