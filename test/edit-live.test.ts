import assert from 'node:assert/strict';
import { test } from 'node:test';
import { doc, makePage, paragraph, text, type CollabMode } from './fake-docmost.ts';
import { closedPortUrl, openTestEditor, startHarness } from './helpers.ts';

const page = () =>
  makePage({
    id: 'p1',
    markdown: 'Intro line.\n\nThe launch is on Monday.',
    json: doc(paragraph(text('Intro line.')), paragraph(text('The launch is on Monday.'))),
  });

const summaryOf = (result: { isError: boolean; text: string }) => {
  assert.equal(result.isError, false, result.text);
  return JSON.parse(result.text);
};

test('typing someone has not saved yet survives an edit elsewhere on the page', async (t) => {
  const { docmost, server } = await startHarness(t, [page()]);
  const editor = await openTestEditor(t, docmost, 'p1');
  await editor.typeParagraph('Typed but not saved.');

  const summary = summaryOf(await server.call('edit_page', { pageId: 'p1', oldText: 'Monday', newText: 'Tuesday' }));
  assert.equal(summary.liveMerge, true);
  assert.deepEqual(docmost.writes(), []);

  const expected = doc(paragraph(text('Intro line.')), paragraph(text('The launch is on Tuesday.')), paragraph(text('Typed but not saved.')));
  assert.deepEqual(docmost.liveJson('p1'), expected);
  docmost.saveLive('p1');
  assert.deepEqual(docmost.page('p1')?.json, expected);
});

test('typing in the same paragraph, before the match, is kept along with the edit', async (t) => {
  const { docmost, server } = await startHarness(t, [page()]);
  const editor = await openTestEditor(t, docmost, 'p1');
  await editor.typeInto(1, 0, 'Note: ');

  summaryOf(await server.call('edit_page', { pageId: 'p1', oldText: 'Monday', newText: 'Tuesday' }));
  assert.deepEqual(docmost.liveJson('p1'), doc(paragraph(text('Intro line.')), paragraph(text('Note: The launch is on Tuesday.'))));
});

test('text that exists only in unsaved typing can be edited', async (t) => {
  const { docmost, server } = await startHarness(t, [page()]);
  const editor = await openTestEditor(t, docmost, 'p1');
  await editor.typeParagraph('Draft line');

  const summary = summaryOf(await server.call('edit_page', { pageId: 'p1', oldText: 'Draft', newText: 'Final' }));
  assert.equal(summary.editedInPlace, true);
  assert.equal(JSON.stringify(docmost.liveJson('p1')).includes('Final line'), true);
});

test('a match across two text pieces in one paragraph is edited in place', async (t) => {
  const twoPieces = makePage({ id: 'p1', textPieces: 'node', json: doc(paragraph(text('alpha '), text('beta'), text(' end'))) });
  const { docmost, server } = await startHarness(t, [twoPieces]);

  summaryOf(await server.call('edit_page', { pageId: 'p1', oldText: 'alpha beta', newText: 'gamma' }));
  docmost.saveLive('p1');
  assert.deepEqual(docmost.page('p1')?.json, doc(paragraph(text('gamma'), text(' end'))));
});

test('the live-editing connection is closed once the edit returns', async (t) => {
  const { docmost, server } = await startHarness(t, [page()]);
  summaryOf(await server.call('edit_page', { pageId: 'p1', oldText: 'Monday', newText: 'Tuesday' }));
  for (let waited = 0; docmost.connectionCount() > 0 && waited < 2000; waited += 50) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(docmost.connectionCount(), 0);
  assert.equal(docmost.upgradePaths.length, 1);
});

test('a Markdown rewrite is refused while an open editor holds unsaved typing', async (t) => {
  const { docmost, server } = await startHarness(t, [page()]);
  const editor = await openTestEditor(t, docmost, 'p1');
  await editor.typeParagraph('Typed but not saved.');

  const result = await server.call('edit_page', { pageId: 'p1', oldText: 'Monday', newText: '**Tuesday**' });
  assert.equal(result.isError, true);
  assert.match(result.text, /has unsaved edits from an open editor/);
  assert.deepEqual(docmost.writes(), []);
});

