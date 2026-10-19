import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type DocmostConfig = {
  baseUrl: string;
  email: string;
  password: string;
  sessionFile: string;
};

export const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const envFilePath = join(packageRoot, '.env');

export const loadConfig = (): DocmostConfig => {
  if (existsSync(envFilePath)) {
    process.loadEnvFile(envFilePath);
  }

  const missingVariables = ['DOCMOST_URL', 'DOCMOST_EMAIL', 'DOCMOST_PASSWORD'].filter(
    (variableName) => !process.env[variableName],
  );
  if (missingVariables.length > 0) {
    throw new Error(
      `Missing ${missingVariables.join(', ')}. Set them in the MCP server's env or in ${envFilePath}.`,
    );
  }

  return {
    baseUrl: new URL(process.env.DOCMOST_URL ?? '').origin,
    email: process.env.DOCMOST_EMAIL ?? '',
    password: process.env.DOCMOST_PASSWORD ?? '',
    sessionFile: join(packageRoot, '.session.json'),
  };
};
