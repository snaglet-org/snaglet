/**
 * CJS twin of dev-ports.mjs for Jest (ts-jest runs CJS and cannot parse the
 * ESM .mjs — the same pattern as db-dirname.cjs, mapped in jest.config.js).
 * Keep the exported constants in sync with the .mjs.
 */
const DEFAULT_DEV_SERVER_PORT = 4001;
const DEFAULT_DEV_CLIENT_PORT = 3001;
const DEFAULT_PREVIEW_SERVER_PORT = 4101;
const DEFAULT_PREVIEW_CLIENT_PORT = 3101;

module.exports = {
  DEFAULT_DEV_SERVER_PORT,
  DEFAULT_DEV_CLIENT_PORT,
  DEFAULT_PREVIEW_SERVER_PORT,
  DEFAULT_PREVIEW_CLIENT_PORT,
};
