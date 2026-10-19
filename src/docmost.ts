import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import type { DocmostConfig } from './config.js';

const MAX_LIST_ITEMS = 1000;
const PAGE_SIZE = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const errorBodySchema = z.object({
  message: z.union([z.string(), z.array(z.string())]),
});

const loginBodySchema = z.object({
  data: z
    .object({
      userHasMfa: z.boolean().optional(),
      requiresMfaSetup: z.boolean().optional(),
    })
    .nullish(),
});

const sessionFileSchema = z.object({
  baseUrl: z.string(),
  email: z.string(),
  token: z.string(),
});

const paginatedSchema = <ItemSchema extends z.ZodType>(itemSchema: ItemSchema) =>
  z.object({
    items: z.array(itemSchema),
    meta: z.object({
      hasNextPage: z.boolean(),
      nextCursor: z.string().nullish(),
    }),
  });

const spaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullish(),
});

const treePageSchema = z.object({
  id: z.string(),
  slugId: z.string(),
  title: z.string().nullish(),
  icon: z.string().nullish(),
  parentPageId: z.string().nullish(),
  hasChildren: z.boolean().nullish(),
});

const searchResultSchema = z.object({
  id: z.string(),
  slugId: z.string().nullish(),
  title: z.string().nullish(),
  highlight: z.string().nullish(),
  parentPageId: z.string().nullish(),
  updatedAt: z.string().nullish(),
  space: z
    .object({
      id: z.string().nullish(),
      name: z.string().nullish(),
      slug: z.string().nullish(),
    })
    .nullish(),
});

const pageSchema = z.object({
  id: z.string(),
  slugId: z.string(),
  title: z.string().nullish(),
  icon: z.string().nullish(),
  spaceId: z.string(),
  parentPageId: z.string().nullish(),
  content: z.unknown().optional(),
  updatedAt: z.string().nullish(),
  space: z
    .object({
      name: z.string().nullish(),
      slug: z.string().nullish(),
    })
    .nullish(),
});

export type DocmostSpace = z.infer<typeof spaceSchema>;
export type DocmostTreePage = z.infer<typeof treePageSchema>;
export type DocmostSearchResult = z.infer<typeof searchResultSchema>;
export type DocmostPage = Omit<z.infer<typeof pageSchema>, 'content'> & { markdown: string };

export type ContentOperation = 'replace' | 'append' | 'prepend';

export type CreatePageInput = {
  spaceId?: string;
  parentPageId?: string;
  title: string;
  markdown: string;
  icon?: string;
};

export type UpdatePageInput = {
  pageId: string;
  title?: string;
  markdown?: string;
  operation: ContentOperation;
  icon?: string;
};

export class DocmostError extends Error {}

const readErrorMessage = async (response: Response): Promise<string> => {
  const rawBody = await response.text();
  try {
    const parsedBody = errorBodySchema.safeParse(JSON.parse(rawBody));
    if (parsedBody.success) {
      const { message } = parsedBody.data;
      return Array.isArray(message) ? message.join('; ') : message;
    }
  } catch {
    // body was not JSON; fall through to the raw text
  }
  return rawBody.slice(0, 300) || response.statusText;
};

const request = async (url: string, init: RequestInit): Promise<Response> => {
  try {
    return await fetch(url, init);
  } catch (error) {
    const reason = error instanceof Error && error.cause instanceof Error ? error.cause.message : String(error);
    throw new DocmostError(`Could not reach ${url}: ${reason}`);
  }
};

const EMPTY_TABLE_ROW = /^\|(?:\s*\|)+$/;
const TABLE_SEPARATOR_ROW = /^\|(?:\s*:?-+:?\s*\|)+$/;
const TABLE_ROW = /^\|.*\|$/;

// Docmost exports a header row as an empty header followed by that row in the body; writing it back would add a blank header row.
export const restoreTableHeaders = (markdown: string): string => {
  const lines = markdown.split('\n');
  for (let lineIndex = 0; lineIndex + 2 < lines.length; lineIndex++) {
    const headerRow = lines[lineIndex] ?? '';
    const separatorRow = lines[lineIndex + 1] ?? '';
    const firstBodyRow = lines[lineIndex + 2] ?? '';
    if (EMPTY_TABLE_ROW.test(headerRow) && TABLE_SEPARATOR_ROW.test(separatorRow) && TABLE_ROW.test(firstBodyRow)) {
      lines.splice(lineIndex, 3, firstBodyRow, separatorRow);
    }
  }
  return lines.join('\n');
};

const toPage = ({ content, ...page }: z.infer<typeof pageSchema>): DocmostPage => ({
  ...page,
  markdown: typeof content === 'string' ? restoreTableHeaders(content) : '',
});

