import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { doc, makePage, paragraph, text, type EditorMark, type EditorNode, type FakePage } from './fake-docmost.ts';
import { startHarness } from './helpers.ts';

const comment: EditorMark = { type: 'comment', attrs: { commentId: 'comment-1', resolved: false } };
const mention: EditorNode = { type: 'mention', attrs: { id: 'mention-1', label: 'Test User', entityType: 'user' } };
const block = (type: string, attrs: Record<string, unknown>, ...content: EditorNode[]): EditorNode => ({
  type,
  attrs,
  content,
});

const richDoc = (
  sentence = 'The launch is on Monday.',
  commentedPart: EditorNode[] = [text('Some '), text('commented words', [comment]), text('.')],
) =>
  doc(
    block('paragraph', { id: 'para1', indent: 0 }, text('Written by '), mention),
    block('paragraph', { id: 'para2', indent: 0 }, ...commentedPart),
    block('paragraph', { id: 'para3', indent: 0 }, text(sentence)),
  );

type Mode = 'live' | 'saved';
const MODES: Mode[] = ['live', 'saved'];

const harness = async (t: TestContext, mode: Mode, page: FakePage) => {
  const { docmost, server } = await startHarness(t, [page]);
  if (mode === 'saved') {
    docmost.setCollabMode('notFound');
  }
  const edit = async (args: Record<string, unknown>) => {
    const result = await server.call('edit_page', { pageId: page.id, ...args });
    docmost.saveLive(page.id);
    return {
      isError: result.isError,
      text: result.text,
      summary: result.isError ? undefined : JSON.parse(result.text),
    };
  };
  return { docmost, edit, savedJson: () => docmost.page(page.id)?.json };
};

const checkPath = (
  mode: Mode,
  docmost: Awaited<ReturnType<typeof harness>>['docmost'],
  summary: Record<string, unknown>,
) => {
  assert.equal(summary.editedInPlace, true);
  if (mode === 'live') {
    assert.equal(summary.liveMerge, true);
    assert.equal(summary.updatedAt, null);
    assert.deepEqual(docmost.writes(), []);
  } else {
    assert.equal(summary.liveMerge, false);
    assert.match(String(summary.liveMergeSkipped), /live-editing connection/);
    assert.ok(docmost.writes().every((write) => write.body.format === 'json'));
  }
};

