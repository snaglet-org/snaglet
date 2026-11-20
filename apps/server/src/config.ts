/**
 * Server environment configuration with validation
 */

// Env files load on import (see config/environment); required-variable
// validation below still catches genuinely missing config.
import '@server/config/environment';
import {
  REQUIRED_ENV_VARS,
  type ParsedServerEnvironment,
  type ServerEnvironmentVariables,
} from './types';
import { logger } from '@server/config/logger';
import { getErrorMessage, isHttpUrl } from '@snaglet/shared/utils';
import { DEFAULT_DEV_SERVER_PORT } from '../../../scripts/lib/dev-ports.mjs';

/**
 * Fixed dev-port default for the server. The server listens on
 * DEFAULT_DEV_SERVER_PORT (4001); PORT in .env / .env.local overrides it so a
 * second checkout can run a second server concurrently. The client (Vite UI)
 * port is owned by the frontend tooling (vite.config.ts / patch-tauri-port.mjs)
 * via CLIENT_PORT and is not set here. We never silently move a busy port:
 * listen() fails loud on EADDRINUSE (see index.ts).
 *
 * Dev only: production returns early. Packaged builds receive every value
 * explicitly from the desktop shell, and the sidecar binds an OS-assigned port.
 */
function applyDefaultDevPorts(): void {
  if (process.env.NODE_ENV === 'production') return;
  const filled: string[] = [];
  if (!process.env.PORT) {
    process.env.PORT = String(DEFAULT_DEV_SERVER_PORT);
    filled.push(`PORT=${process.env.PORT}`);
  }
  if (!process.env.API_BASE_URL) {
    process.env.API_BASE_URL = `http://localhost:${process.env.PORT}`;
    filled.push(`API_BASE_URL=${process.env.API_BASE_URL}`);
  }
  if (filled.length > 0) {
    logger.info(`[config] applied default dev ports: ${filled.join(' ')}`);
  }
}

if (process.env.NODE_ENV !== 'test') {
  applyDefaultDevPorts();
}

function validateEnvironmentVariables(): ServerEnvironmentVariables {
  const missingVars: string[] = [];
  const invalidVars: string[] = [];
  const env: Partial<ServerEnvironmentVariables> = {};

  for (const varName of REQUIRED_ENV_VARS) {
    const value = process.env[varName];
    if (!value) {
      missingVars.push(varName);
    } else {
      if (varName === 'API_BASE_URL' && !isHttpUrl(value)) {
        invalidVars.push(`${varName} (invalid URL format: ${value})`);
      } else if (varName === 'NODE_ENV' && !['development', 'production', 'test'].includes(value)) {
        invalidVars.push(`${varName} (must be: development, production, or test)`);
      } else if (varName === 'CREDENTIAL_ENCRYPTION_KEY' && !/^[0-9a-fA-F]{64}$/.test(value)) {
        invalidVars.push(`${varName} (must be a 64-character hex string — 32 bytes)`);
      } else {
        // `value` is validated above (including the NODE_ENV union). Assign via a
        // record view typed to string values rather than escaping with `any`; the
        // dynamic key carries a heterogeneous union, so a plain string isn't
        // directly assignable to the indexed-access type.
        (env as Record<keyof ServerEnvironmentVariables, string>)[varName] = value;
      }
    }
  }

  const errors: string[] = [];
  if (missingVars.length > 0) {
    errors.push(`Missing required environment variables: ${missingVars.join(', ')}`);
  }
  if (invalidVars.length > 0) {
    errors.push(`Invalid environment variables: ${invalidVars.join(', ')}`);
  }

  if (errors.length > 0) {
    throw new Error(
      errors.join('\n') +
        '\n' +
        'Please check your .env file and ensure all required variables are set correctly.'
    );
  }

  return env as ServerEnvironmentVariables;
}

function parseEnvironmentVariables(env: ServerEnvironmentVariables): ParsedServerEnvironment {
  const port = parseInt(env.PORT, 10);

  if (isNaN(port) || port <= 0 || port > 65535) {
    throw new Error(
      `Invalid PORT value: ${env.PORT}. Must be a valid port number between 1 and 65535.`
    );
  }

  return {
    port,
    nodeEnv: env.NODE_ENV,
    apiBaseUrl: env.API_BASE_URL,
  };
}

/**
 * Load, validate, and parse server environment configuration
 */
function loadServerConfig(): ParsedServerEnvironment {
  try {
    const rawEnv = validateEnvironmentVariables();
    const parsedEnv = parseEnvironmentVariables(rawEnv);

    // Log configuration in development
    if (parsedEnv.nodeEnv === 'development') {
      logger.info('📊 Server Configuration Loaded:', {
        port: parsedEnv.port,
        nodeEnv: parsedEnv.nodeEnv,
        apiBaseUrl: parsedEnv.apiBaseUrl,
      });
    }

    return parsedEnv;
  } catch (error) {
    logger.error(`❌ Environment Configuration Error: ${getErrorMessage(error)}`);
    // Re-throw instead of process.exit(1): a config module must never kill the
    // process at import time. The entrypoint (index.ts) lets an uncaught throw
    // crash startup with a clear stack (fail-fast preserved in production),
    // while test/non-production callers can degrade gracefully (see export below).
    throw error instanceof Error ? error : new Error(getErrorMessage(error));
  }
}

// Export the configuration.
// Outside production, loadServerConfig() may fail because .env / required env
// vars are absent (e.g. jest workers where NODE_ENV may not be 'test' at the
// instant this module is first required). Tests that need config mock it; tests
// and tooling that don't should not crash the process. In production we re-throw
// so the entrypoint fails fast on misconfiguration.
function resolveServerConfig(): ParsedServerEnvironment {
  if (process.env.NODE_ENV === 'production') {
    return loadServerConfig();
  }
  try {
    return loadServerConfig();
  } catch {
    // Degrade gracefully outside production rather than aborting the process.
    return {} as ParsedServerEnvironment;
  }
}

export const serverConfig: ParsedServerEnvironment = resolveServerConfig();
