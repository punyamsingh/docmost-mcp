import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@hocuspocus/server';
import * as Y from 'yjs';

export type EditorMark = { type: string; attrs?: Record<string, unknown> };

export type EditorNode = {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: EditorMark[];
  content?: EditorNode[];
};

export type FakePage = {
  id: string;
  slugId: string;
  title: string;
  spaceId: string;
  parentPageId: string | null;
  updatedAt: string;
  markdown: string;
  json: EditorNode | null;
  textPieces?: 'run' | 'node';
};

export type FakeMember = { id: string; name: string };

export type FakeSpace = { id: string; name: string; slug: string };

export type FakeComment = {
  id: string;
  pageId: string;
  parentCommentId: string | null;
  content: unknown;
  selection: string | null;
  type: string;
  creatorId: string;
  resolvedAt: string | null;
  createdAt: string;
  editedAt: string | null;
};

export type FakeRequest = { endpoint: string; body: Record<string, unknown> };

export type FakeUpload = { fields: string[]; pageId: string; fileName: string; type: string; bytes: Uint8Array };

export type CollabMode = 'normal' | 'notFound' | 'neverSync' | 'rejectToken' | 'readOnly' | 'neverConfirm';

export const EMAIL = 'tester@example.test';
export const PASSWORD = 'correct-password';
export const SPACE_ID = 'space-1';
export const START_TIME = '2026-11-25T10:00:00.000Z';
export const ACCOUNT: FakeMember = { id: 'user-1', name: 'Test Account' };

const paragraphsFrom = (markdown: string): EditorNode[] =>
  markdown
    .split(/\n{2,}/)
    .filter((block) => block !== '')
    .map((block) => ({ type: 'paragraph', content: [{ type: 'text', text: block }] }));

export const text = (value: string, marks?: EditorMark[]): EditorNode => ({
  type: 'text',
  text: value,
  ...(marks ? { marks } : {}),
});
export const paragraph = (...content: EditorNode[]): EditorNode => ({ type: 'paragraph', content });
export const doc = (...content: EditorNode[]): EditorNode => ({ type: 'doc', content });

export const makePage = (fields: Partial<FakePage> & { id: string }): FakePage => ({
  slugId: `S${fields.id}`,
  title: `Page ${fields.id}`,
  spaceId: SPACE_ID,
  parentPageId: null,
  updatedAt: START_TIME,
  markdown: '',
  json: { type: 'doc', content: paragraphsFrom(fields.markdown ?? '') },
  ...fields,
});

export const commentBody = (...paragraphs: string[]) => ({
  type: 'doc',
  content: paragraphs.map((value) => ({ type: 'paragraph', content: [{ type: 'text', text: value }] })),
});

export const makeComment = (fields: Partial<FakeComment> & { id: string; pageId: string }): FakeComment => ({
  parentCommentId: null,
  content: commentBody(`Comment ${fields.id}`),
  selection: null,
  type: 'page',
  creatorId: ACCOUNT.id,
  resolvedAt: null,
  createdAt: START_TIME,
  editedAt: null,
  ...fields,
});

