import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACCOUNT, doc, makePage, paragraph, text, type EditorNode } from './fake-docmost.ts';
import { startHarness } from './helpers.ts';

const resultOf = (result: { isError: boolean; text: string }) => {
  assert.equal(result.isError, false, result.text);
  return JSON.parse(result.text);
};

const readRevision = (result: { isError: boolean; text: string }) => {
  assert.equal(result.isError, false, result.text);
  const separator = '\n\n---\n\n';
  const separatorIndex = result.text.indexOf(separator);
  return { header: JSON.parse(result.text.slice(0, separatorIndex)), body: result.text.slice(separatorIndex + separator.length) };
};

const revision = (id: string, createdAt: string, ...content: EditorNode[]) => ({
  id,
  title: `Title ${id}`,
  content: doc(...content),
  createdAt,
  authorId: ACCOUNT.id,
});

const node = (type: string, attrs: Record<string, unknown>, ...content: EditorNode[]): EditorNode => ({
  type,
  attrs,
  ...(content.length > 0 ? { content } : {}),
});

const block = (type: string, ...content: EditorNode[]): EditorNode => ({ type, content });

test('lists page history newest first and pages through it with nextCursor', async (t) => {
  const history = ['h1', 'h2', 'h3'].map((id, index) => revision(id, `2026-11-2${index}T10:00:00.000Z`, paragraph(text(id))));
  const { docmost, server } = await startHarness(t, [makePage({ id: 'p1', history })]);

  const first = resultOf(await server.call('list_page_history', { pageId: `${docmost.url}/p/page-Sp1`, limit: 2 }));
  assert.deepEqual(first.revisions[0], {
    historyId: 'h3',
    title: 'Title h3',
    author: ACCOUNT.name,
    contributors: [ACCOUNT.name],
    createdAt: '2026-11-22T10:00:00.000Z',
  });
  assert.deepEqual(
    first.revisions.map((entry: { historyId: string }) => entry.historyId),
    ['h3', 'h2'],
  );
  assert.equal(typeof first.nextCursor, 'string');

  const rest = resultOf(await server.call('list_page_history', { pageId: 'p1', limit: 2, cursor: first.nextCursor }));
  assert.deepEqual(
    rest.revisions.map((entry: { historyId: string }) => entry.historyId),
    ['h1'],
  );
  assert.equal(rest.nextCursor, null);
  assert.deepEqual(
    docmost.requests.filter((entry) => entry.endpoint === '/pages/history').map((entry) => entry.body),
    [
      { pageId: 'Sp1', limit: 2 },
      { pageId: 'p1', limit: 2, cursor: first.nextCursor },
    ],
  );
});

test('reads a revision as Markdown converted from its editor JSON', async (t) => {
  const content = [
    node('heading', { level: 2 }, text('Plan')),
    paragraph(
      text('Ship '),
      text('soon', [{ type: 'bold' }]),
      text(' with '),
      text('docs', [{ type: 'link', attrs: { href: 'https://example.test/docs' } }]),
      text(', '),
      node('mention', { label: 'Test Account', entityType: 'user' }),
      text(' and '),
      text('a_b*c', [{ type: 'code' }]),
      text(' but 2*3_4.'),
    ),
    block(
      'bulletList',
      block('listItem', paragraph(text('one')), block('bulletList', block('listItem', paragraph(text('nested'))))),
      block('listItem', paragraph(text('two'))),
    ),
    node('orderedList', { start: 3 }, block('listItem', paragraph(text('third'))), block('listItem', paragraph(text('fourth')))),
    block('taskList', node('taskItem', { checked: true }, paragraph(text('done'))), node('taskItem', { checked: false }, paragraph(text('todo')))),
    block('blockquote', paragraph(text('quoted'))),
    node('codeBlock', { language: 'ts' }, text('const a = 1;\nconst b = 2;')),
    block(
      'table',
      block('tableRow', block('tableHeader', paragraph(text('Name'))), block('tableHeader', paragraph(text('Value')))),
      block('tableRow', block('tableCell', paragraph(text('a|b'))), block('tableCell', paragraph(text('1')))),
    ),
    node('callout', { type: 'warning' }, paragraph(text('careful'))),
    node('image', { src: '/files/diagram.png', alt: 'diagram' }),
    { type: 'horizontalRule' },
  ];
  const { docmost, server } = await startHarness(t, [
    makePage({ id: 'p1', history: [revision('h1', '2026-11-20T10:00:00.000Z', ...content)] }),
  ]);

  const { header, body } = readRevision(await server.call('get_page_revision', { historyId: 'h1' }));
  assert.deepEqual(header, {
    historyId: 'h1',
    pageId: 'p1',
    title: 'Title h1',
    author: ACCOUNT.name,
    createdAt: '2026-11-20T10:00:00.000Z',
    url: `${docmost.url}/p/Sp1`,
    totalLines: body.split('\n').length,
    nextOffset: null,
  });
  assert.equal(
    body,
    [
      '## Plan',
      '',
      'Ship **soon** with [docs](https://example.test/docs), @Test Account and `a_b*c` but 2\\*3\\_4.',
      '',
      '- one',
      '  - nested',
      '- two',
      '',
      '3. third',
      '4. fourth',
      '',
      '- [x] done',
      '- [ ] todo',
      '',
      '> quoted',
      '',
      '```ts',
      'const a = 1;',
      'const b = 2;',
      '```',
      '',
      '| Name | Value |',
      '| --- | --- |',
      '| a\\|b | 1 |',
      '',
      ':::warning',
      'careful',
      ':::',
      '',
      '![diagram](/files/diagram.png)',
      '',
      '---',
    ].join('\n'),
  );
});