for (const mode of MODES) {
  test(`[${mode}] a sentence on a page with a comment and a mention is edited in place`, async (t) => {
    const { docmost, edit, savedJson } = await harness(t, mode, makePage({ id: 'p1', json: richDoc() }));
    const { summary } = await edit({ oldText: 'Monday', newText: 'Tuesday' });
    assert.ok(summary);
    checkPath(mode, docmost, summary);
    assert.equal(summary.replacements, 1);
    assert.deepEqual(savedJson(), richDoc('The launch is on Tuesday.'));
    assert.deepEqual(
      docmost.requests.map((request) => request.endpoint).filter((endpoint) => endpoint !== '/auth/login'),
      mode === 'live' ? ['/pages/info', '/auth/collab-token'] : ['/pages/info', '/auth/collab-token', '/pages/update'],
    );
    assert.deepEqual(docmost.upgradePaths, ['/collab']);
  });

  test(`[${mode}] words inside a commented phrase keep the comment and its id`, async (t) => {
    const { docmost, edit, savedJson } = await harness(t, mode, makePage({ id: 'p1', json: richDoc() }));
    const { summary } = await edit({ oldText: 'commented', newText: 'reviewed' });
    assert.ok(summary);
    checkPath(mode, docmost, summary);
    assert.deepEqual(savedJson(), richDoc(undefined, [text('Some '), text('reviewed words', [comment]), text('.')]));
  });

  test(`[${mode}] text running from plain words into a comment takes the formatting of its first character`, async (t) => {
    const { edit, savedJson } = await harness(t, mode, makePage({ id: 'p1', json: richDoc() }));
    await edit({ oldText: 'Some commented', newText: 'A reviewed' });
    assert.deepEqual(savedJson(), richDoc(undefined, [text('A reviewed'), text(' words', [comment]), text('.')]));
  });

  test(`[${mode}] block ids and alignment are kept`, async (t) => {
    const plainDoc = (heading: string) =>
      doc(
        block('heading', { id: 'h1', level: 2, textAlign: 'center' }, text(heading)),
        block('paragraph', { id: 'a1', indent: 1, textAlign: 'right' }, text('Body text')),
      );
    const { edit, savedJson } = await harness(t, mode, makePage({ id: 'p1', json: plainDoc('Old title') }));
    await edit({ oldText: 'Old', newText: 'New' });
    assert.deepEqual(savedJson(), plainDoc('New title'));
  });

  test(`[${mode}] escaped characters in oldText and newText match their plain form`, async (t) => {
    const { edit, savedJson } = await harness(
      t,
      mode,
      makePage({ id: 'p1', json: doc(paragraph(text('3 * 4 = 12'))) }),
    );
    await edit({ oldText: '3 \\* 4', newText: '3 \\* 5' });
    assert.deepEqual(savedJson(), doc(paragraph(text('3 * 5 = 12'))));
  });

  test(`[${mode}] multi-line text in a code block is matched as written, backslashes included`, async (t) => {
    const code = (body: string) => doc(block('codeBlock', { language: 'js' }, text(body)));
    const { edit, savedJson } = await harness(
      t,
      mode,
      makePage({ id: 'p1', json: code('const pattern = /\\d+/;\nconst total = a * b;') }),
    );
    await edit({ oldText: 'const pattern = /\\d+/;\nconst total', newText: 'const digits = /\\d+/;\nconst sum' });
    assert.deepEqual(savedJson(), code('const digits = /\\d+/;\nconst sum = a * b;'));
  });

  test(`[${mode}] deleting a whole text node leaves no empty text node behind`, async (t) => {
    const page = makePage({
      id: 'p1',
      json: doc(paragraph(text('keep '), text('drop', [{ type: 'bold' }])), paragraph(text('gone'))),
    });
    const { edit, savedJson } = await harness(t, mode, page);
    await edit({ oldText: 'drop', newText: '' });
    await edit({ oldText: 'gone', newText: '' });
    assert.deepEqual(savedJson(), doc(paragraph(text('keep ')), { type: 'paragraph' }));
  });

  test(`[${mode}] replaceAll edits matches in table cells and list items at once`, async (t) => {
    const page = (word: string) =>
      doc(
        {
          type: 'table',
          content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [paragraph(text(`${word} one`))] }] }],
        },
        { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph(text(`${word} two`))] }] },
        paragraph(text(`${word} three`)),
      );
    const { docmost, edit, savedJson } = await harness(t, mode, makePage({ id: 'p1', json: page('TODO') }));
    const { summary } = await edit({ oldText: 'TODO', newText: 'DONE', replaceAll: true });
    assert.equal(summary?.replacements, 3);
    assert.equal(docmost.writes().length, mode === 'live' ? 0 : 1);
    assert.deepEqual(savedJson(), page('DONE'));
  });

  test(`[${mode}] text that also appears in a link URL counts once and is edited in place`, async (t) => {
    const link: EditorMark = { type: 'link', attrs: { href: 'https://example.com/docs' } };
    const page = (mirror: string) => doc(paragraph(text(mirror)), paragraph(text('read this', [link])));
    const { edit, savedJson } = await harness(
      t,
      mode,
      makePage({
        id: 'p1',
        markdown: 'mirror of example.com/docs\n\n[read this](https://example.com/docs)',
        json: page('mirror of example.com/docs'),
      }),
    );
    const { isError } = await edit({ oldText: 'example.com/docs', newText: 'example.org/docs' });
    assert.equal(isError, false);
    assert.deepEqual(savedJson(), page('mirror of example.org/docs'));
  });

  test(`[${mode}] a # inside a sentence and a stored U+FFFC character are still edited in place`, async (t) => {
    const page = (issue: string, other: string) => doc(paragraph(text(`see ${issue}`)), paragraph(text(other)));
    const { edit, savedJson } = await harness(t, mode, makePage({ id: 'p1', json: page('12', 'x￼y') }));
    const first = await edit({ oldText: '12', newText: '#12' });
    const second = await edit({ oldText: 'x￼y', newText: 'z' });
    assert.equal(first.summary?.editedInPlace, true);
    assert.equal(second.summary?.editedInPlace, true);
    assert.deepEqual(savedJson(), page('#12', 'z'));
  });
}

test('[saved] Docmost rejecting the write is reported, and nothing is retried through Markdown', async (t) => {
  const { docmost, edit } = await harness(t, 'saved', makePage({ id: 'p1', json: richDoc() }));
  docmost.rejectUpdates(400, 'Invalid document');
  const result = await edit({ oldText: 'Monday', newText: 'Tuesday' });
  assert.equal(result.isError, true);
  assert.equal(result.text, 'Docmost /pages/update failed (400): Invalid document');
  assert.deepEqual(
    docmost.writes().map((write) => write.body.format),
    ['json'],
  );
});
