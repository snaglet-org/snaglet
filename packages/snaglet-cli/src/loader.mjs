/**
 * ESM resolve hook: maps '@snaglet/sdk' (and '@snaglet/tool-sdk' for compat) to the
 * bundled sdk-runtime so sandbox scripts can import the SDK without any
 * node_modules installation. Registered via src/register.mjs.
 */
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SDK_URL = pathToFileURL(join(here, 'sdk-runtime.mjs')).href;

const MAPPED = new Set(['@snaglet/sdk', '@snaglet/tool-sdk', 'snaglet:sdk']);

export function resolve(specifier, context, nextResolve) {
  if (MAPPED.has(specifier)) {
    return { url: SDK_URL, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
