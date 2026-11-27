import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  commentBody,
  commentMark,
  doc,
  makeComment,
  makePage,
  paragraph,
  text,
  type EditorNode,
} from './fake-docmost.ts';
import { closedPortUrl, openTestEditor, startHarness } from './helpers.ts';

const PRIYA = { id: 'user-2', name: 'Priya Sharma' };

const launchPage = (...content: EditorNode[]) =>
  makePage({
    id: 'p1',
    markdown: 'Intro line.\n\nThe launch is on Monday.',
    json: content.length > 0 ? doc(...content) : doc(paragraph(text('Intro line.')), paragraph(text('The launch is on Monday.'))),
  });

const resultOf = (result: { isError: boolean; text: string }) => {
  assert.equal(result.isError, false, result.text);
  return JSON.parse(result.text);
};

const refusal = (result: { isError: boolean; text: string }, pattern: RegExp) => {
  assert.equal(result.isError, true, result.text);
  assert.match(result.text, pattern);
};

const commentParagraph = (content: unknown): EditorNode[] => {
  const body = typeof content === 'object' && content !== null && 'content' in content ? content.content : undefined;
  const [first] = Array.isArray(body) ? body : [];
  return typeof first === 'object' && first !== null && 'content' in first && Array.isArray(first.content) ? first.content : [];
};

const thread = () => [
  makeComment({ id: 'c1', pageId: 'p1', type: 'inline', selection: 'on Monday', createdAt: '2026-11-25T10:00:01.000Z' }),
  makeComment({ id: 'r1', pageId: 'p1', parentCommentId: 'c1', creatorId: PRIYA.id, content: commentBody('Yes.'), createdAt: '2026-11-25T10:00:02.000Z' }),
  makeComment({ id: 'r2', pageId: 'p1', parentCommentId: 'c1', content: commentBody('Thanks.'), createdAt: '2026-11-25T10:00:03.000Z' }),
];

test('list_comments shows open threads with their replies, leaving resolved ones out', async (t) => {
  const resolved = makeComment({ id: 'c2', pageId: 'p1', resolvedAt: '2026-11-25T10:00:05.000Z' });
  const { server } = await startHarness(t, [launchPage()], { comments: [...thread(), resolved], members: [PRIYA] });

  const { threads } = resultOf(await server.call('list_comments', { pageId: 'p1' }));
  assert.deepEqual(threads, [
    {
      id: 'c1',
      author: 'Test Account',
      createdAt: '2026-11-25T10:00:01.000Z',
      text: 'Comment c1',
      quote: 'on Monday',
      resolved: false,
      replies: [
        { id: 'r1', author: 'Priya Sharma', createdAt: '2026-11-25T10:00:02.000Z', text: 'Yes.' },
        { id: 'r2', author: 'Test Account', createdAt: '2026-11-25T10:00:03.000Z', text: 'Thanks.' },
      ],
    },
  ]);
});

test('list_comments with includeResolved shows every thread', async (t) => {
  const resolved = makeComment({
    id: 'c2',
    pageId: 'p1',
    createdAt: '2026-11-25T10:00:04.000Z',
    resolvedAt: '2026-11-25T10:00:05.000Z',
  });
  const { server } = await startHarness(t, [launchPage()], { comments: [...thread(), resolved] });

  const { threads } = resultOf(await server.call('list_comments', { pageId: 'p1', includeResolved: true }));
  assert.deepEqual(
    threads.map((entry: { id: string; resolved: boolean }) => [entry.id, entry.resolved]),
    [
      ['c1', false],
      ['c2', true],
    ],
  );
});

test('add_comment without a quote posts a page comment split into paragraphs', async (t) => {
  const { docmost, server } = await startHarness(t, [launchPage()]);

  const result = resultOf(await server.call('add_comment', { pageId: 'p1', text: 'First line.\n\nSecond paragraph.' }));
  assert.equal(result.type, 'page');
  assert.equal(result.anchored, undefined);
  const [comment] = docmost.comments();
  assert.equal(comment?.type, 'page');
  assert.deepEqual(comment?.content, commentBody('First line.', 'Second paragraph.'));
});

