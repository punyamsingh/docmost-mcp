import assert from 'node:assert/strict';
import { test } from 'node:test';
import { doc, makePage, paragraph, text, type EditorNode, type FakePage } from './fake-docmost.ts';
import { startHarness } from './helpers.ts';

const editPage = async (t: Parameters<typeof startHarness>[0], page: FakePage, args: Record<string, unknown>) => {
  const { docmost, server } = await startHarness(t, [page]);
  const result = await server.call('edit_page', { pageId: page.id, ...args });
  return { result, written: docmost.writes().map((write) => write.body) };
};

const markdownWrite = (content: string) => ({ pageId: 'p1', content, operation: 'replace', format: 'markdown' });

const mention: EditorNode = { type: 'mention', attrs: { id: 'mention-1', label: 'Test User', entityType: 'user' } };
const commented = text('commented words', [{ type: 'comment', attrs: { commentId: 'comment-1', resolved: false } }]);

test('text that is not on the page is refused and nothing is written', async (t) => {
  const { result, written } = await editPage(t, makePage({ id: 'p1', markdown: 'alpha' }), { oldText: 'missing', newText: 'x' });
  assert.equal(result.isError, true);
  assert.match(result.text, /oldText not found in Page p1; re-read the page with get_page/);
  assert.deepEqual(written, []);
});

test('text found 3 times is refused without replaceAll', async (t) => {
  const { result, written } = await editPage(t, makePage({ id: 'p1', markdown: 'x and x and x' }), { oldText: 'x', newText: 'y' });
  assert.equal(result.isError, true);
  assert.match(result.text, /oldText appears 3 times; include more surrounding text or set replaceAll/);
  assert.deepEqual(written, []);
});

test('oldText with Markdown syntax rewrites the body, and regex characters match literally', async (t) => {
  const { result, written } = await editPage(t, makePage({ id: 'p1', markdown: 'costs $5.*[x](y)? today' }), {
    oldText: '$5.*[x](y)?',
    newText: '$6',
  });
  assert.equal(JSON.parse(result.text).editedInPlace, false);
  assert.deepEqual(written, [markdownWrite('costs $6 today')]);
});

test('Windows line endings in oldText and newText match the page', async (t) => {
  const { written } = await editPage(t, makePage({ id: 'p1', markdown: 'line one\nline two' }), {
    oldText: 'line one\r\nline two',
    newText: 'one\r\ntwo',
  });
  assert.deepEqual(written, [markdownWrite('one\ntwo')]);
});

test('a table with a header row keeps a single header row when the body is rewritten', async (t) => {
  const exported = '|  |  |\n| --- | --- |\n| a | b |\n| 1 | 2 |\n\nanchor';
  const { written } = await editPage(t, makePage({ id: 'p1', markdown: exported }), { oldText: 'anchor', newText: '**ANCHOR**' });
  assert.deepEqual(written, [markdownWrite('| a | b |\n| --- | --- |\n| 1 | 2 |\n\n**ANCHOR**')]);
});

const richPage = () =>
  makePage({
    id: 'p1',
    markdown: 'Written by @Test User\n\nSome commented words.',
    json: doc(paragraph(text('Written by '), mention), paragraph(text('Some '), commented, text('.'))),
  });

test('oldText that crosses a mention is refused on a page with a comment, naming the mention', async (t) => {
  const { result, written } = await editPage(t, richPage(), { oldText: 'Written by @Test User', newText: 'By @Test User' });
  assert.equal(result.isError, true);
  assert.match(result.text, /cannot carry \(mention, comment\)/);
  assert.match(result.text, /It couldn't be edited in place because oldText crosses a mention\./);
  assert.deepEqual(written, []);
});

test('oldText across a line break rewrites the body of a plain page', async (t) => {
  const page = makePage({
    id: 'p1',
    markdown: 'item 1  \nitem 2',
    json: doc(paragraph(text('item 1'), { type: 'hardBreak' }, text('item 2'))),
  });
  const { result, written } = await editPage(t, page, { oldText: 'item 1  \nitem 2', newText: 'items 1 and 2' });
  assert.equal(JSON.parse(result.text).editedInPlace, false);
  assert.deepEqual(written, [markdownWrite('items 1 and 2')]);
});

test('newText with Markdown formatting is refused on a page with a comment, saying why', async (t) => {
  const { result, written } = await editPage(t, richPage(), { oldText: 'Some', newText: '**Some**' });
  assert.equal(result.isError, true);
  assert.match(result.text, /because newText has Markdown formatting or a line break\./);
  assert.deepEqual(written, []);
});

test('with replaceAll, one match crossing a mention sends the whole edit to the Markdown path', async (t) => {
  const page = makePage({
    id: 'p1',
    markdown: 'ping @Test User now\n\nping @Test User later\n\nping @Test User soon',
    json: doc(
      paragraph(text('ping @Test User now')),
      paragraph(text('ping @Test User later')),
      paragraph(text('ping '), mention, text(' soon')),
    ),
  });
  const { result, written } = await editPage(t, page, { oldText: 'ping @Test User', newText: 'ask @Test User', replaceAll: true });
  assert.equal(result.isError, true);
  assert.match(result.text, /cannot carry \(mention\).*because oldText crosses a mention/);
  assert.deepEqual(written, []);
});
