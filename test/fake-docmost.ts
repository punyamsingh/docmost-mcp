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

export type FakeRequest = { endpoint: string; body: Record<string, unknown> };

export type CollabMode = 'normal' | 'notFound' | 'neverSync' | 'rejectToken' | 'readOnly' | 'neverConfirm';

export const EMAIL = 'tester@example.test';
export const PASSWORD = 'correct-password';
export const SPACE_ID = 'space-1';
export const START_TIME = '2026-11-25T10:00:00.000Z';

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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

export const startFakeDocmost = async (initialPages: FakePage[]) => {
  const pages = initialPages.map((page) => structuredClone(page));
  const requests: FakeRequest[] = [];
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
      send(response, 200, {
        data: { items: [{ id: SPACE_ID, name: 'General', slug: 'general' }], meta: { hasNextPage: false } },
      });
      return;
    }
    if (endpoint === '/search') {
      send(response, 200, { data: { items: [] } });
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
    const page = findPage(body.pageId);
    if (page === undefined) {
      send(response, 404, { message: 'Page not found' });
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

  const handleRest = async (request: IncomingMessage, response: ServerResponse) => {
    const body = await readBody(request);
    const endpoint = (request.url ?? '').replace(/^\/api/, '');
    const token = request.headers.authorization?.replace(/^Bearer /, '');
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
    close: async () => {
      hanging.forEach((release) => release());
      server.hocuspocus.closeConnections();
      server.httpServer.closeAllConnections();
      await server.destroy();
    },
  };
};

export type FakeDocmost = Awaited<ReturnType<typeof startFakeDocmost>>;
