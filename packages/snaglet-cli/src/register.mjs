/**
 * Passed to `node --import` when snaglet run executes a Node script.
 * Registers the loader that resolves '@snaglet/sdk' to the bundled runtime.
 */
import { register } from 'node:module';
register('./loader.mjs', import.meta.url);
