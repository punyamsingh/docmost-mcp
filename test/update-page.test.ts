import assert from 'node:assert/strict';
import { test } from 'node:test';
import { doc, makePage, paragraph, START_TIME, text } from './fake-docmost.ts';
import { openTestEditor, startHarness } from './helpers.ts';

const page = () => makePage({ id: 'p1', markdown: 'original body' });

test('a replace with an old expectedUpdatedAt is refused and nothing is written', async (t) => {
  const { docmost, server } = await startHarness(t, [page()]);

  const result = await server.call('update_page', {
    pageId: 'p1',
    markdown: 'new body',
    expectedUpdatedAt: '2026-11-25T09:00:00.000Z',
  });
  assert.equal(result.isError, true);
  assert.match(result.text, new RegExp(`Page changed at ${START_TIME} \\(you read 2026-11-25T09:00:00.000Z\\)`));
  assert.equal(docmost.writes().length, 0);
});

test('the same timestamp written with +00:00 counts as unchanged', async (t) => {
  const { docmost, server } = await startHarness(t, [page()]);

  const result = await server.call('update_page', {
    pageId: 'p1',
    markdown: 'new body',
    expectedUpdatedAt: '2026-11-25T10:00:00.000+00:00',
  });
  assert.equal(result.isError, false);
  assert.equal(docmost.page('p1')?.markdown, 'new body');
  assert.equal(JSON.parse(result.text).updatedAt, docmost.page('p1')?.updatedAt);
});

test('a value that is not a timestamp is refused before any request', async (t) => {
  const { docmost, server } = await startHarness(t, [page()]);

  const result = await server.call('update_page', { pageId: 'p1', markdown: 'new body', expectedUpdatedAt: 'yesterday' });
  assert.equal(result.isError, true);
  assert.match(result.text, /expectedUpdatedAt "yesterday" is not a timestamp/);
  assert.equal(docmost.requests.length, 0);
});

test('an append ignores expectedUpdatedAt', async (t) => {
  const { docmost, server } = await startHarness(t, [page()]);

  const result = await server.call('update_page', {
    pageId: 'p1',
    markdown: 'more',
    operation: 'append',
    expectedUpdatedAt: '2026-11-25T09:00:00.000Z',
  });
  assert.equal(result.isError, false);
  assert.equal(docmost.page('p1')?.markdown, 'original body\n\nmore');
});

test('a replace without expectedUpdatedAt is written', async (t) => {
  const { docmost, server } = await startHarness(t, [page()]);

  const result = await server.call('update_page', { pageId: 'p1', markdown: 'new body' });
  assert.equal(result.isError, false);
  assert.deepEqual(docmost.writes()[0]?.body, {
    pageId: 'p1',
    content: 'new body',
    operation: 'replace',
    format: 'markdown',
  });
});

test('a replace is refused while an open editor holds unsaved typing', async (t) => {
  const { docmost, server } = await startHarness(t, [page()]);
  const editor = await openTestEditor(t, docmost, 'p1');
  await editor.typeParagraph('Typed but not saved.');

  const result = await server.call('update_page', { pageId: 'p1', markdown: 'new body' });
  assert.equal(result.isError, true);
  assert.match(result.text, /Refused: Page p1 has unsaved edits from an open editor/);
  assert.deepEqual(docmost.writes(), []);
});

test('a replace goes ahead with an editor open when nothing is unsaved', async (t) => {
  const { docmost, server } = await startHarness(t, [page()]);
  await openTestEditor(t, docmost, 'p1');

  const result = await server.call('update_page', { pageId: 'p1', markdown: 'new body' });
  assert.equal(result.isError, false);
  assert.deepEqual(docmost.liveJson('p1'), doc(paragraph(text('new body'))));
});

test('append and prepend keep unsaved typing in the live document', async (t) => {
  const { docmost, server } = await startHarness(t, [page()]);
  const editor = await openTestEditor(t, docmost, 'p1');
  await editor.typeParagraph('Typed but not saved.');

  assert.equal((await server.call('update_page', { pageId: 'p1', markdown: 'Appended.', operation: 'append' })).isError, false);
  assert.equal((await server.call('update_page', { pageId: 'p1', markdown: 'Prepended.', operation: 'prepend' })).isError, false);
  const expected = doc(
    paragraph(text('Prepended.')),
    paragraph(text('original body')),
    paragraph(text('Typed but not saved.')),
    paragraph(text('Appended.')),
  );
  assert.deepEqual(docmost.liveJson('p1'), expected);
  docmost.saveLive('p1');
  assert.deepEqual(docmost.page('p1')?.json, expected);
});