const fallbackCases: [string, CollabMode | 'closedPort'][] = [
  ['the collab port is closed', 'closedPort'],
  ['the websocket upgrade gets a 404', 'notFound'],
];

for (const [label, mode] of fallbackCases) {
  test(`edits fall back to the saved page when ${label}, and say why`, async (t) => {
    const collabUrl = mode === 'closedPort' ? await closedPortUrl() : undefined;
    const { docmost, server } = await startHarness(t, [page()], { collabUrl });
    if (mode !== 'closedPort') {
      docmost.setCollabMode(mode);
    }
    const summary = summaryOf(await server.call('edit_page', { pageId: 'p1', oldText: 'Monday', newText: 'Tuesday' }));
    assert.equal(summary.liveMerge, false);
    assert.match(summary.liveMergeSkipped, /live-editing connection closed/);
    assert.deepEqual(docmost.writes().map((write) => write.body.format), ['json']);
  });
}

test('edits fall back after 10 s when the collab server never syncs', async (t) => {
  const { docmost, server } = await startHarness(t, [page()]);
  docmost.setCollabMode('neverSync');
  const summary = summaryOf(await server.call('edit_page', { pageId: 'p1', oldText: 'Monday', newText: 'Tuesday' }));
  assert.equal(summary.liveMerge, false);
  assert.match(summary.liveMergeSkipped, /did not sync within 10 s/);
  assert.equal(docmost.writes().length, 1);
});

const refusedCases: [CollabMode, RegExp][] = [
  ['rejectToken', /Docmost refused the live-editing connection/],
  ['readOnly', /can only view the page/],
];

for (const [mode, message] of refusedCases) {
  test(`a refused live connection (${mode}) is an error and nothing is written`, async (t) => {
    const { docmost, server } = await startHarness(t, [page()]);
    docmost.setCollabMode(mode);
    const result = await server.call('edit_page', { pageId: 'p1', oldText: 'Monday', newText: 'Tuesday' });
    assert.equal(result.isError, true);
    assert.match(result.text, message);
    assert.deepEqual(docmost.writes(), []);
  });
}

test('an edit Docmost never confirms is an error and is not retried over REST', async (t) => {
  const { docmost, server } = await startHarness(t, [page()]);
  docmost.setCollabMode('neverConfirm');
  const result = await server.call('edit_page', { pageId: 'p1', oldText: 'Monday', newText: 'Tuesday' });
  assert.equal(result.isError, true);
  assert.match(result.text, /sent but Docmost did not confirm it within 5 s/);
  assert.deepEqual(docmost.writes(), []);
});

test('DOCMOST_COLLAB_URL sends the websocket to another address', async (t) => {
  const { docmost, server } = await startHarness(t, [page()], { collabUrl: '{docmost}/custom-collab' });
  const summary = summaryOf(await server.call('edit_page', { pageId: 'p1', oldText: 'Monday', newText: 'Tuesday' }));
  assert.equal(summary.liveMerge, true);
  assert.deepEqual(docmost.upgradePaths, ['/custom-collab']);
});

test('a session revoked before the collab token is fetched leads to one re-login', async (t) => {
  const { docmost, server } = await startHarness(t, [page()]);
  let revoked = false;
  docmost.onRequest((request) => {
    if (request.endpoint === '/auth/collab-token' && !revoked) {
      revoked = true;
      docmost.revokeTokens();
    }
  });
  const summary = summaryOf(await server.call('edit_page', { pageId: 'p1', oldText: 'Monday', newText: 'Tuesday' }));
  assert.equal(summary.liveMerge, true);
  assert.equal(docmost.loginCount(), 2);
});
