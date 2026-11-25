import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makePage, startFakeDocmost } from './fake-docmost.ts';
import { startHarness, startServer } from './helpers.ts';

const callFiveTimes = (call: () => Promise<{ isError: boolean }>) => Promise.all(Array.from({ length: 5 }, call));

test('parallel calls share one login, and one re-login after the token is revoked', async (t) => {
  const { docmost, server } = await startHarness(t, [makePage({ id: 'p1', markdown: 'hello' })]);

  const firstCalls = await callFiveTimes(() => server.call('get_page', { pageId: 'p1' }));
  assert.ok(firstCalls.every((result) => !result.isError));
  assert.equal(docmost.loginCount(), 1);

  docmost.revokeTokens();
  const secondCalls = await callFiveTimes(() => server.call('get_page', { pageId: 'p1' }));
  assert.ok(secondCalls.every((result) => !result.isError));
  assert.equal(docmost.loginCount(), 2);
});

test('a failed login is not cached, and the right password then logs in', async (t) => {
  const docmost = await startFakeDocmost([]);
  const wrongServer = await startServer(docmost.url, { password: 'wrong-password' });
  const rightServer = await startServer(docmost.url, { cacheHome: wrongServer.cacheHome });
  t.after(async () => {
    await wrongServer.close();
    await rightServer.close();
    await docmost.close();
  });

  for (const attempt of [1, 2]) {
    const result = await wrongServer.call('list_spaces');
    assert.equal(result.isError, true);
    assert.match(result.text, /Docmost login failed \(401\): Email or password does not match/);
    assert.equal(docmost.loginCount(), attempt);
  }

  const result = await rightServer.call('list_spaces');
  assert.equal(result.isError, false);
  assert.match(result.text, /General/);
  assert.equal(docmost.loginCount(), 3);
});