test('add_comment with a quote anchors the comment to exactly that text', async (t) => {
  const { docmost, server } = await startHarness(t, [launchPage()]);
  await openTestEditor(t, docmost, 'p1');

  const result = resultOf(await server.call('add_comment', { pageId: 'p1', text: 'Is this still right?', quote: 'on Monday' }));
  assert.equal(result.anchored, true);
  assert.equal(docmost.comments()[0]?.selection, 'on Monday');
  assert.deepEqual(
    docmost.liveJson('p1'),
    doc(paragraph(text('Intro line.')), paragraph(text('The launch is '), text('on Monday', [commentMark(result.id)]), text('.'))),
  );
});

test('add_comment refuses a quote that is not on the page', async (t) => {
  const { docmost, server } = await startHarness(t, [launchPage()]);

  refusal(await server.call('add_comment', { pageId: 'p1', text: 'Note', quote: 'on Friday' }), /Refused: the quote was not found/);
  assert.deepEqual(docmost.commentWrites(), []);
});

test('add_comment refuses a quote that appears twice', async (t) => {
  const page = launchPage(paragraph(text('Monday first.')), paragraph(text('Then Monday again.')));
  const { docmost, server } = await startHarness(t, [page]);

  refusal(await server.call('add_comment', { pageId: 'p1', text: 'Note', quote: 'Monday' }), /appears 2 times; include more surrounding text/);
  assert.deepEqual(docmost.commentWrites(), []);
});

test('add_comment counts overlapping occurrences when checking that a quote is unique', async (t) => {
  const { docmost, server } = await startHarness(t, [launchPage(paragraph(text('Status: aaa.')))]);

  refusal(await server.call('add_comment', { pageId: 'p1', text: 'Note', quote: 'aa' }), /appears 2 times/);
  assert.deepEqual(docmost.commentWrites(), []);
});

test('add_comment refuses a quote crossing a mention, spanning lines, or inside a code block', async (t) => {
  const mention = { type: 'mention', attrs: { id: 'm1', label: 'Priya', entityType: 'user', entityId: PRIYA.id } };
  const page = launchPage(
    paragraph(text('Intro line.')),
    paragraph(text('Ask '), mention, text(' today.')),
    { type: 'codeBlock', content: [text('const launch = 1;')] },
  );
  const { docmost, server } = await startHarness(t, [page]);

  refusal(await server.call('add_comment', { pageId: 'p1', text: 'Note', quote: 'Ask @Priya today' }), /crosses a mention/);
  refusal(await server.call('add_comment', { pageId: 'p1', text: 'Note', quote: 'Intro line.\nAsk' }), /spans more than one line/);
  refusal(await server.call('add_comment', { pageId: 'p1', text: 'Note', quote: 'const launch = 1;' }), /inside a code block/);
  assert.deepEqual(docmost.commentWrites(), []);
});

test('add_comment refuses a quote that already has a comment highlight', async (t) => {
  const page = launchPage(paragraph(text('The launch is '), text('on Monday', [commentMark('c-old')]), text('.')));
  const { docmost, server } = await startHarness(t, [page]);
  await openTestEditor(t, docmost, 'p1');

  refusal(await server.call('add_comment', { pageId: 'p1', text: 'Note', quote: 'Monday' }), /already has a comment/);
  assert.deepEqual(docmost.commentWrites(), []);
  assert.deepEqual(docmost.liveJson('p1'), page.json);
});

test('add_comment reports anchored: false when Docmost saves the comment without its highlight', async (t) => {
  const { docmost, server } = await startHarness(t, [launchPage()]);
  docmost.dropCommentMarks();

  const result = resultOf(await server.call('add_comment', { pageId: 'p1', text: 'Note', quote: 'on Monday' }));
  assert.equal(result.anchored, false);
  assert.match(result.anchorMissing, /did not add its highlight within 5 s/);
  assert.equal(docmost.comments().length, 1);
});