export const commentMark = (commentId: string, resolved = false): EditorMark => ({
  type: 'comment',
  attrs: { commentId, resolved },
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isYjsId = (value: unknown): boolean =>
  isRecord(value) && Number.isInteger(value.client) && Number.isInteger(value.clock);

// Docmost's yjsSelectionSchema: all four fields are required, so a short position leaves the comment unanchored.
const isYjsPosition = (value: unknown): boolean =>
  isRecord(value) &&
  isYjsId(value.type) &&
  'tname' in value &&
  (value.tname === null || typeof value.tname === 'string') &&
  'item' in value &&
  (value.item === null || isYjsId(value.item)) &&
  Number.isInteger(value.assoc);

const allTexts = (parent: Y.XmlFragment | Y.XmlElement): Y.XmlText[] =>
  parent
    .toArray()
    .flatMap((child) => (child instanceof Y.XmlText ? [child] : child instanceof Y.XmlElement ? allTexts(child) : []));

const updateCommentMarks = (fragment: Y.XmlFragment, commentId: string, resolved: boolean) => {
  for (const run of allTexts(fragment)) {
    const delta: unknown = run.toDelta();
    let position = 0;
    for (const operation of Array.isArray(delta) ? delta : []) {
      const length = isRecord(operation) && typeof operation.insert === 'string' ? operation.insert.length : 1;
      const mark = isRecord(operation) && isRecord(operation.attributes) ? operation.attributes.comment : undefined;
      if (isRecord(mark) && mark.commentId === commentId) {
        run.format(position, length, { comment: { ...mark, resolved } });
      }
      position += length;
    }
  }
};

const isEditorNode = (value: unknown): value is EditorNode => isRecord(value) && typeof value.type === 'string';

const fillYjs = (parent: Y.XmlFragment | Y.XmlElement, nodes: EditorNode[], pieces: 'run' | 'node') => {
  let run: Y.XmlText | undefined;
  for (const node of nodes) {
    if (node.type === 'text') {
      if (run === undefined || pieces === 'node') {
        run = new Y.XmlText();
        parent.insert(parent.length, [run]);
      }
      const attributes = Object.fromEntries((node.marks ?? []).map((mark) => [mark.type, mark.attrs ?? {}]));
      run.insert(run.length, node.text ?? '', attributes);
      continue;
    }
    run = undefined;
    const element = new Y.XmlElement(node.type);
    parent.insert(parent.length, [element]);
    for (const [name, value] of Object.entries(node.attrs ?? {})) {
      Reflect.apply(element.setAttribute, element, [name, value]);
    }
    fillYjs(element, node.content ?? [], pieces);
  }
};

const fromYjs = (parent: Y.XmlFragment | Y.XmlElement): EditorNode[] =>
  parent.toArray().flatMap((child): EditorNode[] => {
    if (child instanceof Y.XmlText) {
      const delta: unknown = child.toDelta();
      return (Array.isArray(delta) ? delta : []).flatMap((operation: unknown) => {
        if (!isRecord(operation) || typeof operation.insert !== 'string') {
          return [];
        }
        const attributes = isRecord(operation.attributes) ? operation.attributes : {};
        const marks = Object.entries(attributes).map(([type, attrs]) =>
          isRecord(attrs) && Object.keys(attrs).length > 0 ? { type, attrs } : { type },
        );
        return [text(operation.insert, marks.length > 0 ? marks : undefined)];
      });
    }
    if (!(child instanceof Y.XmlElement)) {
      return [];
    }
    const attrs = child.getAttributes();
    const content = fromYjs(child);
    return [
      {
        type: child.nodeName,
        ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
        ...(content.length > 0 ? { content } : {}),
      },
    ];
  });

const readVarUint = (bytes: Uint8Array, start: number): [number, number] => {
  let value = 0;
  let shift = 0;
  let position = start;
  for (;;) {
    const byte = bytes[position] ?? 0;
    position += 1;
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (byte < 0x80) {
      return [value, position];
    }
  }
};

const isDocumentUpdate = (message: Uint8Array): boolean => {
  const [nameLength, afterLength] = readVarUint(message, 0);
  const [messageType, afterType] = readVarUint(message, afterLength + nameLength);
  const [syncType] = readVarUint(message, afterType);
  return messageType === 0 && syncType === 2;
};

const readBody = (request: IncomingMessage) =>
  new Promise<Record<string, unknown>>((resolve) => {
    let rawBody = '';
    request.on('data', (chunk) => {
      rawBody += chunk;
    });
    request.on('end', () => {
      const parsedBody: unknown = rawBody === '' ? {} : JSON.parse(rawBody);
      resolve(isRecord(parsedBody) ? parsedBody : {});
    });
  });

export const startFakeDocmost = async (
  initialPages: FakePage[],
  options: {
    comments?: FakeComment[];
    members?: FakeMember[];
    spaces?: FakeSpace[];
    sidebarPageSize?: number;
    sidebarWithoutUpdatedAt?: boolean;
  } = {},
) => {
  const pages = initialPages.map((page) => structuredClone(page));
  const spaces = options.spaces ?? [{ id: SPACE_ID, name: 'General', slug: 'general' }];
  const comments = (options.comments ?? []).map((comment) => structuredClone(comment));
  const members = [ACCOUNT, ...(options.members ?? [])];
  let commentMarks: 'apply' | 'drop' = 'apply';
  let spaceAdmin = false;
  let resolveMode: 'updatesHighlight' | 'leavesHighlight' | 'unlicensed' = 'updatesHighlight';
  const requests: FakeRequest[] = [];
  const uploads: FakeUpload[] = [];
  const validTokens = new Set<string>();
  const collabTokens = new Set<string>();
  const unsavedStates = new Map<string, Uint8Array>();
  const upgradePaths: string[] = [];
  const hanging: (() => void)[] = [];
  let loginCount = 0;
  let collabTokenCount = 0;
  let clock = Date.parse(START_TIME);
  let updateRejection: { status: number; message: string } | undefined;
  let collabMode: CollabMode = 'normal';
  const requestHooks: ((request: FakeRequest) => void)[] = [];

  const hang = () => new Promise<void>((resolve) => hanging.push(resolve));
  const findPage = (reference: unknown) => pages.find((page) => page.id === reference || page.slugId === reference);

  const pageInfo = ({ markdown, json, textPieces: _pieces, ...fields }: FakePage, format: unknown) => ({
    ...fields,
    content: format === 'markdown' ? markdown : json,
  });

  const cursorPage = <Item>(items: Item[], body: Record<string, unknown>, fixedLimit?: number) => {
    const limit = fixedLimit ?? (typeof body.limit === 'number' ? body.limit : 20);
    const start = typeof body.cursor === 'string' ? Number(body.cursor) : 0;
    const hasNextPage = start + limit < items.length;
    return {
      items: items.slice(start, start + limit),
      meta: { hasNextPage, nextCursor: hasNextPage ? String(start + limit) : null },
    };
  };

  const sidebarView = (page: FakePage) => ({
    id: page.id,
    slugId: page.slugId,
    title: page.title,
    spaceId: page.spaceId,
    parentPageId: page.parentPageId,
    hasChildren: pages.some((child) => child.parentPageId === page.id),
    ...(options.sidebarWithoutUpdatedAt ? {} : { updatedAt: page.updatedAt }),
  });

  const touch = (page: FakePage) => {
    clock += 1000;
    page.updatedAt = new Date(clock).toISOString();
  };

  const server = new Server({
    port: 0,
    address: '127.0.0.1',
    quiet: true,
    stopOnSignals: false,
    async onRequest({ request, response }) {
      await handleRest(request, response);
      throw null;
    },
    async onUpgrade({ request, socket }) {
      upgradePaths.push(request.url ?? '');
      if (collabMode === 'notFound') {
        socket.write('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
        socket.destroy();
        throw null;
      }
    },
    async onAuthenticate({ token, connectionConfig }) {
      if (collabMode === 'rejectToken' || !collabTokens.has(token)) {
        throw new Error('Invalid collab token');
      }
      if (collabMode === 'readOnly') {
        connectionConfig.readOnly = true;
      }
    },
    async onLoadDocument({ document, documentName }) {
      if (collabMode === 'neverSync') {
        await hang();
      }
      const page = findPage(documentName.replace(/^page\./, ''));
      const unsaved = page ? unsavedStates.get(page.id) : undefined;
      if (unsaved !== undefined) {
        Y.applyUpdate(document, unsaved);
      } else if (page?.json) {
        fillYjs(document.getXmlFragment('default'), page.json.content ?? [], page.textPieces ?? 'run');
      }
    },
    async onStoreDocument({ document, documentName }) {
      unsavedStates.set(documentName.replace(/^page\./, ''), Y.encodeStateAsUpdate(document));
    },
    async beforeHandleMessage({ update }) {
      if (collabMode === 'neverConfirm' && isDocumentUpdate(update)) {
        await hang();
      }
    },
  });

  const withLiveDocument = (page: FakePage, change: (fragment: Y.XmlFragment) => void) => {
    const loaded = server.hocuspocus.documents.get(`page.${page.id}`);
    if (loaded !== undefined) {
      loaded.transact(() => change(loaded.getXmlFragment('default')));
      return;
    }
    const unsaved = unsavedStates.get(page.id);
    if (unsaved === undefined) {
      return;
    }
    const detached = new Y.Doc();
    Y.applyUpdate(detached, unsaved);
    change(detached.getXmlFragment('default'));
    unsavedStates.set(page.id, Y.encodeStateAsUpdate(detached));
  };

  const liveJson = (page: FakePage): EditorNode | undefined => {
    let json: EditorNode | undefined;
    withLiveDocument(page, (fragment) => {
      json = doc(...fromYjs(fragment));
    });
    return json;
  };

  const saveLive = (page: FakePage) => {
    const json = liveJson(page);
    if (json !== undefined) {
      page.json = json;
      touch(page);
    }
  };

  const applyUpdate = (page: FakePage, body: Record<string, unknown>) => {
    if (typeof body.title === 'string') {
      page.title = body.title;
    }
    if (body.content === undefined) {
      return;
    }
    saveLive(page);
    if (body.format === 'json' && isEditorNode(body.content)) {
      page.json = body.content;
    } else if (typeof body.content === 'string') {
      const added = paragraphsFrom(body.content);
      const existing = page.json?.content ?? [];
      if (body.operation === 'append' || body.operation === 'prepend') {
        const isAppend = body.operation === 'append';
        page.markdown = isAppend ? `${page.markdown}\n\n${body.content}` : `${body.content}\n\n${page.markdown}`;
        page.json = doc(...(isAppend ? [...existing, ...added] : [...added, ...existing]));
        withLiveDocument(page, (fragment) => {
          const before = fragment.length;
          fillYjs(fragment, added, page.textPieces ?? 'run');
          if (!isAppend) {
            const inserted = fragment
              .toArray()
              .slice(before)
              .flatMap((node) => (node instanceof Y.XmlElement || node instanceof Y.XmlText ? [node.clone()] : []));
            fragment.delete(before, fragment.length - before);
            fragment.insert(0, inserted);
          }
        });
        return;
      }
      page.markdown = body.content;
      page.json = doc(...added);
    }
    const json = page.json;
    withLiveDocument(page, (fragment) => {
      fragment.delete(0, fragment.length);
      fillYjs(fragment, json?.content ?? [], page.textPieces ?? 'run');
    });
  };

  const send = (response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    response.writeHead(status, { 'content-type': 'application/json', ...headers });
    response.end(JSON.stringify(body));
  };

  const commentView = (comment: FakeComment) => ({
    ...comment,
    creator: members.find((member) => member.id === comment.creatorId) ?? null,
  });

  const setCommentMark = (page: FakePage, selection: unknown, commentId: string) => {
    if (!isRecord(selection) || !isYjsPosition(selection.anchor) || !isYjsPosition(selection.head)) {
      return;
    }
    withLiveDocument(page, (fragment) => {
      const ydoc = fragment.doc;
      if (ydoc === null) {
        return;
      }
      const [anchor, head] = [selection.anchor, selection.head].map((position) =>
        Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(position), ydoc),
      );
      if (anchor && head && anchor.type === head.type && anchor.type instanceof Y.XmlText) {
        const from = Math.min(anchor.index, head.index);
        anchor.type.format(from, Math.abs(head.index - anchor.index), { comment: { commentId, resolved: false } });
      }
    });
  };

  const handleComment = (endpoint: string, body: Record<string, unknown>, response: ServerResponse) => {
    const comment = comments.find((candidate) => candidate.id === body.commentId);
    if (comment === undefined) {
      send(response, 404, { message: 'Comment not found' });
      return;
    }
    if (endpoint === '/comments/info') {
      send(response, 200, { data: commentView(comment) });
      return;
    }
    if (endpoint === '/comments/update') {
      if (comment.creatorId !== ACCOUNT.id) {
        send(response, 403, { message: 'You can only edit your own comments' });
        return;
      }
      comment.content = typeof body.content === 'string' ? JSON.parse(body.content) : body.content;
      comment.editedAt = new Date(clock).toISOString();
      send(response, 200, { data: commentView(comment) });
      return;
    }
    if (endpoint === '/comments/delete') {
      if (comment.creatorId !== ACCOUNT.id && !spaceAdmin) {
        send(response, 403, { message: 'You can only delete your own comments' });
        return;
      }
      const removed = new Set([comment.id, ...comments.filter((reply) => reply.parentCommentId === comment.id).map((reply) => reply.id)]);
      comments.splice(0, comments.length, ...comments.filter((candidate) => !removed.has(candidate.id)));
      send(response, 200, {});
      return;
    }
    if (endpoint === '/comments/resolve') {
      if (resolveMode === 'unlicensed') {
        send(response, 403, { message: 'This feature requires a valid license.' });
        return;
      }
      if (comment.parentCommentId !== null) {
        send(response, 400, { message: 'Cannot resolve reply comments' });
        return;
      }
      const resolved = body.resolved === true;
      comment.resolvedAt = resolved ? new Date(clock).toISOString() : null;
      const page = findPage(comment.pageId);
      if (page && resolveMode === 'updatesHighlight') {
        withLiveDocument(page, (fragment) => updateCommentMarks(fragment, comment.id, resolved));
      }
      send(response, 200, { data: commentView(comment) });
      return;
    }
    send(response, 404, { message: `No fake for ${endpoint}` });
  };

  const createComment = (page: FakePage, body: Record<string, unknown>, response: ServerResponse) => {
    if (typeof body.parentCommentId === 'string') {
      const parent = comments.find((candidate) => candidate.id === body.parentCommentId);
      if (parent === undefined || parent.pageId !== page.id) {
        send(response, 400, { message: 'Parent comment not found' });
        return;
      }
      if (parent.parentCommentId !== null) {
        send(response, 400, { message: 'You cannot reply to a reply' });
        return;
      }
    }
    if (typeof body.content !== 'string') {
      send(response, 400, { message: ['content must be a JSON string'] });
      return;
    }
    clock += 1000;
    const comment = makeComment({
      id: `comment-${comments.length + 1}`,
      pageId: page.id,
      parentCommentId: typeof body.parentCommentId === 'string' ? body.parentCommentId : null,
      content: JSON.parse(body.content),
      selection: typeof body.selection === 'string' ? body.selection : null,
      type: typeof body.type === 'string' ? body.type : 'page',
      createdAt: new Date(clock).toISOString(),
    });
    comments.push(comment);
    if (body.yjsSelection !== undefined && commentMarks === 'apply') {
      setCommentMark(page, body.yjsSelection, comment.id);
    }
    send(response, 200, { data: commentView(comment) });
  };

  const handle = (endpoint: string, body: Record<string, unknown>, token: string | undefined, response: ServerResponse) => {
    if (endpoint === '/auth/login') {
      loginCount += 1;
      if (body.email !== EMAIL || body.password !== PASSWORD) {
        send(response, 401, { message: 'Email or password does not match' });
        return;
      }
      const newToken = `token-${loginCount}`;
      validTokens.add(newToken);
      send(response, 200, { data: {} }, { 'set-cookie': `authToken=${newToken}; Path=/; HttpOnly` });
      return;
    }
    if (token === undefined || !validTokens.has(token)) {
      send(response, 401, { message: 'Unauthorized' });
      return;
    }
    if (endpoint === '/auth/collab-token') {
      collabTokenCount += 1;
      const collabToken = `collab-${collabTokenCount}`;
      collabTokens.add(collabToken);
      send(response, 200, { data: { token: collabToken } });
      return;
    }
    if (endpoint === '/spaces') {
      send(response, 200, { data: cursorPage(spaces, body) });
      return;
    }
    if (endpoint === '/search') {
      const query = typeof body.query === 'string' ? body.query.toLowerCase() : '';
      const limit = typeof body.limit === 'number' ? body.limit : 25;
      const offset = typeof body.offset === 'number' ? body.offset : 0;
      const matches = pages.filter(
        (page) =>
          (body.spaceId === undefined || page.spaceId === body.spaceId) &&
          `${page.title}\n${page.markdown}`.toLowerCase().includes(query),
      );
      send(response, 200, {
        data: {
          items: matches.slice(offset, offset + limit).map((page) => ({
            id: page.id,
            slugId: page.slugId,
            title: page.title,
            parentPageId: page.parentPageId,
            updatedAt: page.updatedAt,
            highlight: `<b>${query}</b>`,
            space: spaces.find((space) => space.id === page.spaceId) ?? null,
          })),
        },
      });
      return;
    }
    if (endpoint === '/pages/sidebar-pages' && body.pageId === undefined) {
      send(response, 200, {
        data: cursorPage(
          pages.filter((page) => page.spaceId === body.spaceId && page.parentPageId === null).map(sidebarView),
          body,
          options.sidebarPageSize,
        ),
      });
      return;
    }
    if (endpoint === '/pages/create') {
      const page = makePage({
        id: `created${pages.length + 1}`,
        title: typeof body.title === 'string' ? body.title : '',
        spaceId: typeof body.spaceId === 'string' ? body.spaceId : SPACE_ID,
        parentPageId: typeof body.parentPageId === 'string' ? body.parentPageId : null,
        markdown: typeof body.content === 'string' ? body.content : '',
      });
      touch(page);
      pages.push(page);
      send(response, 200, { data: pageInfo(page, body.format) });
      return;
    }
    if (endpoint === '/search/suggest') {
      const query = typeof body.query === 'string' ? body.query.toLowerCase() : '';
      const users = body.includeUsers === true ? members.filter((member) => member.name.toLowerCase().includes(query)) : [];
      send(response, 200, { data: { users: users.slice(0, typeof body.limit === 'number' ? body.limit : 10), pages: [] } });
      return;
    }
    if (endpoint.startsWith('/comments/') && endpoint !== '/comments/create') {
      handleComment(endpoint, body, response);
      return;
    }
    const page = findPage(body.pageId);
    if (page === undefined) {
      send(response, 404, { message: 'Page not found' });
      return;
    }
    if (endpoint === '/comments') {
      send(response, 200, {
        data: cursorPage(comments.filter((comment) => comment.pageId === page.id).map(commentView), body),
      });
      return;
    }
    if (endpoint === '/comments/create') {
      createComment(page, body, response);
      return;
    }
    if (endpoint === '/pages/sidebar-pages') {
      send(response, 200, {
        data: cursorPage(
          pages.filter((child) => child.parentPageId === page.id).map(sidebarView),
          body,
          options.sidebarPageSize,
        ),
      });
      return;
    }
    if (endpoint === '/pages/info') {
      send(response, 200, { data: pageInfo(page, body.format) });
      return;
    }
    if (endpoint === '/pages/update') {
      if (updateRejection !== undefined) {
        send(response, updateRejection.status, { message: updateRejection.message });
        return;
      }
      applyUpdate(page, body);
      touch(page);
      send(response, 200, { data: pageInfo(page, body.format) });
      return;
    }
    send(response, 404, { message: `No fake for ${endpoint}` });
  };

  const handleUpload = async (request: IncomingMessage, token: string | undefined, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    if (token === undefined || !validTokens.has(token)) {
      send(response, 401, { message: 'Unauthorized' });
      return;
    }
    const form = await new Response(Buffer.concat(chunks), {
      headers: { 'content-type': request.headers['content-type'] ?? '' },
    }).formData();
    const file = form.get('file');
    const page = findPage(form.get('pageId'));
    if (!(file instanceof File)) {
      send(response, 400, { message: 'Failed to upload file' });
      return;
    }
    if (page === undefined) {
      send(response, 404, { message: 'Page not found' });
      return;
    }
    const id = `attachment-${uploads.length + 1}`;
    uploads.push({
      fields: [...form.keys()],
      pageId: page.id,
      fileName: file.name,
      type: file.type,
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
    send(response, 200, {
      id,
      fileName: file.name,
      mimeType: file.type,
      fileSize: String(file.size),
      pageId: page.id,
      url: `${url}/api/files/${id}/${encodeURIComponent(file.name)}`,
    });
  };

  const handleRest = async (request: IncomingMessage, response: ServerResponse) => {
    const endpoint = (request.url ?? '').replace(/^\/api/, '');
    const token = request.headers.authorization?.replace(/^Bearer /, '');
    if (endpoint === '/files/upload') {
      requests.push({ endpoint, body: {} });
      await handleUpload(request, token, response);
      return;
    }
    const body = await readBody(request);
    requests.push({ endpoint, body });
    requestHooks.forEach((hook) => hook({ endpoint, body }));
    handle(endpoint, body, token, response);
  };

  await server.listen();
  const url = `http://127.0.0.1:${server.address.port}`;

  return {
    url,
    requests,
    upgradePaths,
    writes: () => requests.filter((entry) => entry.endpoint === '/pages/update'),
    uploads: () => uploads,
    loginCount: () => loginCount,
    revokeTokens: () => validTokens.clear(),
    rejectUpdates: (status: number, message: string) => {
      updateRejection = { status, message };
    },
    setCollabMode: (mode: CollabMode) => {
      collabMode = mode;
    },
    issueCollabToken: () => {
      collabTokenCount += 1;
      const collabToken = `collab-${collabTokenCount}`;
      collabTokens.add(collabToken);
      return collabToken;
    },
    liveJson: (reference: string) => {
      const page = findPage(reference);
      return page ? liveJson(page) : undefined;
    },
    saveLive: (reference: string) => {
      const page = findPage(reference);
      if (page) {
        saveLive(page);
      }
    },
    connectionCount: () => server.hocuspocus.getConnectionsCount(),
    onRequest: (hook: (request: FakeRequest) => void) => {
      requestHooks.push(hook);
    },
    page: (reference: string) => findPage(reference),
    comments: () => comments.map((comment) => structuredClone(comment)),
    commentWrites: () =>
      requests.filter((entry) => ['/comments/create', '/comments/update', '/comments/delete', '/comments/resolve'].includes(entry.endpoint)),
    dropCommentMarks: () => {
      commentMarks = 'drop';
    },
    makeSpaceAdmin: () => {
      spaceAdmin = true;
    },
    setResolveMode: (mode: 'updatesHighlight' | 'leavesHighlight' | 'unlicensed') => {
      resolveMode = mode;
    },
    close: async () => {
      hanging.forEach((release) => release());
      server.hocuspocus.closeConnections();
      server.httpServer.closeAllConnections();
      await server.destroy();
    },
  };
};

export type FakeDocmost = Awaited<ReturnType<typeof startFakeDocmost>>;
