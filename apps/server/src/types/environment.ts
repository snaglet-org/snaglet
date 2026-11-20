/**
 * Server environment variable types and interfaces
 */

export interface ServerEnvironmentVariables {
  PORT: string;
  NODE_ENV: 'development' | 'production' | 'test';
  API_BASE_URL: string;
  CREDENTIAL_ENCRYPTION_KEY: string;
}

export interface ParsedServerEnvironment {
  port: number;
  nodeEnv: 'development' | 'production' | 'test';
  apiBaseUrl: string;
}

/**
 * Required environment variables for server startup
 */
export const REQUIRED_ENV_VARS: (keyof ServerEnvironmentVariables)[] = [
  'PORT',
  'NODE_ENV',
  'API_BASE_URL',
  'CREDENTIAL_ENCRYPTION_KEY',
];