test('add_comment with a quote refuses when the live document cannot be reached', async (t) => {
  const { docmost, server } = await startHarness(t, [launchPage()], { collabUrl: await closedPortUrl() });

  refusal(await server.call('add_comment', { pageId: 'p1', text: 'Note', quote: 'on Monday' }), /can't be anchored/);
  assert.deepEqual(docmost.commentWrites(), []);
});

test('add_comment anchors a quote for an account that can comment but not edit', async (t) => {
  const { docmost, server } = await startHarness(t, [launchPage()]);
  docmost.setCollabMode('readOnly');

  const result = resultOf(await server.call('add_comment', { pageId: 'p1', text: 'Note', quote: 'on Monday' }));
  assert.equal(result.anchored, true);
});

test('@[Full Name] mentions the one member with that name, and list_comments shows it', async (t) => {
  const { docmost, server } = await startHarness(t, [launchPage()], { members: [PRIYA] });

  resultOf(await server.call('add_comment', { pageId: 'p1', text: '@[priya sharma] can you check?' }));
  const [comment] = docmost.comments();
  const [mentionNode, rest] = commentParagraph(comment?.content);
  assert.deepEqual(mentionNode?.attrs && { ...mentionNode.attrs, id: 'any' }, {
    id: 'any',
    label: 'Priya Sharma',
    entityType: 'user',
    entityId: PRIYA.id,
  });
  assert.deepEqual(rest, text(' can you check?'));
  const { threads } = resultOf(await server.call('list_comments', { pageId: 'p1' }));
  assert.equal(threads[0].text, '@Priya Sharma can you check?');
});

test('a mention with no member, or several, of that name is refused', async (t) => {
  const twin = { id: 'user-3', name: 'Priya Sharma' };
  const { docmost, server } = await startHarness(t, [launchPage()], { members: [PRIYA, twin, { id: 'user-4', name: 'Nobody Else' }] });

  refusal(await server.call('add_comment', { pageId: 'p1', text: '@[Nobody] hi' }), /no member is named "Nobody"; closest: Nobody Else/);
  refusal(await server.call('add_comment', { pageId: 'p1', text: '@[Priya Sharma] hi' }), /2 members are named "Priya Sharma"/);
  assert.deepEqual(docmost.commentWrites(), []);
});

test('a mention is refused when the people search is full, since uniqueness cannot be confirmed', async (t) => {
  const others = Array.from({ length: 99 }, (_, index) => ({ id: `user-sam-${index}`, name: `Sam ${index}` }));
  const { docmost, server } = await startHarness(t, [launchPage()], { members: [{ id: 'user-sam', name: 'Sam' }, ...others] });

  refusal(await server.call('add_comment', { pageId: 'p1', text: '@[Sam] hi' }), /at least 100 members match "Sam"/);
  assert.deepEqual(docmost.commentWrites(), []);
});

test('a bare @ or an email address stays plain text', async (t) => {
  const { docmost, server } = await startHarness(t, [launchPage()]);

  resultOf(await server.call('add_comment', { pageId: 'p1', text: 'Mail a@b.test or ping @someone' }));
  assert.deepEqual(docmost.comments()[0]?.content, commentBody('Mail a@b.test or ping @someone'));
  assert.equal(docmost.requests.filter((entry) => entry.endpoint === '/search/suggest').length, 0);
});

test('reply_to_comment replies under a top-level comment', async (t) => {
  const { docmost, server } = await startHarness(t, [launchPage()], { comments: [makeComment({ id: 'c1', pageId: 'p1' })] });

  const result = resultOf(await server.call('reply_to_comment', { commentId: 'c1', text: 'Agreed.' }));
  assert.equal(result.threadId, 'c1');
  assert.equal(result.note, undefined);
  assert.equal(docmost.comments().find((comment) => comment.id === result.id)?.parentCommentId, 'c1');
});

test('reply_to_comment on a reply posts into the same thread and says so', async (t) => {
  const { docmost, server } = await startHarness(t, [launchPage()], { comments: thread() });

  const result = resultOf(await server.call('reply_to_comment', { commentId: 'r1', text: 'Agreed.' }));
  assert.equal(result.threadId, 'c1');
  assert.match(result.note, /Posted in thread c1/);
  assert.equal(docmost.comments().find((comment) => comment.id === result.id)?.parentCommentId, 'c1');
});

test('resolve_comment resolves and reopens a thread, and its highlight follows', async (t) => {
  const page = launchPage(paragraph(text('The launch is '), text('on Monday', [commentMark('c1')]), text('.')));
  const { docmost, server } = await startHarness(t, [page], { comments: thread() });
  await openTestEditor(t, docmost, 'p1');

  assert.deepEqual(resultOf(await server.call('resolve_comment', { commentId: 'c1' })), {
    id: 'c1',
    resolved: true,
    highlightUpdated: true,
  });
  assert.notEqual(docmost.comments().find((comment) => comment.id === 'c1')?.resolvedAt, null);
  assert.deepEqual(docmost.liveJson('p1'), doc(paragraph(text('The launch is '), text('on Monday', [commentMark('c1', true)]), text('.'))));

  assert.deepEqual(resultOf(await server.call('resolve_comment', { commentId: 'c1', resolved: false })), {
    id: 'c1',
    resolved: false,
    highlightUpdated: true,
  });
  assert.equal(docmost.comments().find((comment) => comment.id === 'c1')?.resolvedAt, null);
  assert.deepEqual(docmost.liveJson('p1'), page.json);
});

test("resolve_comment sets the highlight's resolved flag itself when Docmost leaves it, as 0.95 does", async (t) => {
  const page = launchPage(paragraph(text('The launch is '), text('on Monday', [commentMark('c1')]), text('.')));
  const { docmost, server } = await startHarness(t, [page], { comments: thread() });
  docmost.setResolveMode('leavesHighlight');
  await openTestEditor(t, docmost, 'p1');

  assert.equal(resultOf(await server.call('resolve_comment', { commentId: 'c1' })).highlightUpdated, true);
  assert.deepEqual(docmost.liveJson('p1'), doc(paragraph(text('The launch is '), text('on Monday', [commentMark('c1', true)]), text('.'))));

  assert.equal(resultOf(await server.call('resolve_comment', { commentId: 'c1', resolved: false })).highlightUpdated, true);
  assert.deepEqual(docmost.liveJson('p1'), page.json);
});

test('resolve_comment reports a highlight it cannot update for an account that can only view the page', async (t) => {
  const page = launchPage(paragraph(text('The launch is '), text('on Monday', [commentMark('c1')]), text('.')));
  const { docmost, server } = await startHarness(t, [page], { comments: thread() });
  docmost.setResolveMode('leavesHighlight');
  docmost.setCollabMode('readOnly');

  const result = resultOf(await server.call('resolve_comment', { commentId: 'c1' }));
  assert.equal(result.resolved, true);
  assert.equal(result.highlightUpdated, false);
  assert.match(result.highlightLeft, /can only view the page/);
});

test('resolve_comment on an instance without the licence is refused plainly', async (t) => {
  const { docmost, server } = await startHarness(t, [launchPage()], { comments: thread() });
  docmost.setResolveMode('unlicensed');

  refusal(await server.call('resolve_comment', { commentId: 'c1' }), /needs a Docmost Enterprise licence on this instance, so the thread stays open\. Nothing changed\./);
  assert.equal(docmost.comments().find((comment) => comment.id === 'c1')?.resolvedAt, null);
});

test('resolve_comment on a reply is refused and names the thread', async (t) => {
  const { docmost, server } = await startHarness(t, [launchPage()], { comments: thread() });

  refusal(await server.call('resolve_comment', { commentId: 'r1' }), /resolve the thread's top comment c1 instead/);
  assert.deepEqual(docmost.commentWrites(), []);
});

test("edit_comment replaces the account's own comment text, with a mention", async (t) => {
  const { server } = await startHarness(t, [launchPage()], { comments: thread(), members: [PRIYA] });

  assert.deepEqual(resultOf(await server.call('edit_comment', { commentId: 'r2', text: 'Thanks @[Priya Sharma].' })), {
    id: 'r2',
    threadId: 'c1',
  });
  const { threads } = resultOf(await server.call('list_comments', { pageId: 'p1' }));
  assert.equal(threads[0].replies[1].text, 'Thanks @Priya Sharma.');
});

test("edit_comment on someone else's comment is refused", async (t) => {
  const { docmost, server } = await startHarness(t, [launchPage()], { comments: thread(), members: [PRIYA] });

  refusal(await server.call('edit_comment', { commentId: 'r1', text: 'Changed.' }), /only edit your own comments/);
  assert.deepEqual(docmost.comments().find((comment) => comment.id === 'r1')?.content, commentBody('Yes.'));
});

test('delete_comment deletes a reply, or a comment with no replies', async (t) => {
  const single = makeComment({ id: 'c9', pageId: 'p1' });
  const { docmost, server } = await startHarness(t, [launchPage()], { comments: [...thread(), single] });

  assert.deepEqual(resultOf(await server.call('delete_comment', { commentId: 'r2' })), { deleted: ['r2'] });
  assert.deepEqual(resultOf(await server.call('delete_comment', { commentId: 'c9' })), { deleted: ['c9'] });
  assert.deepEqual(
    docmost.comments().map((comment) => comment.id),
    ['c1', 'r1'],
  );
});

test('delete_comment refuses a thread with replies unless deleteReplies is set', async (t) => {
  const { docmost, server } = await startHarness(t, [launchPage()], { comments: thread() });

  refusal(await server.call('delete_comment', { commentId: 'c1' }), /has 2 replies.*deleteReplies: true/);
  assert.deepEqual(docmost.commentWrites(), []);
  assert.equal(docmost.comments().length, 3);
});

test('delete_comment refuses when the page has more comments than it can list, unless deleteReplies is set', async (t) => {
  const filler = Array.from({ length: 1000 }, (_, index) => makeComment({ id: `f${index}`, pageId: 'p1' }));
  const late = makeComment({ id: 'late-reply', pageId: 'p1', parentCommentId: 'c1' });
  const { docmost, server } = await startHarness(t, [launchPage()], {
    comments: [makeComment({ id: 'c1', pageId: 'p1' }), ...filler, late],
  });

  refusal(await server.call('delete_comment', { commentId: 'c1' }), /more than 1000 comments.*deleteReplies: true/);
  assert.deepEqual(docmost.commentWrites(), []);
});

test('delete_comment with deleteReplies deletes the whole thread', async (t) => {
  const page = launchPage(paragraph(text('The launch is '), text('on Monday', [commentMark('c1')]), text('.')));
  const { docmost, server } = await startHarness(t, [page], { comments: thread() });

  const result = resultOf(await server.call('delete_comment', { commentId: 'c1', deleteReplies: true }));
  assert.deepEqual(result.deleted, ['c1', 'r1', 'r2']);
  assert.deepEqual(docmost.comments(), []);
});

test("delete_comment removes an inline comment's highlight from the live document", async (t) => {
  const page = launchPage(paragraph(text('The launch is '), text('on Monday', [commentMark('c1')]), text('.')));
  const { docmost, server } = await startHarness(t, [page], { comments: [makeComment({ id: 'c1', pageId: 'p1', type: 'inline' })] });
  await openTestEditor(t, docmost, 'p1');

  assert.deepEqual(resultOf(await server.call('delete_comment', { commentId: 'c1' })), { deleted: ['c1'], highlightRemoved: true });
  assert.deepEqual(docmost.liveJson('p1'), doc(paragraph(text('The launch is on Monday.'))));
});

test('delete_comment still deletes when the highlight cannot be removed, and says so', async (t) => {
  const page = launchPage(paragraph(text('The launch is '), text('on Monday', [commentMark('c1')]), text('.')));
  const { docmost, server } = await startHarness(t, [page], { comments: [makeComment({ id: 'c1', pageId: 'p1', type: 'inline' })] });
  docmost.setCollabMode('readOnly');
  await openTestEditor(t, docmost, 'p1');

  const result = resultOf(await server.call('delete_comment', { commentId: 'c1' }));
  assert.deepEqual(result.deleted, ['c1']);
  assert.equal(result.highlightRemoved, false);
  assert.match(result.highlightLeft, /can only view the page/);
  assert.deepEqual(docmost.comments(), []);
  assert.deepEqual(docmost.liveJson('p1'), page.json);
});

test("delete_comment on someone else's comment is refused when not a space admin", async (t) => {
  const { docmost, server } = await startHarness(t, [launchPage()], { comments: thread(), members: [PRIYA] });

  refusal(await server.call('delete_comment', { commentId: 'r1' }), /only delete your own comments/);
  assert.equal(docmost.comments().length, 3);
});

test('an unknown comment or page is refused with Docmost’s reason', async (t) => {
  const { server } = await startHarness(t, [launchPage()]);

  refusal(await server.call('reply_to_comment', { commentId: 'missing', text: 'Hi' }), /Comment not found/);
  refusal(await server.call('list_comments', { pageId: 'missing' }), /Page not found/);
});
