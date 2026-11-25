import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makePage, type EditorNode } from './fake-docmost.ts';
import { startHarness } from './helpers.ts';

const text = (value: string, marks?: EditorNode['marks']): EditorNode => ({ type: 'text', text: value, ...(marks ? { marks } : {}) });
const paragraph = (...content: EditorNode[]): EditorNode => ({ type: 'paragraph', content });
const doc = (...content: EditorNode[]): EditorNode => ({ type: 'doc', content });

const mention: EditorNode = {
  type: 'mention',
  attrs: { id: 'mention-1', label: 'Test User', entityType: 'user', entityId: 'user-1' },
};
const commented = text('commented words', [{ type: 'comment', attrs: { commentId: 'comment-1', resolved: false } }]);
const richPage = () =>
  makePage({
    id: 'p1',
    markdown: 'Written by @Test User\n\nSome commented words.',
    json: doc(paragraph(text('Written by '), mention), paragraph(text('Some '), commented, text('.'))),
  });

test('a replace on a page with a mention and a comment is refused and nothing is written', async (t) => {
  const { docmost, server } = await startHarness(t, [richPage()]);

  const result = await server.call('update_page', { pageId: 'p1', markdown: 'new body' });
  assert.equal(result.isError, true);
  assert.equal(
    result.text,
    'Refused: Page p1 holds content Markdown cannot carry (mention, comment), which rewriting the body would delete. Use append or prepend, or edit it in Docmost.',
  );
  assert.equal(docmost.writes().length, 0);
});

test('append and title-only updates still go through on that page', async (t) => {
  const { docmost, server } = await startHarness(t, [richPage()]);

  assert.equal((await server.call('update_page', { pageId: 'p1', markdown: 'more', operation: 'append' })).isError, false);
  assert.equal((await server.call('update_page', { pageId: 'p1', title: 'Renamed' })).isError, false);
  assert.deepEqual(
    docmost.writes().map((write) => write.body.operation ?? 'title only'),
    ['append', 'title only'],
  );
});

const mergedCellTable: EditorNode = {
  type: 'table',
  content: [{ type: 'tableRow', content: [{ type: 'tableCell', attrs: { colspan: 2, rowspan: 1 }, content: [paragraph(text('wide'))] }] }],
};

const lossyCases: [string, EditorNode][] = [
  ['mention', paragraph(mention)],
  ['drawio', { type: 'drawio', attrs: { src: '/api/files/a/diagram.svg' } }],
  ['excalidraw', { type: 'excalidraw', attrs: { src: '/api/files/b/diagram.svg' } }],
  ['embed', { type: 'embed', attrs: { src: 'https://www.youtube.com/embed/x', provider: 'youtube' } }],
  ['attachment', { type: 'attachment', attrs: { url: '/api/files/c/notes.txt', name: 'notes.txt' } }],
  ['comment', paragraph(commented)],
  ['highlight', paragraph(text('highlighted', [{ type: 'highlight', attrs: { color: '#fef08a' } }]))],
  ['textStyle', paragraph(text('red', [{ type: 'textStyle', attrs: { color: '#dc2626' } }]))],
  ['merged table cell', mergedCellTable],
];

for (const [lostContent, block] of lossyCases) {
  test(`a replace is refused when the page holds a ${lostContent}`, async (t) => {
    const { docmost, server } = await startHarness(t, [
      makePage({ id: 'p1', markdown: 'body', json: doc(paragraph(text('Intro')), block) }),
    ]);

    const result = await server.call('update_page', { pageId: 'p1', markdown: 'new body' });
    assert.equal(result.isError, true);
    assert.match(result.text, new RegExp(`cannot carry \\(${lostContent}\\)`));
    assert.equal(docmost.writes().length, 0);
  });
}

test('a replace goes through when every block and mark survives Markdown', async (t) => {
  const safeDoc = doc(
    { type: 'heading', attrs: { level: 2 }, content: [text('Heading')] },
    { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph(text('item', [{ type: 'bold' }]))] }] },
    { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', attrs: { colspan: 1, rowspan: 1 }, content: [paragraph(text('a'))] }] }] },
    { type: 'callout', attrs: { type: 'info' }, content: [paragraph(text('note'))] },
    { type: 'codeBlock', attrs: { language: 'mermaid' }, content: [text('flowchart LR')] },
    { type: 'image', attrs: { src: 'https://example.com/a.png' } },
    paragraph(text('a link', [{ type: 'link', attrs: { href: 'https://example.com' } }])),
  );
  const { docmost, server } = await startHarness(t, [makePage({ id: 'p1', markdown: 'body', json: safeDoc })]);

  const result = await server.call('update_page', { pageId: 'p1', markdown: 'new body' });
  assert.equal(result.isError, false);
  assert.equal(docmost.writes().length, 1);
});
