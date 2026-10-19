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
});

const pageReferenceSchema = z
  .string()
  .min(1)
  .describe('Page id, slug id, or the full page URL copied from the browser.');

const server = new McpServer({ name: 'docmost', version: '0.1.0' });

server.registerTool(
  'list_spaces',
  {
    title: 'List Docmost spaces',
    description: 'Lists the Docmost spaces this account can see, with the space ids the other tools take.',
    inputSchema: {},
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
    description: 'Returns a page as Markdown along with its id, space, parent and URL.',
    inputSchema: { pageId: pageReferenceSchema },
  },
  ({ pageId }) =>
    runTool(async (client) => {
      const page = await client.getPage(pageId);
      return `${toJson({ ...summarizePage(client, page), updatedAt: page.updatedAt ?? null })}\n\n---\n\n${page.markdown}`;
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
    description: 'Replaces, appends to or prepends to a page body in Markdown, and can rename it or change its icon.',
    inputSchema: {
      pageId: pageReferenceSchema,
      markdown: z.string().min(1).optional().describe('New Markdown content; omit to change only the title or icon.'),
      operation: z
        .enum(['replace', 'append', 'prepend'])
        .optional()
        .describe('How markdown is applied to the existing body; defaults to replace.'),
      title: z.string().min(1).optional().describe('New page title.'),
      icon: z.string().optional().describe('New emoji icon.'),
    },
  },
  ({ pageId, markdown, operation, title, icon }) =>
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
      });
      return toJson(summarizePage(client, updatedPage));
    }),
);

await server.connect(new StdioServerTransport());
