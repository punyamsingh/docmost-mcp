import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { z } from 'zod';
import { EMAIL, PASSWORD, startFakeDocmost, type FakeDocmost, type FakePage } from './fake-docmost.ts';

const SERVER_ENTRY = fileURLToPath(new URL('../build/index.js', import.meta.url));

export const startServer = async (
  docmostUrl: string,
  options: { password?: string; cacheHome?: string; collabUrl?: string; env?: Record<string, string> } = {},
) => {
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
        ...(options.collabUrl ? { DOCMOST_COLLAB_URL: options.collabUrl } : {}),
        ...options.env,
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

export const runHttpServer = (t: TestContext, docmostUrl: string, args: string[], env: Record<string, string> = {}) => {
  const child = spawn(process.execPath, [SERVER_ENTRY, ...args], {
    env: {
      PATH: process.env.PATH ?? '',
      DOCMOST_URL: docmostUrl,
      DOCMOST_EMAIL: EMAIL,
      DOCMOST_PASSWORD: PASSWORD,
      ...env,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  t.after(() => child.kill());
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = once(child, 'exit').then(([code]) => ({ code, stderr }));
  const listening = () =>
    new Promise<string>((resolve, reject) => {
      const check = () => {
        const url = /listening on (\S+)/.exec(stderr)?.[1];
        if (url) {
          resolve(url);
        }
      };
      child.stderr.on('data', check);
      check();
      void exited.then(() => reject(new Error(`Server exited: ${stderr}`)));
    });
  return { listening, exited };
};

export const connectHttpClient = async (t: TestContext, url: string, token: string) => {
  const client = new Client({ name: 'docmost-mcp-tests', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  );
  t.after(() => client.close());
  return client;
};

export const startHarness = async (
  t: TestContext,
  pages: FakePage[],
  options: { collabUrl?: string; env?: Record<string, string> } & Parameters<typeof startFakeDocmost>[1] = {},
) => {
  const { collabUrl, env, ...fakeOptions } = options;
  const docmost = await startFakeDocmost(pages, fakeOptions);
  const server = await startServer(docmost.url, { collabUrl: collabUrl?.replace('{docmost}', docmost.url), env });
  t.after(async () => {
    await server.close();
    await docmost.close();
  });
  return { docmost, server };
};

export const closedPortUrl = async () => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (address === null || typeof address === 'string') {
    throw new Error('No TCP port for the closed-port probe.');
  }
  return `ws://127.0.0.1:${address.port}/collab`;
};

export const openTestEditor = async (t: TestContext, docmost: FakeDocmost, pageId: string) => {
  const ydoc = new Y.Doc();
  const provider = await new Promise<HocuspocusProvider>((resolve, reject) => {
    const instance: HocuspocusProvider = new HocuspocusProvider({
      url: `${docmost.url.replace(/^http/, 'ws')}/collab`,
      name: `page.${pageId}`,
      document: ydoc,
      token: docmost.issueCollabToken(),
      onSynced: ({ state }) => {
        if (state) {
          resolve(instance);
        }
      },
      onAuthenticationFailed: ({ reason }) => reject(new Error(reason)),
    });
  });
  t.after(() => provider.destroy());
  const fragment = ydoc.getXmlFragment('default');
  const sent = () =>
    new Promise<void>((resolve) => {
      const check = () => (provider.unsyncedChanges === 0 ? resolve() : setTimeout(check, 10));
      check();
    });
  return {
    typeParagraph: async (value: string) => {
      const element = new Y.XmlElement('paragraph');
      fragment.push([element]);
      const run = new Y.XmlText();
      element.push([run]);
      run.insert(0, value);
      await sent();
    },
    typeInto: async (blockIndex: number, offset: number, value: string) => {
      const element = fragment.get(blockIndex);
      const run =
        element instanceof Y.XmlElement ? element.toArray().find((child) => child instanceof Y.XmlText) : undefined;
      if (!(run instanceof Y.XmlText)) {
        throw new Error(`Block ${blockIndex} has no text to type into.`);
      }
      run.insert(offset, value);
      await sent();
    },
    close: () => provider.destroy(),
  };
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
