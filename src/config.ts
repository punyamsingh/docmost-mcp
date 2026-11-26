import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export type DocmostConfig = {
  baseUrl: string;
  email: string;
  password: string;
  sessionFile: string;
  collabUrl: string;
};

export const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const envFilePath = join(packageRoot, '.env');

const cacheDirectory = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'docmost-mcp');

const loadEnvFile = () => {
  if (existsSync(envFilePath)) {
    process.loadEnvFile(envFilePath);
  }
};

export const loadConfig = (): DocmostConfig => {
  loadEnvFile();

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
  const collabUrl = new URL(process.env.DOCMOST_COLLAB_URL || `${baseUrl}/collab`);
  collabUrl.protocol = collabUrl.protocol.replace(/^http/, 'ws');

  return {
    baseUrl,
    email,
    password: process.env.DOCMOST_PASSWORD ?? '',
    sessionFile: join(cacheDirectory, `session-${accountKey}.json`),
    collabUrl: collabUrl.toString(),
  };
};

export type HttpConfig = {
  host: string;
  port: number;
  token: string | undefined;
};

export const isLoopbackHost = (host: string) =>
  host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));

export const loadHttpConfig = (args: string[]): HttpConfig | undefined => {
  loadEnvFile();
  const { values } = parseArgs({
    args,
    options: { http: { type: 'boolean' }, port: { type: 'string' }, host: { type: 'string' } },
  });
  const portText = values.port ?? process.env.DOCMOST_MCP_PORT;
  if (!values.http && portText === undefined) {
    return undefined;
  }

  const port = Number(portText ?? '3000');
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port ${portText}; pass --port or DOCMOST_MCP_PORT as a number from 0 to 65535.`);
  }
  const host = values.host ?? (process.env.DOCMOST_MCP_HOST || '127.0.0.1');
  const token = process.env.DOCMOST_MCP_TOKEN || undefined;
  if (!isLoopbackHost(host) && token === undefined) {
    throw new Error(`Set DOCMOST_MCP_TOKEN to serve on ${host}; without a token the server only binds to loopback.`);
  }
  return { host, port, token };
};
