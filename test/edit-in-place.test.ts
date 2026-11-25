import assert from 'node:assert/strict';
import { test } from 'node:test';
import { doc, makePage, paragraph, text, type EditorMark, type EditorNode, type FakePage } from './fake-docmost.ts';
import { startHarness } from './helpers.ts';

const comment: EditorMark = { type: 'comment', attrs: { commentId: 'comment-1', resolved: false } };
const mention: EditorNode = { type: 'mention', attrs: { id: 'mention-1', label: 'Test User', entityType: 'user' } };
const block = (type: string, attrs: Record<string, unknown>, ...content: EditorNode[]): EditorNode => ({ type, attrs, content });

const richDoc = (sentence = 'The launch is on Monday.', commentedPart: EditorNode[] = [text('Some '), text('commented words', [comment]), text('.')]) =>
  doc(
    block('paragraph', { id: 'para1', indent: 0 }, text('Written by '), mention),
    block('paragraph', { id: 'para2', indent: 0 }, ...commentedPart),
    block('paragraph', { id: 'para3', indent: 0 }, text(sentence)),
  );

const editPage = async (t: Parameters<typeof startHarness>[0], page: FakePage, args: Record<string, unknown>) => {
  const { docmost, server } = await startHarness(t, [page]);
  const result = await server.call('edit_page', { pageId: page.id, ...args });
  return { result, docmost, written: docmost.writes().map((write) => write.body) };
};

const jsonWrite = (content: EditorNode) => ({ pageId: 'p1', content, operation: 'replace', format: 'json' });

test('a sentence on a page with a comment and a mention is edited in place with 2 requests', async (t) => {
  const { result, docmost, written } = await editPage(t, makePage({ id: 'p1', json: richDoc() }), {
    oldText: 'Monday',
    newText: 'Tuesday',
  });
  assert.equal(result.isError, false);
  const summary = JSON.parse(result.text);
  assert.equal(summary.editedInPlace, true);
  assert.equal(summary.replacements, 1);
  assert.deepEqual(written, [jsonWrite(richDoc('The launch is on Tuesday.'))]);
  assert.deepEqual(
    docmost.requests.map((request) => request.endpoint).filter((endpoint) => endpoint !== '/auth/login'),
    ['/pages/info', '/pages/update'],
  );
});

test('words inside a commented phrase keep the comment and its id', async (t) => {
  const { written } = await editPage(t, makePage({ id: 'p1', json: richDoc() }), { oldText: 'commented', newText: 'reviewed' });
  assert.deepEqual(written, [
    jsonWrite(richDoc(undefined, [text('Some '), text('reviewed words', [comment]), text('.')])),
  ]);
});

test('text running from plain words into a comment takes the formatting of its first character', async (t) => {
  const { written } = await editPage(t, makePage({ id: 'p1', json: richDoc() }), {
    oldText: 'Some commented',
    newText: 'A reviewed',
  });
  assert.deepEqual(written, [jsonWrite(richDoc(undefined, [text('A reviewed'), text(' words', [comment]), text('.')]))]);
});

test('block ids and alignment are kept on a plain page', async (t) => {
  const plainDoc = (heading: string) =>
    doc(
      block('heading', { id: 'h1', level: 2, textAlign: 'center' }, text(heading)),
      block('paragraph', { id: 'a1', indent: 1, textAlign: 'right' }, text('Body text')),
    );
  const { written } = await editPage(t, makePage({ id: 'p1', json: plainDoc('Old title') }), { oldText: 'Old', newText: 'New' });
  assert.deepEqual(written, [jsonWrite(plainDoc('New title'))]);
});

test('escaped characters in oldText and newText match their plain form', async (t) => {
  const { written } = await editPage(t, makePage({ id: 'p1', json: doc(paragraph(text('3 * 4 = 12'))) }), {
    oldText: '3 \\* 4',
    newText: '3 \\* 5',
  });
  assert.deepEqual(written, [jsonWrite(doc(paragraph(text('3 * 5 = 12'))))]);
});

