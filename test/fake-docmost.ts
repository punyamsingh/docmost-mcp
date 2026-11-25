import { createServer, type ServerResponse } from 'node:http';

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
};

export type FakeRequest = { endpoint: string; body: Record<string, unknown> };

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

export const startFakeDocmost = async (initialPages: FakePage[]) => {
  const pages = initialPages.map((page) => structuredClone(page));
  const requests: FakeRequest[] = [];
  const validTokens = new Set<string>();
  let loginCount = 0;
  let clock = Date.parse(START_TIME);
  let updateRejection: { status: number; message: string } | undefined;

  const findPage = (reference: unknown) => pages.find((page) => page.id === reference || page.slugId === reference);

  const pageInfo = ({ markdown, json, ...fields }: FakePage, format: unknown) => ({
    ...fields,
    content: format === 'markdown' ? markdown : json,
  });

  const touch = (page: FakePage) => {
    clock += 1000;
    page.updatedAt = new Date(clock).toISOString();
  };

  const applyUpdate = (page: FakePage, body: Record<string, unknown>) => {
    if (typeof body.title === 'string') {
      page.title = body.title;
    }
    if (body.format === 'json' && isEditorNode(body.content)) {
      page.json = body.content;
      return;
    }
    if (typeof body.content !== 'string') {
      return;
    }
    const added = paragraphsFrom(body.content);
    const existing = page.json?.content ?? [];
    if (body.operation === 'append') {
      page.markdown = `${page.markdown}\n\n${body.content}`;
      page.json = { type: 'doc', content: [...existing, ...added] };
    } else if (body.operation === 'prepend') {
      page.markdown = `${body.content}\n\n${page.markdown}`;
      page.json = { type: 'doc', content: [...added, ...existing] };
    } else {
      page.markdown = body.content;
      page.json = { type: 'doc', content: added };
    }
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

  const server = createServer((request, response) => {
    let rawBody = '';
    request.on('data', (chunk) => {
      rawBody += chunk;
    });
    request.on('end', () => {
      const parsedBody: unknown = rawBody === '' ? {} : JSON.parse(rawBody);
      const body = isRecord(parsedBody) ? parsedBody : {};
      const endpoint = (request.url ?? '').replace(/^\/api/, '');
      const token = request.headers.authorization?.replace(/^Bearer /, '');
      requests.push({ endpoint, body });
      handle(endpoint, body, token, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Fake Docmost did not get a TCP port.');
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    writes: () => requests.filter((entry) => entry.endpoint === '/pages/update'),
    loginCount: () => loginCount,
    revokeTokens: () => validTokens.clear(),
    rejectUpdates: (status: number, message: string) => {
      updateRejection = { status, message };
    },
    page: (reference: string) => findPage(reference),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

export type FakeDocmost = Awaited<ReturnType<typeof startFakeDocmost>>;
