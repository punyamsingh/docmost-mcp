import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { test } from 'node:test';
import { connectHttpClient, runHttpServer, startHarness } from './helpers.ts';

const statusWithHost = (url: string, host: string, token: string) =>
  new Promise<number | undefined>((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    request(url, {
      method: 'POST',
      headers: {
        Host: host,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
    })
      .on('response', (response) => {
        response.resume();
        resolve(response.statusCode);
      })
      .on('error', reject)
      .end(body);
  });

test('lists the 24 tools with their annotations and sends the instructions', async (t) => {
  const { docmost, server } = await startHarness(t, []);
  const { tools } = await server.client.listTools();
  const readOnly = { readOnlyHint: true, openWorldHint: true };
  const write = { readOnlyHint: false, idempotentHint: false, openWorldHint: true };

  assert.deepEqual(Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations])), {
    list_spaces: readOnly,
    list_pages: readOnly,
    search_pages: readOnly,
    get_page: readOnly,
    list_page_history: readOnly,
    get_page_revision: readOnly,
    restore_page_revision: { ...write, destructiveHint: true, idempotentHint: true },
    list_recent_pages: readOnly,
    get_page_breadcrumbs: readOnly,
    create_page: { ...write, destructiveHint: false },
    update_page: { ...write, destructiveHint: true },
    edit_page: { ...write, destructiveHint: true },
    move_page: { ...write, destructiveHint: false, idempotentHint: true },
    delete_page: { ...write, destructiveHint: true, idempotentHint: true },
    restore_page: { ...write, destructiveHint: false },
    list_trash: readOnly,
    duplicate_page: { ...write, destructiveHint: false },
    list_comments: readOnly,
    add_comment: { ...write, destructiveHint: false },
    reply_to_comment: { ...write, destructiveHint: false },
    edit_comment: { ...write, destructiveHint: true, idempotentHint: true },
    delete_comment: { ...write, destructiveHint: true },
    resolve_comment: { ...write, destructiveHint: false, idempotentHint: true },
    upload_attachment: { ...write, destructiveHint: false },
  });
  assert.match(server.client.getInstructions() ?? '', /Read a page with get_page before changing it/);
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(server.client.getServerVersion()?.version, packageJson.version);
  assert.equal(docmost.requests.length, 0);
});

test('serves the same tools over Streamable HTTP with --http, behind the bearer token', async (t) => {
  const { docmost, server } = await startHarness(t, []);
  const token = 'test-token';
  const url = await runHttpServer(t, docmost.url, ['--http', '--port', '0'], { DOCMOST_MCP_TOKEN: token }).listening();
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

  const httpClient = await connectHttpClient(t, url, token);
  const toolNames = async (client: typeof httpClient) => (await client.listTools()).tools.map((tool) => tool.name);
  assert.deepEqual(await toolNames(httpClient), await toolNames(server.client));
  assert.match(httpClient.getInstructions() ?? '', /Read a page with get_page before changing it/);

  assert.equal((await fetch(url, { method: 'POST' })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await fetch(url.replace('/mcp', '/other'))).status, 404);
  assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).status, 405);
  assert.equal(await statusWithHost(url, 'attacker.example', token), 403);
  assert.equal(docmost.requests.length, 0);
});

test('refuses to bind beyond loopback without DOCMOST_MCP_TOKEN', async (t) => {
  const { exited } = runHttpServer(t, 'http://127.0.0.1:9', ['--http', '--port', '0', '--host', '0.0.0.0']);
  const { code, stderr } = await exited;
  assert.notEqual(code, 0);
  assert.match(stderr, /Set DOCMOST_MCP_TOKEN to serve on 0\.0\.0\.0/);
});
