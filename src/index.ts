#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { createDocmostClient, type DocmostClient, type DocmostPage } from './docmost.js';

let docmostClient: DocmostClient | undefined;

const getClient = (): DocmostClient => {
  docmostClient ??= createDocmostClient(loadConfig());
  return docmostClient;
};

const runTool = async (action: (client: DocmostClient) => Promise<string>): Promise<CallToolResult> => {
  try {
    return { content: [{ type: 'text', text: await action(getClient()) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: 'text', text: message }], isError: true };
  }
};

const toJson = (value: unknown): string => JSON.stringify(value, null, 2);

const summarizePage = (client: DocmostClient, page: DocmostPage) => ({
  id: page.id,
  slugId: page.slugId,
  title: page.title,
  spaceId: page.spaceId,
  parentPageId: page.parentPageId ?? null,
  url: client.pageUrl(page.slugId),
  updatedAt: page.updatedAt ?? null,
});

const DEFAULT_LINE_LIMIT = 500;
const MAX_WINDOW_CHARACTERS = 100_000;

const sliceLines = (markdown: string, offset: number, limit: number) => {
  const lines = markdown === '' ? [] : markdown.split('\n');
  const windowLines: string[] = [];
  let characterCount = 0;
  for (const line of lines.slice(offset - 1, offset - 1 + limit)) {
    if (characterCount + line.length > MAX_WINDOW_CHARACTERS) {
      if (windowLines.length === 0) {
        windowLines.push(line.slice(0, MAX_WINDOW_CHARACTERS));
      }
      break;
    }
    windowLines.push(line);
    characterCount += line.length + 1;
  }
  const lastLine = offset - 1 + windowLines.length;
  return {
    body: windowLines.join('\n'),
    firstLine: offset,
    lastLine,
    totalLines: lines.length,
    nextOffset: lastLine < lines.length ? lastLine + 1 : null,
  };
};

const pageReferenceSchema = z
  .string()
  .min(1)
  .describe('Page id, slug id, or the full page URL copied from the browser.');

const readOnlyAnnotations = { readOnlyHint: true, openWorldHint: true };

const server = new McpServer(
  { name: 'docmost', version: '0.1.0' },
  {
    instructions:
      'Docmost wiki access. Every page argument accepts a page id, slug id or page URL. Read a page with get_page before changing it. For small changes use edit_page with text copied exactly from get_page output. For whole-body rewrites use update_page with operation replace and pass the updatedAt from your read as expectedUpdatedAt. Markdown bodies must not repeat the page title as a leading # heading.',
  },
);

server.registerTool(
  'list_spaces',
  {
    title: 'List Docmost spaces',
    description: 'Lists the Docmost spaces this account can see, with the space ids the other tools take.',
    inputSchema: {},
    annotations: readOnlyAnnotations,
  },
  () => runTool(async (client) => toJson(await client.listSpaces())),
);

server.registerTool(
  'list_pages',
  {
    title: 'List Docmost pages',
    description: 'Lists the top-level pages of a space, or the direct children of a page when parentPageId is given.',
    inputSchema: {
      spaceId: z.string().optional().describe('Space id from list_spaces; lists the root pages of that space.'),
      parentPageId: pageReferenceSchema.optional().describe('Lists the direct children of this page instead.'),
    },
    annotations: readOnlyAnnotations,
  },
  ({ spaceId, parentPageId }) =>
    runTool(async (client) => {
      if (!spaceId && !parentPageId) {
        throw new Error('Provide spaceId or parentPageId.');
      }
      const pages = await client.listChildPages(parentPageId ? { parentPageId } : { spaceId: spaceId ?? '' });
      return toJson(
        pages.map((page) => ({
          id: page.id,
          slugId: page.slugId,
          title: page.title,
          hasChildren: page.hasChildren ?? false,
          url: client.pageUrl(page.slugId),
        })),
      );
    }),
);

server.registerTool(
  'search_pages',
  {
    title: 'Search Docmost pages',
    description: 'Full-text searches page titles and bodies, optionally within one space.',
    inputSchema: {
      query: z.string().min(1).max(200).describe('Words to search for.'),
      spaceId: z.string().optional().describe('Restrict the search to this space id.'),
      limit: z.number().int().min(1).max(100).optional().describe('Maximum results to return; defaults to 20.'),
    },
    annotations: readOnlyAnnotations,
  },
  ({ query, spaceId, limit }) =>
    runTool(async (client) => {
      const results = await client.searchPages(query, spaceId, limit);
      return toJson(
        results.map((result) => ({
          id: result.id,
          slugId: result.slugId,
          title: result.title,
          space: result.space?.name ?? null,
          highlight: result.highlight ?? null,
          url: result.slugId ? client.pageUrl(result.slugId) : null,
        })),
      );
    }),
);

