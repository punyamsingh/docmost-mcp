import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startHarness } from './helpers.ts';

test('lists the 7 tools with their annotations and sends the instructions', async (t) => {
  const { docmost, server } = await startHarness(t, []);
  const { tools } = await server.client.listTools();
  const readOnly = { readOnlyHint: true, openWorldHint: true };
  const write = { readOnlyHint: false, idempotentHint: false, openWorldHint: true };

  assert.deepEqual(Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations])), {
    list_spaces: readOnly,
    list_pages: readOnly,
    search_pages: readOnly,
    get_page: readOnly,
    create_page: { ...write, destructiveHint: false },
    update_page: { ...write, destructiveHint: true },
    edit_page: { ...write, destructiveHint: true },
  });
  assert.match(server.client.getInstructions() ?? '', /Read a page with get_page before changing it/);
  assert.equal(docmost.requests.length, 0);
});
