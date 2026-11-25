import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { EMAIL, PASSWORD, startFakeDocmost, type FakePage } from './fake-docmost.ts';

const SERVER_ENTRY = fileURLToPath(new URL('../build/index.js', import.meta.url));

export const startServer = async (docmostUrl: string, options: { password?: string; cacheHome?: string } = {}) => {
  const cacheHome = options.cacheHome ?? (await mkdtemp(join(tmpdir(), 'docmost-mcp-test-')));
  const client = new Client({ name: 'docmost-mcp-tests', version: '0.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_ENTRY],
      env: {
        DOCMOST_URL: docmostUrl,
        DOCMOST_EMAIL: EMAIL,
        DOCMOST_PASSWORD: options.password ?? PASSWORD,
        XDG_CACHE_HOME: cacheHome,
      },
    }),
  );

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
    const text = result.content.map((item) => (item.type === 'text' ? item.text : '')).join('');
    return { isError: result.isError === true, text };
  };

  return { client, call, cacheHome, close: () => client.close() };
};

export const startHarness = async (t: TestContext, pages: FakePage[]) => {
  const docmost = await startFakeDocmost(pages);
  const server = await startServer(docmost.url);
  t.after(async () => {
    await server.close();
    await docmost.close();
  });
  return { docmost, server };
};

const pageHeaderSchema = z.object({
  id: z.string(),
  updatedAt: z.string().nullable(),
  totalLines: z.number(),
  nextOffset: z.number().nullable(),
});

export const readPageResult = (text: string) => {
  const separator = '\n\n---\n\n';
  const separatorIndex = text.indexOf(separator);
  return {
    header: pageHeaderSchema.parse(JSON.parse(text.slice(0, separatorIndex))),
    body: text.slice(separatorIndex + separator.length),
  };
};