export const normalizePageReference = (pageReference: string): string => {
  const trimmedReference = pageReference.trim();
  const pathMatch = trimmedReference.match(/\/p\/([^/?#]+)/);
  if (!pathMatch?.[1]) {
    return trimmedReference;
  }
  const pageSlug = pathMatch[1];
  return pageSlug.slice(pageSlug.lastIndexOf('-') + 1);
};

export const createDocmostClient = (config: DocmostConfig) => {
  let authToken: string | undefined;

  const readCachedToken = async (): Promise<string | undefined> => {
    try {
      const cachedSession = sessionFileSchema.safeParse(
        JSON.parse(await readFile(config.sessionFile, 'utf8')),
      );
      if (
        cachedSession.success &&
        cachedSession.data.baseUrl === config.baseUrl &&
        cachedSession.data.email === config.email
      ) {
        return cachedSession.data.token;
      }
    } catch {
      // no usable cached session; a fresh login follows
    }
    return undefined;
  };

  const login = async (): Promise<string> => {
    const response = await request(`${config.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: config.email, password: config.password }),
    });
    if (!response.ok) {
      throw new DocmostError(`Docmost login failed (${response.status}): ${await readErrorMessage(response)}`);
    }

    const tokenCookie = response.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith('authToken='));
    const token = tokenCookie?.slice('authToken='.length).split(';')[0];
    if (!token) {
      const loginBody = loginBodySchema.safeParse(await response.json().catch(() => undefined));
      const needsMfa =
        loginBody.success && (loginBody.data.data?.userHasMfa || loginBody.data.data?.requiresMfaSetup);
      throw new DocmostError(
        needsMfa
          ? 'Docmost login needs MFA for this account, which this server cannot complete; use an account without MFA.'
          : 'Docmost login returned no session token.',
      );
    }

    await writeFile(
      config.sessionFile,
      JSON.stringify({ baseUrl: config.baseUrl, email: config.email, token }),
      { mode: 0o600 },
    ).catch(() => undefined);
    return token;
  };

  const getToken = async (): Promise<string> => {
    authToken ??= (await readCachedToken()) ?? (await login());
    return authToken;
  };

  const post = async <ResponseSchema extends z.ZodType>(
    endpoint: string,
    body: object,
    responseSchema: ResponseSchema,
  ): Promise<z.infer<ResponseSchema>> => {
    const send = (token: string) =>
      request(`${config.baseUrl}/api${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });

    let response = await send(await getToken());
    if (response.status === 401) {
      authToken = await login();
      response = await send(authToken);
    }
    if (!response.ok) {
      throw new DocmostError(`Docmost ${endpoint} failed (${response.status}): ${await readErrorMessage(response)}`);
    }

    const envelope = z.object({ data: z.unknown() }).safeParse(await response.json().catch(() => undefined));
    const parsedData = responseSchema.safeParse(envelope.success ? envelope.data.data : undefined);
    if (!parsedData.success) {
      throw new DocmostError(`Unexpected response from Docmost ${endpoint}: ${z.prettifyError(parsedData.error)}`);
    }
    return parsedData.data;
  };

  const collectAllPages = async <ItemSchema extends z.ZodType>(
    endpoint: string,
    body: object,
    itemSchema: ItemSchema,
  ): Promise<z.infer<ItemSchema>[]> => {
    const collectedItems: z.infer<ItemSchema>[] = [];
    let cursor: string | undefined;
    do {
      const result = await post(endpoint, { ...body, limit: PAGE_SIZE, cursor }, paginatedSchema(itemSchema));
      collectedItems.push(...result.items);
      cursor = result.meta.hasNextPage ? (result.meta.nextCursor ?? undefined) : undefined;
    } while (cursor && collectedItems.length < MAX_LIST_ITEMS);
    return collectedItems;
  };

  const pageUrl = (slugId: string): string => `${config.baseUrl}/p/${slugId}`;

  const listSpaces = (): Promise<DocmostSpace[]> => collectAllPages('/spaces', {}, spaceSchema);

  const searchPages = async (query: string, spaceId?: string, limit = 20): Promise<DocmostSearchResult[]> => {
    const result = await post('/search', { query, spaceId, limit }, z.object({ items: z.array(searchResultSchema) }));
    return result.items;
  };

  const getPage = async (pageId: string): Promise<DocmostPage> =>
    toPage(await post('/pages/info', { pageId: normalizePageReference(pageId), format: 'markdown' }, pageSchema));

  const resolvePageId = async (pageReference: string): Promise<string> => {
    const normalizedReference = normalizePageReference(pageReference);
    return UUID_PATTERN.test(normalizedReference) ? normalizedReference : (await getPage(normalizedReference)).id;
  };

  const listChildPages = async (target: { spaceId: string } | { parentPageId: string }): Promise<DocmostTreePage[]> =>
    collectAllPages(
      '/pages/sidebar-pages',
      'spaceId' in target ? { spaceId: target.spaceId } : { pageId: await resolvePageId(target.parentPageId) },
      treePageSchema,
    );

  const createPage = async (input: CreatePageInput): Promise<DocmostPage> => {
    let { spaceId, parentPageId } = input;
    if (parentPageId) {
      const parentPage = await getPage(parentPageId);
      if (spaceId && spaceId !== parentPage.spaceId) {
        throw new DocmostError(`Parent page ${parentPageId} is in space ${parentPage.spaceId}, not ${spaceId}.`);
      }
      parentPageId = parentPage.id;
      spaceId = parentPage.spaceId;
    }
    if (!spaceId) {
      throw new DocmostError('Provide spaceId, parentPageId, or both.');
    }

    return toPage(
      await post(
        '/pages/create',
        { spaceId, parentPageId, title: input.title, icon: input.icon, content: input.markdown, format: 'markdown' },
        pageSchema,
      ),
    );
  };

  const updatePage = async (input: UpdatePageInput): Promise<DocmostPage> => {
    const contentFields =
      input.markdown === undefined
        ? {}
        : { content: input.markdown, operation: input.operation, format: 'markdown' };
    return toPage(
      await post(
        '/pages/update',
        { pageId: normalizePageReference(input.pageId), title: input.title, icon: input.icon, ...contentFields },
        pageSchema,
      ),
    );
  };

  return { pageUrl, listSpaces, listChildPages, searchPages, getPage, createPage, updatePage };
};

export type DocmostClient = ReturnType<typeof createDocmostClient>;
