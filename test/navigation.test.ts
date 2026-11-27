import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ACCOUNT,
  commentMark,
  doc,
  EMAIL,
  makePage,
  paragraph,
  START_TIME,
  text,
  type EditorNode,
  type FakePage,
  WORKSPACE,
} from './fake-docmost.ts';
import { closedPortUrl, openTestEditor, startHarness } from './helpers.ts';

const resultOf = (result: { isError: boolean; text: string }) => {
  assert.equal(result.isError, false, result.text);
  return JSON.parse(result.text);
};

const readRevision = (result: { isError: boolean; text: string }) => {
  assert.equal(result.isError, false, result.text);
  const separator = '\n\n---\n\n';
  const separatorIndex = result.text.indexOf(separator);
  return {
    header: JSON.parse(result.text.slice(0, separatorIndex)),
    body: result.text.slice(separatorIndex + separator.length),
  };
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
  const history = ['h1', 'h2', 'h3'].map((id, index) =>
    revision(id, `2026-11-2${index}T10:00:00.000Z`, paragraph(text(id))),
  );
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
    node(
      'orderedList',
      { start: 3 },
      block('listItem', paragraph(text('third'))),
      block('listItem', paragraph(text('fourth'))),
    ),
    block(
      'taskList',
      node('taskItem', { checked: true }, paragraph(text('done'))),
      node('taskItem', { checked: false }, paragraph(text('todo'))),
    ),
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
  const { server } = await startHarness(t, [
    makePage({ id: 'p1', history: [revision('h1', '2026-11-20T10:00:00.000Z', ...lines)] }),
  ]);

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

const restoreFixture = (fields: Partial<FakePage> = {}) => {
  const revisionContent = [
    paragraph(
      text('Old intro, still with ', [commentMark('kept')]),
      node('mention', { id: ACCOUNT.id, label: ACCOUNT.name, entityType: 'user' }),
    ),
    node('drawio', { src: '/files/flow.drawio.svg', title: 'flow' }),
  ];
  return makePage({
    id: 'p1',
    title: 'Current title',
    json: doc(
      paragraph(text('New intro', [commentMark('kept')])),
      paragraph(text('Added later', [commentMark('newer')])),
    ),
    history: [revision('h1', '2026-11-20T10:00:00.000Z', ...revisionContent)],
    ...fields,
  });
};

test('restores a revision as editor JSON into the open editor, keeping diagrams and mentions, and counts dropped highlights', async (t) => {
  const { docmost, server } = await startHarness(t, [restoreFixture()]);
  await openTestEditor(t, docmost, 'p1');

  const result = resultOf(
    await server.call('restore_page_revision', { historyId: 'h1', expectedUpdatedAt: START_TIME }),
  );
  assert.deepEqual(result.restoredFrom, {
    historyId: 'h1',
    createdAt: '2026-11-20T10:00:00.000Z',
    author: ACCOUNT.name,
  });
  assert.equal(result.title, 'Title h1');
  assert.equal(result.commentHighlightsRemoved, 1);
  assert.equal(result.typingCheckSkipped, undefined);

  const revisionContent = docmost.page('p1')?.history?.[0]?.content;
  assert.deepEqual(
    docmost.writes().map((write) => write.body),
    [{ pageId: 'p1', title: 'Title h1', content: revisionContent, operation: 'replace', format: 'json' }],
  );
  assert.deepEqual(docmost.liveJson('p1'), revisionContent);
});

test('a restore is refused when the page changed since expectedUpdatedAt', async (t) => {
  const { docmost, server } = await startHarness(t, [restoreFixture({ updatedAt: '2026-11-26T09:00:00.000Z' })]);

  const result = await server.call('restore_page_revision', { historyId: 'h1', expectedUpdatedAt: START_TIME });
  assert.equal(result.isError, true);
  assert.match(result.text, /Page changed at 2026-11-26T09:00:00.000Z/);
  assert.deepEqual(docmost.writes(), []);
});

test('a restore is refused while an open editor holds unsaved typing', async (t) => {
  const { docmost, server } = await startHarness(t, [restoreFixture()]);
  const editor = await openTestEditor(t, docmost, 'p1');
  await editor.typeParagraph('Typed but not saved.');

  const result = await server.call('restore_page_revision', { historyId: 'h1' });
  assert.equal(result.isError, true);
  assert.match(result.text, /Refused: Current title has unsaved edits from an open editor/);
  assert.deepEqual(docmost.writes(), []);
});

test('a restore goes through the saved page when the live document is unreachable, and says why', async (t) => {
  const { docmost, server } = await startHarness(t, [restoreFixture()], { collabUrl: await closedPortUrl() });

  const result = resultOf(await server.call('restore_page_revision', { historyId: 'h1' }));
  assert.match(result.typingCheckSkipped, /live-editing connection (closed|could not be opened)/);
  assert.equal(result.commentHighlightsRemoved, 1);
  assert.deepEqual(docmost.page('p1')?.json, docmost.page('p1')?.history?.[0]?.content);
});

test('a restore is refused for a page in the trash', async (t) => {
  const { docmost, server } = await startHarness(t, [restoreFixture({ deletedAt: '2026-11-26T10:00:00.000Z' })]);

  const result = await server.call('restore_page_revision', { historyId: 'h1' });
  assert.equal(result.isError, true);
  assert.match(result.text, /Current title is in the trash; bring it back with restore_page first/);
  assert.deepEqual(docmost.writes(), []);
});

test('returns the logged-in user with their role, workspace and member count', async (t) => {
  const { server } = await startHarness(t, [], { members: [{ id: 'user-2', name: 'Priya Sharma' }] });

  assert.deepEqual(resultOf(await server.call('get_current_user')), {
    id: ACCOUNT.id,
    name: ACCOUNT.name,
    email: EMAIL,
    role: 'owner',
    workspaceId: WORKSPACE.id,
    workspace: WORKSPACE.name,
    memberCount: 2,
  });
});

test('lists workspace members matching a query, with emails, roles and nextCursor', async (t) => {
  const { docmost, server } = await startHarness(t, [], {
    members: [
      { id: 'user-2', name: 'Priya Sharma', email: 'priya@example.test', role: 'admin' },
      { id: 'user-3', name: 'Priyanka Rao' },
      { id: 'user-4', name: 'Sam Lee' },
    ],
  });

  const first = resultOf(await server.call('list_workspace_members', { query: 'PRIY', limit: 1 }));
  assert.deepEqual(first.members, [{ id: 'user-2', name: 'Priya Sharma', email: 'priya@example.test', role: 'admin' }]);
  assert.equal(typeof first.nextCursor, 'string');

  const rest = resultOf(
    await server.call('list_workspace_members', { query: 'PRIY', limit: 1, cursor: first.nextCursor }),
  );
  assert.deepEqual(rest, {
    members: [{ id: 'user-3', name: 'Priyanka Rao', email: 'user-3@example.test', role: 'member' }],
    nextCursor: null,
  });
  assert.deepEqual(
    docmost.requests.filter((entry) => entry.endpoint === '/workspace/members').map((entry) => entry.body),
    [
      { query: 'PRIY', limit: 1 },
      { query: 'PRIY', limit: 1, cursor: first.nextCursor },
    ],
  );
});

test('lists the pages linking to a page, then the pages it links to', async (t) => {
  const { docmost, server } = await startHarness(t, [
    makePage({ id: 'hub', links: ['spoke'] }),
    makePage({ id: 'spoke', links: ['hub'], updatedAt: '2026-11-26T10:00:00.000Z' }),
    makePage({ id: 'older', links: ['hub'], spaceId: 'space-2', updatedAt: '2026-11-01T10:00:00.000Z' }),
    makePage({ id: 'trashed', links: ['hub'], deletedAt: '2026-11-26T10:00:00.000Z' }),
  ]);

  const incoming = resultOf(
    await server.call('get_backlinks', { pageId: `${docmost.url}/p/Shub`, direction: 'incoming' }),
  );
  assert.deepEqual(incoming, {
    pages: [
      {
        id: 'spoke',
        slugId: 'Sspoke',
        title: 'Page spoke',
        spaceId: 'space-1',
        space: 'General',
        updatedAt: '2026-11-26T10:00:00.000Z',
        url: `${docmost.url}/p/Sspoke`,
      },
      {
        id: 'older',
        slugId: 'Solder',
        title: 'Page older',
        spaceId: 'space-2',
        space: null,
        updatedAt: '2026-11-01T10:00:00.000Z',
        url: `${docmost.url}/p/Solder`,
      },
    ],
    nextCursor: null,
  });

  const outgoing = resultOf(await server.call('get_backlinks', { pageId: 'hub', direction: 'outgoing' }));
  assert.deepEqual(
    outgoing.pages.map((page: { id: string }) => page.id),
    ['spoke'],
  );
  assert.deepEqual(
    docmost.requests.filter((entry) => entry.endpoint === '/pages/backlinks').map((entry) => entry.body),
    [
      { pageId: 'Shub', direction: 'incoming', limit: 20 },
      { pageId: 'hub', direction: 'outgoing', limit: 20 },
    ],
  );
});

test('adds labels normalised as Docmost does, then removes one by name, returning the labels each time', async (t) => {
  const { docmost, server } = await startHarness(t, [makePage({ id: 'p1', labels: ['ops'] })]);

  const added = resultOf(await server.call('update_page_labels', { pageId: 'p1', add: ['Runbook', ' on call '] }));
  assert.deepEqual(added, { labels: ['ops', 'runbook', 'on-call'] });
  assert.deepEqual(resultOf(await server.call('list_page_labels', { pageId: 'p1' })), {
    labels: ['ops', 'runbook', 'on-call'],
  });

  const removed = resultOf(await server.call('update_page_labels', { pageId: 'p1', remove: ['RUNBOOK'] }));
  assert.deepEqual(removed, { labels: ['ops', 'on-call'] });
  assert.deepEqual(
    docmost.requests
      .filter((entry) => entry.endpoint.startsWith('/pages/labels/'))
      .map(({ endpoint, body }) => ({ endpoint, body })),
    [
      { endpoint: '/pages/labels/add', body: { pageId: 'p1', names: ['runbook', 'on-call'] } },
      { endpoint: '/pages/labels/remove', body: { pageId: 'p1', labelId: 'label-runbook' } },
    ],
  );
});

test('finds the pages carrying a label within one space only', async (t) => {
  const { docmost, server } = await startHarness(t, [
    makePage({ id: 'here', labels: ['runbook'] }),
    makePage({ id: 'unlabelled' }),
    makePage({ id: 'elsewhere', labels: ['runbook'], spaceId: 'space-2' }),
  ]);

  const result = resultOf(await server.call('find_pages_by_label', { label: 'Runbook', spaceId: 'space-1' }));
  assert.deepEqual(result, {
    pages: [
      {
        id: 'here',
        slugId: 'Shere',
        title: 'Page here',
        spaceId: 'space-1',
        space: 'General',
        updatedAt: START_TIME,
        url: `${docmost.url}/p/Shere`,
      },
    ],
    nextCursor: null,
  });
  const everywhere = resultOf(await server.call('find_pages_by_label', { label: 'runbook' }));
  assert.deepEqual(
    everywhere.pages.map((page: { id: string }) => page.id),
    ['here', 'elsewhere'],
  );
});

test('removing a label the page does not have is refused before anything changes, listing its labels', async (t) => {
  const { docmost, server } = await startHarness(t, [makePage({ id: 'p1', labels: ['ops', 'runbook'] })]);

  const result = await server.call('update_page_labels', { pageId: 'p1', add: ['new'], remove: ['on-call'] });
  assert.equal(result.isError, true);
  assert.match(result.text, /Refused: the page has no on-call label; its labels are ops, runbook\. Nothing changed\./);
  assert.deepEqual(docmost.page('p1')?.labels, ['ops', 'runbook']);
  assert.deepEqual(
    docmost.requests.filter((entry) => entry.endpoint.startsWith('/pages/labels/')),
    [],
  );
});

test('a label name Docmost would reject is refused before anything changes', async (t) => {
  const { docmost, server } = await startHarness(t, [makePage({ id: 'p1' })]);

  const result = await server.call('update_page_labels', { pageId: 'p1', add: ['ok', 'no/slash', '~tilde'] });
  assert.equal(result.isError, true);
  assert.match(result.text, /Refused: invalid label name "no\/slash", "~tilde"/);
  assert.deepEqual(
    docmost.requests.filter((entry) => entry.endpoint.startsWith('/pages/labels')),
    [],
  );
});

test('a Docmost without the backlink and label endpoints gets a needs-0.90 error, not page-not-found', async (t) => {
  const { docmost, server } = await startHarness(t, [makePage({ id: 'p1' })]);
  const missingPage = await server.call('get_backlinks', { pageId: 'nope', direction: 'incoming' });
  assert.match(missingPage.text, /failed \(404\): Page not found/);
  docmost.removeEndpoints('/pages/backlinks', '/pages/labels', '/labels/pages');

  for (const [name, args] of [
    ['get_backlinks', { pageId: 'p1', direction: 'incoming' }],
    ['list_page_labels', { pageId: 'p1' }],
    ['update_page_labels', { pageId: 'p1', add: ['runbook'] }],
    ['find_pages_by_label', { label: 'runbook' }],
  ] as const) {
    const result = await server.call(name, args);
    assert.equal(result.isError, true, name);
    assert.match(result.text, /^This needs Docmost 0\.90 or newer \(Docmost \/\S+ failed \(404\): Cannot POST /, name);
  }
});