test('windows a long revision like get_page', async (t) => {
  const lines = Array.from({ length: 30 }, (_, index) => paragraph(text(`line ${index + 1}`)));
  const { server } = await startHarness(t, [makePage({ id: 'p1', history: [revision('h1', '2026-11-20T10:00:00.000Z', ...lines)] })]);

  const window = readRevision(await server.call('get_page_revision', { historyId: 'h1', offset: 5, limit: 1 }));
  assert.equal(window.header.totalLines, 59);
  assert.equal(window.header.nextOffset, 6);
  assert.equal(window.body, 'line 3\n\n[lines 5–5 of 59; call get_page_revision with offset 6 for more]');
});

test('an unknown revision id comes back as a tool error', async (t) => {
  const { server } = await startHarness(t, [makePage({ id: 'p1' })]);

  const result = await server.call('get_page_revision', { historyId: 'missing' });
  assert.equal(result.isError, true);
  assert.match(result.text, /Page history not found/);
});

test('lists recently updated pages, optionally within one space', async (t) => {
  const { docmost, server } = await startHarness(t, [
    makePage({ id: 'old', updatedAt: '2026-11-01T10:00:00.000Z' }),
    makePage({ id: 'new', updatedAt: '2026-11-25T10:00:00.000Z', parentPageId: 'old' }),
    makePage({ id: 'other', updatedAt: '2026-11-20T10:00:00.000Z', spaceId: 'space-2' }),
    makePage({ id: 'trashed', updatedAt: '2026-11-26T10:00:00.000Z', deletedAt: '2026-11-26T10:00:00.000Z' }),
  ]);

  const all = resultOf(await server.call('list_recent_pages', { limit: 2 }));
  assert.deepEqual(all.pages[0], {
    id: 'new',
    slugId: 'Snew',
    title: 'Page new',
    spaceId: 'space-1',
    space: 'General',
    parentPageId: 'old',
    updatedAt: '2026-11-25T10:00:00.000Z',
    lastUpdatedBy: ACCOUNT.name,
    url: `${docmost.url}/p/Snew`,
  });
  assert.deepEqual(
    all.pages.map((page: { id: string }) => page.id),
    ['new', 'other'],
  );
  assert.equal(typeof all.nextCursor, 'string');

  const inSpace = resultOf(await server.call('list_recent_pages', { spaceId: 'space-1' }));
  assert.deepEqual(
    inSpace.pages.map((page: { id: string }) => page.id),
    ['new', 'old'],
  );
  assert.equal(inSpace.nextCursor, null);
});

test('returns the breadcrumb path from the space root down to the page', async (t) => {
  const { docmost, server } = await startHarness(t, [
    makePage({ id: 'root' }),
    makePage({ id: 'mid', parentPageId: 'root' }),
    makePage({ id: 'leaf', parentPageId: 'mid' }),
    makePage({ id: 'trashedChild', parentPageId: 'leaf', deletedAt: '2026-11-26T10:00:00.000Z' }),
  ]);

  const result = resultOf(await server.call('get_page_breadcrumbs', { pageId: `${docmost.url}/p/leaf-title-Sleaf` }));
  assert.deepEqual(result.path, [
    { id: 'root', slugId: 'Sroot', title: 'Page root', hasChildren: true, url: `${docmost.url}/p/Sroot` },
    { id: 'mid', slugId: 'Smid', title: 'Page mid', hasChildren: true, url: `${docmost.url}/p/Smid` },
    { id: 'leaf', slugId: 'Sleaf', title: 'Page leaf', hasChildren: false, url: `${docmost.url}/p/Sleaf` },
  ]);
});