server.registerTool(
  'get_page',
  {
    title: 'Read a Docmost page',
    description: 'Returns a window of a page as Markdown along with its id, space, parent, URL and line counts.',
    inputSchema: {
      pageId: pageReferenceSchema,
      offset: z.number().int().min(1).optional().describe('First line to return, starting at 1; defaults to 1.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .optional()
        .describe(`Number of lines to return; defaults to ${DEFAULT_LINE_LIMIT}.`),
    },
    annotations: readOnlyAnnotations,
  },
  ({ pageId, offset, limit }) =>
    runTool(async (client) => {
      const page = await client.getPage(pageId);
      const window = sliceLines(page.markdown, offset ?? 1, limit ?? DEFAULT_LINE_LIMIT);
      const header = toJson({
        ...summarizePage(client, page),
        totalLines: window.totalLines,
        nextOffset: window.nextOffset,
      });
      const continuation =
        window.nextOffset === null
          ? ''
          : `\n\n[lines ${window.firstLine}–${window.lastLine} of ${window.totalLines}; call get_page with offset ${window.nextOffset} for more]`;
      return `${header}\n\n---\n\n${window.body}${continuation}`;
    }),
);

server.registerTool(
  'create_page',
  {
    title: 'Create a Docmost page',
    description: 'Creates a page from Markdown at the root of a space or under a parent page, and returns its URL.',
    inputSchema: {
      title: z.string().min(1).describe('Page title.'),
      markdown: z.string().describe('Page body in Markdown; do not repeat the title as a leading # heading.'),
      spaceId: z.string().optional().describe('Space id from list_spaces; optional when parentPageId is given.'),
      parentPageId: pageReferenceSchema.optional().describe('Create the page under this page instead of at the space root.'),
      icon: z.string().optional().describe('Optional emoji shown next to the title.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  ({ title, markdown, spaceId, parentPageId, icon }) =>
    runTool(async (client) =>
      toJson(summarizePage(client, await client.createPage({ title, markdown, spaceId, parentPageId, icon }))),
    ),
);

server.registerTool(
  'update_page',
  {
    title: 'Update a Docmost page',
    description:
      'Replaces, appends to or prepends to a page body in Markdown, and can rename it or change its icon; a replace is refused on pages holding content Markdown cannot carry, such as mentions or comments.',
    inputSchema: {
      pageId: pageReferenceSchema,
      markdown: z.string().min(1).optional().describe('New Markdown content; omit to change only the title or icon.'),
      operation: z
        .enum(['replace', 'append', 'prepend'])
        .optional()
        .describe('How markdown is applied to the existing body; defaults to replace.'),
      title: z.string().min(1).optional().describe('New page title.'),
      icon: z.string().optional().describe('New emoji icon.'),
      expectedUpdatedAt: z
        .string()
        .optional()
        .describe('updatedAt from your last get_page; a replace is refused if the page changed since.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  ({ pageId, markdown, operation, title, icon, expectedUpdatedAt }) =>
    runTool(async (client) => {
      if (markdown === undefined && title === undefined && icon === undefined) {
        throw new Error('Provide at least one of markdown, title or icon.');
      }
      const updatedPage = await client.updatePage({
        pageId,
        markdown,
        operation: operation ?? 'replace',
        title,
        icon,
        expectedUpdatedAt,
      });
      return toJson(summarizePage(client, updatedPage));
    }),
);

server.registerTool(
  'edit_page',
  {
    title: 'Edit a Docmost page',
    description:
      'Replaces an exact piece of text in a page body with new Markdown by rewriting the whole body, and is refused on pages holding content Markdown cannot carry, such as mentions or comments.',
    inputSchema: {
      pageId: pageReferenceSchema,
      oldText: z.string().min(1).describe('Exact text to replace, copied from get_page output; must match once unless replaceAll is set.'),
      newText: z.string().describe('Replacement Markdown; an empty string deletes oldText.'),
      replaceAll: z.boolean().optional().describe('Replace every occurrence of oldText; defaults to false.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  ({ pageId, oldText, newText, replaceAll }) =>
    runTool(async (client) => {
      const { page, replacements } = await client.editPage({
        pageId,
        oldText,
        newText,
        replaceAll: replaceAll ?? false,
      });
      return toJson({ ...summarizePage(client, page), replacements });
    }),
);

await server.connect(new StdioServerTransport());
