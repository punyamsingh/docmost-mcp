import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makePage } from './fake-docmost.ts';
import { readPageResult, startHarness } from './helpers.ts';

const numberedLines = (count: number, first = 1) =>
  Array.from({ length: count }, (_, index) => `line ${first + index}`).join('\n');

test('returns 500 lines by default and the rest from an offset', async (t) => {
  const { server } = await startHarness(t, [makePage({ id: 'p1', markdown: numberedLines(1200) })]);

  const first = await server.call('get_page', { pageId: 'p1' });
  const firstWindow = readPageResult(first.text);
  assert.equal(firstWindow.header.totalLines, 1200);
  assert.equal(firstWindow.header.nextOffset, 501);
  assert.equal(
    firstWindow.body,
    `${numberedLines(500)}\n\n[lines 1–500 of 1200; call get_page with offset 501 for more]`,
  );

  const last = readPageResult((await server.call('get_page', { pageId: 'p1', offset: 1001 })).text);
  assert.equal(last.header.nextOffset, null);
  assert.equal(last.body, numberedLines(200, 1001));
});

test('an offset past the end returns an empty body, not an error', async (t) => {
  const { server } = await startHarness(t, [makePage({ id: 'p1', markdown: numberedLines(30) })]);

  const result = await server.call('get_page', { pageId: 'p1', offset: 5000 });
  assert.equal(result.isError, false);
  const window = readPageResult(result.text);
  assert.equal(window.body, '');
  assert.equal(window.header.totalLines, 30);
  assert.equal(window.header.nextOffset, null);
});

test('the window stops under 100k characters at a line boundary', async (t) => {
  const longLine = 'a'.repeat(60_000);
  const { server } = await startHarness(t, [makePage({ id: 'p1', markdown: `${longLine}\n${longLine}\nshort` })]);

  const window = readPageResult((await server.call('get_page', { pageId: 'p1' })).text);
  assert.equal(window.header.nextOffset, 2);
  assert.ok(window.body.startsWith(`${longLine}\n\n[lines 1–1 of 3;`));
});

test('a single line over 100k characters is cut at 100k', async (t) => {
  const { server } = await startHarness(t, [makePage({ id: 'p1', markdown: `${'b'.repeat(150_000)}\nnext` })]);

  const window = readPageResult((await server.call('get_page', { pageId: 'p1' })).text);
  assert.equal(window.header.nextOffset, 2);
  assert.ok(window.body.startsWith(`${'b'.repeat(100_000)}\n\n[lines 1–1 of 2;`));
});

test('accepts a page id, a slug id or a copied page URL', async (t) => {
  const { docmost, server } = await startHarness(t, [makePage({ id: 'p1', markdown: 'hello' })]);

  for (const pageId of ['p1', 'Sp1', `${docmost.url}/p/my-page-title-Sp1`]) {
    const window = readPageResult((await server.call('get_page', { pageId })).text);
    assert.equal(window.header.id, 'p1');
    assert.equal(window.body, 'hello');
  }
});

const guide = [
  'Intro text.',
  '',
  '## Setup',
  'Install it.',
  '',
  '```bash',
  '# not a heading',
  'npm install',
  '```',
  '',
  '### From a clone',
  'Clone it.',
  '',
  '## Usage',
  'Use it.',
].join('\n');

test('outline lists headings with levels and line numbers, skipping lines inside code blocks', async (t) => {
  const { docmost, server } = await startHarness(t, [makePage({ id: 'p1', markdown: guide })]);

  const result = await server.call('get_page', { pageId: 'p1', outline: true });
  assert.equal(result.isError, false, result.text);
  const parsed = JSON.parse(result.text);
  assert.equal(parsed.url, `${docmost.url}/p/Sp1`);
  assert.equal(parsed.totalLines, 15);
  assert.deepEqual(parsed.outline, [
    { line: 3, level: 2, heading: 'Setup' },
    { line: 11, level: 3, heading: 'From a clone' },
    { line: 14, level: 2, heading: 'Usage' },
  ]);
});

test('section returns a heading down to the next heading at its level, with whole-page line numbers', async (t) => {
  const { server } = await startHarness(t, [makePage({ id: 'p1', markdown: guide })]);

  const { text } = await server.call('get_page', { pageId: 'p1', section: '## setup' });
  const window = readPageResult(text);
  assert.equal(window.header.totalLines, 15);
  assert.equal(window.header.nextOffset, null);
  assert.deepEqual(JSON.parse(text.slice(0, text.indexOf('\n\n---\n\n'))).section, {
    heading: 'Setup',
    firstLine: 3,
    lastLine: 13,
  });
  assert.equal(window.body, guide.split('\n').slice(2, 13).join('\n'));

  const last = readPageResult((await server.call('get_page', { pageId: 'p1', section: 'Usage' })).text);
  assert.equal(last.body, '## Usage\nUse it.');
});

test('a long section pages within itself and says how to continue', async (t) => {
  const { server } = await startHarness(t, [makePage({ id: 'p1', markdown: guide })]);

  const first = readPageResult((await server.call('get_page', { pageId: 'p1', section: 'Setup', limit: 4 })).text);
  assert.equal(first.header.nextOffset, 7);
  assert.match(first.body, /\[lines 3–6 of 15; call get_page with the same section and offset 7 for more\]$/);

  const rest = readPageResult((await server.call('get_page', { pageId: 'p1', section: 'Setup', offset: 11 })).text);
  assert.equal(rest.body, '### From a clone\nClone it.\n');
  assert.equal(rest.header.nextOffset, null);
});

test('a section that matches no heading, or two, is refused with the line numbers', async (t) => {
  const { server } = await startHarness(t, [makePage({ id: 'p1', markdown: `${guide}\n\n## Setup\nAgain.` })]);

  const missing = await server.call('get_page', { pageId: 'p1', section: 'Deploy' });
  assert.equal(missing.isError, true);
  assert.match(
    missing.text,
    /No heading matches "Deploy"\. Headings by line: 3 Setup; 11 From a clone; 14 Usage; 17 Setup\./,
  );

  const twice = await server.call('get_page', { pageId: 'p1', section: 'setup' });
  assert.equal(twice.isError, true);
  assert.match(twice.text, /"setup" matches 2 headings, at lines 3, 17; read the one you want with offset and limit\./);
});

test('section refuses an offset outside it, and outline with section is refused', async (t) => {
  const { server } = await startHarness(t, [makePage({ id: 'p1', markdown: guide })]);

  const outside = await server.call('get_page', { pageId: 'p1', section: 'Usage', offset: 2 });
  assert.equal(outside.isError, true);
  assert.match(outside.text, /offset 2 is outside the section "Usage", lines 14–15\./);

  const both = await server.call('get_page', { pageId: 'p1', section: 'Usage', outline: true });
  assert.equal(both.isError, true);
  assert.match(both.text, /Pass outline or section, not both\./);
});
