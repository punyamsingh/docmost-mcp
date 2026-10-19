import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
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

const cacheDirectory = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'docmost-mcp');

export const loadConfig = (): DocmostConfig => {
  if (existsSync(envFilePath)) {
    process.loadEnvFile(envFilePath);
  }

  const missingVariables = ['DOCMOST_URL', 'DOCMOST_EMAIL', 'DOCMOST_PASSWORD'].filter(
    (variableName) => !process.env[variableName],
  );
  if (missingVariables.length > 0) {
    throw new Error(
      `Missing ${missingVariables.join(', ')}. Pass them as env vars in your MCP client config, or put them in ${envFilePath}.`,
    );
  }

  const baseUrl = new URL(process.env.DOCMOST_URL ?? '').origin;
  const email = process.env.DOCMOST_EMAIL ?? '';
  const accountKey = createHash('sha256').update(`${baseUrl}\n${email}`).digest('hex').slice(0, 16);

  return {
    baseUrl,
    email,
    password: process.env.DOCMOST_PASSWORD ?? '',
    sessionFile: join(cacheDirectory, `session-${accountKey}.json`),
  };
};