test('multi-line text in a code block is matched as written, backslashes included', async (t) => {
  const code = (body: string) => doc(block('codeBlock', { language: 'js' }, text(body)));
  const { written } = await editPage(t, makePage({ id: 'p1', json: code(String.raw`const pattern = /\d+/;
const total = a * b;`) }), {
    oldText: String.raw`const pattern = /\d+/;
const total`,
    newText: String.raw`const digits = /\d+/;
const sum`,
  });
  assert.deepEqual(written, [jsonWrite(code(String.raw`const digits = /\d+/;
const sum = a * b;`))]);
});

test('deleting a whole text node leaves no empty text node behind', async (t) => {
  const page = makePage({
    id: 'p1',
    json: doc(paragraph(text('keep '), text('drop', [{ type: 'bold' }])), paragraph(text('gone'))),
  });
  const { docmost, server } = await startHarness(t, [page]);
  await server.call('edit_page', { pageId: 'p1', oldText: 'drop', newText: '' });
  await server.call('edit_page', { pageId: 'p1', oldText: 'gone', newText: '' });
  assert.deepEqual(docmost.page('p1')?.json, doc(paragraph(text('keep ')), { type: 'paragraph' }));
});

test('replaceAll edits matches in table cells and list items in one write', async (t) => {
  const page = (word: string) =>
    doc(
      { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [paragraph(text(`${word} one`))] }] }] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph(text(`${word} two`))] }] },
      paragraph(text(`${word} three`)),
    );
  const { result, written } = await editPage(t, makePage({ id: 'p1', json: page('TODO') }), {
    oldText: 'TODO',
    newText: 'DONE',
    replaceAll: true,
  });
  assert.equal(JSON.parse(result.text).replacements, 3);
  assert.deepEqual(written, [jsonWrite(page('DONE'))]);
});

test('text that also appears in a link URL counts once and is edited in place', async (t) => {
  const link: EditorMark = { type: 'link', attrs: { href: 'https://example.com/docs' } };
  const page = (mirror: string) => doc(paragraph(text(mirror)), paragraph(text('read this', [link])));
  const { result, written } = await editPage(
    t,
    makePage({ id: 'p1', markdown: 'mirror of example.com/docs\n\n[read this](https://example.com/docs)', json: page('mirror of example.com/docs') }),
    { oldText: 'example.com/docs', newText: 'example.org/docs' },
  );
  assert.equal(result.isError, false);
  assert.deepEqual(written, [jsonWrite(page('mirror of example.org/docs'))]);
});

test('Docmost rejecting the write is reported, and nothing is retried through Markdown', async (t) => {
  const { docmost, server } = await startHarness(t, [makePage({ id: 'p1', json: richDoc() })]);
  docmost.rejectUpdates(400, 'Invalid document');
  const result = await server.call('edit_page', { pageId: 'p1', oldText: 'Monday', newText: 'Tuesday' });
  assert.equal(result.isError, true);
  assert.equal(result.text, 'Docmost /pages/update failed (400): Invalid document');
  assert.deepEqual(
    docmost.writes().map((write) => write.body.format),
    ['json'],
  );
});

test('a # inside a sentence and a stored U+FFFC character are still edited in place', async (t) => {
  const page = (issue: string) => doc(paragraph(text(`see ${issue}`)), paragraph(text('x￼y')));
  const { docmost, server } = await startHarness(t, [makePage({ id: 'p1', json: page('12') })]);
  const first = await server.call('edit_page', { pageId: 'p1', oldText: '12', newText: '#12' });
  const second = await server.call('edit_page', { pageId: 'p1', oldText: 'x￼y', newText: 'z' });
  assert.equal(JSON.parse(first.text).editedInPlace, true);
  assert.equal(JSON.parse(second.text).editedInPlace, true);
  assert.deepEqual(docmost.page('p1')?.json, doc(paragraph(text('see #12')), paragraph(text('z'))));
});
