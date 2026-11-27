#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { loadConfig, loadHttpConfig, packageVersion } from './config.js';
import {
  createDocmostClient,
  MAX_LIST_ITEMS,
  type DocmostClient,
  type DocmostLinkedPage,
  type DocmostPage,
} from './docmost.js';
import { startHttpServer } from './http.js';

console.log = console.error;

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

const listResult = (items: unknown[], complete: boolean, noun: string): string =>
  complete ? toJson(items) : `${toJson(items)}\n\n[first ${MAX_LIST_ITEMS} ${noun} only; the rest were not fetched]`;

const summarizePage = (client: DocmostClient, page: DocmostPage) => ({
  id: page.id,
  slugId: page.slugId,
  title: page.title,
  spaceId: page.spaceId,
  parentPageId: page.parentPageId ?? null,
  url: client.pageUrl(page.slugId),
  updatedAt: page.updatedAt ?? null,
});

const summarizeLinkedPage = (client: DocmostClient, page: DocmostLinkedPage) => ({
  id: page.id,
  slugId: page.slugId,
  title: page.title ?? null,
  spaceId: page.spaceId ?? null,
  space: page.space?.name ?? null,
  updatedAt: page.updatedAt ?? null,
  url: client.pageUrl(page.slugId),
});

const DEFAULT_LINE_LIMIT = 500;
const MAX_WINDOW_CHARACTERS = 100_000;

const splitLines = (markdown: string) => (markdown === '' ? [] : markdown.split('\n'));

const sliceLines = (markdown: string, offset: number, limit: number, endLine?: number) => {
  const lines = splitLines(markdown);
  const lastAllowedLine = endLine ?? lines.length;
  const windowLines: string[] = [];
  let characterCount = 0;
  for (const line of lines.slice(offset - 1, Math.min(offset - 1 + limit, lastAllowedLine))) {
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
    nextOffset: lastLine < lastAllowedLine ? lastLine + 1 : null,
  };
};

type Heading = { line: number; level: number; heading: string };

const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/;
const HEADING_PATTERN = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;

const outlineOf = (markdown: string): Heading[] => {
  const headings: Heading[] = [];
  let openFence: string | undefined;
  splitLines(markdown).forEach((text, index) => {
    const fence = FENCE_PATTERN.exec(text)?.[1];
    if (openFence !== undefined) {
      if (fence !== undefined && fence[0] === openFence[0] && fence.length >= openFence.length) {
        openFence = undefined;
      }
      return;
    }
    if (fence !== undefined) {
      openFence = fence;
      return;
    }
    const match = HEADING_PATTERN.exec(text);
    if (match?.[1] !== undefined) {
      headings.push({ line: index + 1, level: match[1].length, heading: (match[2] ?? '').trim() });
    }
  });
  return headings;
};

const normalizeHeading = (heading: string) =>
  heading
    .trim()
    .replace(/^#+\s*/, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();

const findSection = (outline: Heading[], section: string, totalLines: number) => {
  const matches = outline.filter((heading) => normalizeHeading(heading.heading) === normalizeHeading(section));
  const [match] = matches;
  if (match === undefined) {
    const headings = outline.slice(0, 50).map((heading) => `${heading.line} ${heading.heading}`);
    throw new Error(
      `No heading matches "${section}".${headings.length > 0 ? ` Headings by line: ${headings.join('; ')}.` : ' The page has no headings.'}`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `"${section}" matches ${matches.length} headings, at lines ${matches.map((heading) => heading.line).join(', ')}; read the one you want with offset and limit.`,
    );
  }
  const next = outline.find((heading) => heading.line > match.line && heading.level <= match.level);
  return { ...match, lastLine: next === undefined ? totalLines : next.line - 1 };
};

const pageReferenceSchema = z
  .string()
  .min(1)
  .describe('Page id, slug id, or the full page URL copied from the browser.');

const listLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(100)
  .optional()
  .describe('Maximum results to return; defaults to 20.');

const cursorSchema = z
  .string()
  .min(1)
  .optional()
  .describe('nextCursor from the previous call, to fetch the next results.');

const readOnlyAnnotations = { readOnlyHint: true, openWorldHint: true };

const commentIdSchema = z.string().min(1).describe('Comment id from list_comments.');

const commentTextSchema = z
  .string()
  .min(1)
  .describe(
    'Plain-text comment; blank lines start new paragraphs, and @[Full Name] mentions a member, which notifies them.',
  );

const commentWriteAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

const exportFormatSchema = z.enum(['markdown', 'html']).describe('File format of the exported pages.');

const outputPathSchema = z
  .string()
  .min(1)
  .describe(
    "File path on the machine running this server, or an existing folder to save under Docmost's file name; ~ means the home directory.",
  );

const overwriteSchema = z.boolean().optional().describe('Replace an existing file at that path; defaults to false.');

const exportAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

const createServer = (): McpServer => {
  const server = new McpServer(
    { name: 'docmost', version: packageVersion },
    {
      instructions:
        'Docmost wiki access. Every page argument accepts a page id, slug id or page URL. Read a page with get_page before changing it. For small changes use edit_page with text copied exactly from get_page output. For whole-body rewrites use update_page with operation replace and pass the updatedAt from your read as expectedUpdatedAt. To undo changes, find the revision with list_page_history and restore it with restore_page_revision. Markdown bodies must not repeat the page title as a leading # heading. To comment on a sentence, pass add_comment a quote copied from get_page.',
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
    () =>
      runTool(async (client) => {
        const { items, complete } = await client.listSpaces();
        return listResult(items, complete, 'spaces');
      }),
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
        const { items, complete } = await client.listChildPages(
          parentPageId ? { parentPageId } : { spaceId: spaceId ?? '' },
        );
        return listResult(
          items.map((page) => ({
            id: page.id,
            slugId: page.slugId,
            title: page.title,
            hasChildren: page.hasChildren ?? false,
            url: client.pageUrl(page.slugId),
            updatedAt: page.updatedAt ?? null,
          })),
          complete,
          'pages',
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
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Number of results to skip, for the next page of results; defaults to 0.'),
      },
      annotations: readOnlyAnnotations,
    },
    ({ query, spaceId, limit, offset }) =>
      runTool(async (client) => {
        const pageSize = limit ?? 20;
        const start = offset ?? 0;
        const results = await client.searchPages(query, spaceId, pageSize, start);
        const json = toJson(
          results.map((result) => ({
            id: result.id,
            slugId: result.slugId,
            title: result.title,
            spaceId: result.space?.id ?? null,
            space: result.space?.name ?? null,
            highlight: result.highlight ?? null,
            url: result.slugId ? client.pageUrl(result.slugId) : null,
            updatedAt: result.updatedAt ?? null,
          })),
        );
        return results.length < pageSize
          ? json
          : `${json}\n\n[call search_pages with offset ${start + pageSize} for more]`;
      }),
  );

  server.registerTool(
    'get_page',
    {
      title: 'Read a Docmost page',
      description:
        "Returns a window of a page as Markdown along with its id, space, parent, URL and line counts, or just one heading's section, or only the page's headings with their line numbers.",
      inputSchema: {
        pageId: pageReferenceSchema,
        offset: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('First line to return, starting at 1; defaults to 1, or to the section heading.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(2000)
          .optional()
          .describe(`Number of lines to return; defaults to ${DEFAULT_LINE_LIMIT}.`),
        section: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Heading text, ignoring case; returns from that heading to the next heading of the same or a higher level.',
          ),
        outline: z
          .boolean()
          .optional()
          .describe('Return only the headings, with their levels and line numbers, instead of the body.'),
      },
      annotations: readOnlyAnnotations,
    },
    ({ pageId, offset, limit, section, outline }) =>
      runTool(async (client) => {
        if (outline && section !== undefined) {
          throw new Error('Pass outline or section, not both.');
        }
        const page = await client.getPage(pageId);
        const totalLines = splitLines(page.markdown).length;
        if (outline) {
          return toJson({ ...summarizePage(client, page), totalLines, outline: outlineOf(page.markdown) });
        }
        const range = section === undefined ? undefined : findSection(outlineOf(page.markdown), section, totalLines);
        if (range !== undefined && offset !== undefined && (offset < range.line || offset > range.lastLine)) {
          throw new Error(
            `offset ${offset} is outside the section "${range.heading}", lines ${range.line}–${range.lastLine}.`,
          );
        }
        const window = sliceLines(
          page.markdown,
          offset ?? range?.line ?? 1,
          limit ?? DEFAULT_LINE_LIMIT,
          range?.lastLine,
        );
        const header = toJson({
          ...summarizePage(client, page),
          ...(range === undefined
            ? {}
            : { section: { heading: range.heading, firstLine: range.line, lastLine: range.lastLine } }),
          totalLines: window.totalLines,
          nextOffset: window.nextOffset,
        });
        const continuation =
          window.nextOffset === null
            ? ''
            : `\n\n[lines ${window.firstLine}–${window.lastLine} of ${window.totalLines}; call get_page with ${range === undefined ? '' : 'the same section and '}offset ${window.nextOffset} for more]`;
        return `${header}\n\n---\n\n${window.body}${continuation}`;
      }),
  );

  server.registerTool(
    'list_page_history',
    {
      title: 'List Docmost page history',
      description:
        "Lists a page's saved revisions, newest first, with each revision's id, title, author, contributors and time.",
      inputSchema: { pageId: pageReferenceSchema, limit: listLimitSchema, cursor: cursorSchema },
      annotations: readOnlyAnnotations,
    },
    ({ pageId, limit, cursor }) =>
      runTool(async (client) => {
        const { items, nextCursor } = await client.listPageHistory(pageId, limit ?? 20, cursor);
        return toJson({
          revisions: items.map((revision) => ({
            historyId: revision.id,
            title: revision.title ?? null,
            author: revision.lastUpdatedBy?.name ?? null,
            contributors: (revision.contributors ?? []).flatMap((contributor) =>
              contributor.name ? [contributor.name] : [],
            ),
            createdAt: revision.createdAt,
          })),
          nextCursor,
        });
      }),
  );

  server.registerTool(
    'get_page_revision',
    {
      title: 'Read a Docmost page revision',
      description:
        'Returns a window of one saved revision of a page as Markdown along with its title, author, time and line counts.',
      inputSchema: {
        historyId: z.string().min(1).describe('Revision id from list_page_history.'),
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
    ({ historyId, offset, limit }) =>
      runTool(async (client) => {
        const revision = await client.getPageRevision(historyId);
        const window = sliceLines(revision.markdown, offset ?? 1, limit ?? DEFAULT_LINE_LIMIT);
        const header = toJson({
          historyId: revision.id,
          pageId: revision.pageId,
          title: revision.title ?? null,
          author: revision.lastUpdatedBy?.name ?? null,
          createdAt: revision.createdAt,
          url: revision.slugId ? client.pageUrl(revision.slugId) : null,
          totalLines: window.totalLines,
          nextOffset: window.nextOffset,
        });
        const continuation =
          window.nextOffset === null
            ? ''
            : `\n\n[lines ${window.firstLine}–${window.lastLine} of ${window.totalLines}; call get_page_revision with offset ${window.nextOffset} for more]`;
        return `${header}\n\n---\n\n${window.body}${continuation}`;
      }),
  );

  server.registerTool(
    'restore_page_revision',
    {
      title: 'Restore a Docmost page revision',
      description:
        "Puts a saved revision back as a page's body and title, keeping diagrams, mentions and formatting, and is refused while an open editor holds unsaved typing.",
      inputSchema: {
        historyId: z.string().min(1).describe('Revision id from list_page_history.'),
        expectedUpdatedAt: z
          .string()
          .optional()
          .describe('updatedAt from your last get_page; the restore is refused if the page changed since.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    ({ historyId, expectedUpdatedAt }) =>
      runTool(async (client) => {
        const { page, revision, ...result } = await client.restorePageRevision({ historyId, expectedUpdatedAt });
        return toJson({
          ...summarizePage(client, page),
          restoredFrom: {
            historyId: revision.id,
            createdAt: revision.createdAt,
            author: revision.lastUpdatedBy?.name ?? null,
          },
          ...result,
        });
      }),
  );

  server.registerTool(
    'list_recent_pages',
    {
      title: 'List recent Docmost pages',
      description:
        'Lists the most recently updated pages across the spaces this account belongs to, or within one space, newest first.',
      inputSchema: {
        spaceId: z.string().optional().describe('Restrict the list to this space id.'),
        limit: listLimitSchema,
        cursor: cursorSchema,
      },
      annotations: readOnlyAnnotations,
    },
    ({ spaceId, limit, cursor }) =>
      runTool(async (client) => {
        const { items, nextCursor } = await client.listRecentPages(spaceId, limit ?? 20, cursor);
        return toJson({
          pages: items.map((page) => ({
            id: page.id,
            slugId: page.slugId,
            title: page.title ?? null,
            spaceId: page.spaceId,
            space: page.space?.name ?? null,
            parentPageId: page.parentPageId ?? null,
            updatedAt: page.updatedAt ?? null,
            lastUpdatedBy: page.lastUpdatedBy?.name ?? null,
            url: client.pageUrl(page.slugId),
          })),
          nextCursor,
        });
      }),
  );

  server.registerTool(
    'get_page_breadcrumbs',
    {
      title: 'Get Docmost page breadcrumbs',
      description:
        'Returns the path from the space root down to a page, listing each ancestor and then the page itself.',
      inputSchema: { pageId: pageReferenceSchema },
      annotations: readOnlyAnnotations,
    },
    ({ pageId }) =>
      runTool(async (client) => {
        const path = await client.getBreadcrumbs(pageId);
        return toJson({
          path: path.map((page) => ({
            id: page.id,
            slugId: page.slugId,
            title: page.title ?? null,
            hasChildren: page.hasChildren ?? false,
            url: client.pageUrl(page.slugId),
          })),
        });
      }),
  );

  server.registerTool(
    'get_current_user',
    {
      title: 'Get the current Docmost user',
      description:
        "Returns the Docmost account this server is logged in as, with its email, role, workspace and the workspace's member count.",
      inputSchema: {},
      annotations: readOnlyAnnotations,
    },
    () =>
      runTool(async (client) => {
        const { user, workspace } = await client.getCurrentUser();
        return toJson({
          id: user.id,
          name: user.name ?? null,
          email: user.email ?? null,
          role: user.role ?? null,
          workspaceId: workspace.id,
          workspace: workspace.name ?? null,
          memberCount: workspace.memberCount ?? null,
        });
      }),
  );

  server.registerTool(
    'list_workspace_members',
    {
      title: 'List Docmost workspace members',
      description: 'Lists the active members of the workspace with their names, emails and roles, sorted by name.',
      inputSchema: {
        query: z.string().min(1).optional().describe('Only members whose name or email contains this text.'),
        limit: listLimitSchema,
        cursor: cursorSchema,
      },
      annotations: readOnlyAnnotations,
    },
    ({ query, limit, cursor }) =>
      runTool(async (client) => {
        const { items, nextCursor } = await client.listWorkspaceMembers(query, limit ?? 20, cursor);
        return toJson({
          members: items.map((member) => ({
            id: member.id,
            name: member.name ?? null,
            email: member.email ?? null,
            role: member.role ?? null,
          })),
          nextCursor,
        });
      }),
  );

  server.registerTool(
    'get_backlinks',
    {
      title: 'Get Docmost page backlinks',
      description: 'Lists the pages that link to a page, or the pages it links to, most recently updated first.',
      inputSchema: {
        pageId: pageReferenceSchema,
        direction: z
          .enum(['incoming', 'outgoing'])
          .describe('incoming lists the pages linking to this page; outgoing lists the pages it links to.'),
        limit: listLimitSchema,
        cursor: cursorSchema,
      },
      annotations: readOnlyAnnotations,
    },
    ({ pageId, direction, limit, cursor }) =>
      runTool(async (client) => {
        const { items, nextCursor } = await client.getBacklinks(pageId, direction, limit ?? 20, cursor);
        return toJson({ pages: items.map((page) => summarizeLinkedPage(client, page)), nextCursor });
      }),
  );

  server.registerTool(
    'list_page_labels',
    {
      title: 'List Docmost page labels',
      description: 'Lists the labels on a page.',
      inputSchema: { pageId: pageReferenceSchema },
      annotations: readOnlyAnnotations,
    },
    ({ pageId }) => runTool(async (client) => toJson({ labels: await client.listPageLabels(pageId) })),
  );

  server.registerTool(
    'update_page_labels',
    {
      title: 'Update Docmost page labels',
      description:
        "Adds labels to a page and removes labels from it by name, refusing to remove a label the page doesn't have, and returns the page's labels afterwards.",
      inputSchema: {
        pageId: pageReferenceSchema,
        add: z
          .array(z.string().min(1))
          .min(1)
          .max(25)
          .optional()
          .describe(
            'Label names to add; Docmost lowercases them, turns spaces into hyphens and allows only letters, numbers, -, _ and ~.',
          ),
        remove: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .describe('Label names to remove; each must already be on the page.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ pageId, add, remove }) =>
      runTool(async (client) => {
        if (add === undefined && remove === undefined) {
          throw new Error('Provide add or remove.');
        }
        return toJson({ labels: await client.updatePageLabels({ pageId, add, remove }) });
      }),
  );

  server.registerTool(
    'find_pages_by_label',
    {
      title: 'Find Docmost pages by label',
      description: 'Lists the pages carrying a label, most recently updated first, optionally within one space.',
      inputSchema: {
        label: z.string().min(1).max(100).describe('Label name; case does not matter.'),
        spaceId: z.string().optional().describe('Restrict the list to this space id.'),
        limit: listLimitSchema,
        cursor: cursorSchema,
      },
      annotations: readOnlyAnnotations,
    },
    ({ label, spaceId, limit, cursor }) =>
      runTool(async (client) => {
        const { items, nextCursor } = await client.findPagesByLabel(label, spaceId, limit ?? 20, cursor);
        return toJson({ pages: items.map((page) => summarizeLinkedPage(client, page)), nextCursor });
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
        parentPageId: pageReferenceSchema
          .optional()
          .describe('Create the page under this page instead of at the space root.'),
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
        'Replaces an exact piece of text in a page, changing plain text in the live document so it merges with anyone editing and keeps comments, mentions and formatting, with Docmost saving it within 45 seconds, and rewriting the whole body from Markdown only when the change needs Markdown.',
      inputSchema: {
        pageId: pageReferenceSchema,
        oldText: z
          .string()
          .min(1)
          .describe('Exact text to replace, copied from get_page output; must match once unless replaceAll is set.'),
        newText: z.string().describe('Replacement Markdown; an empty string deletes oldText.'),
        replaceAll: z.boolean().optional().describe('Replace every occurrence of oldText; defaults to false.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    ({ pageId, oldText, newText, replaceAll }) =>
      runTool(async (client) => {
        const { page, ...result } = await client.editPage({
          pageId,
          oldText,
          newText,
          replaceAll: replaceAll ?? false,
        });
        return toJson({ ...summarizePage(client, page), ...result });
      }),
  );

  server.registerTool(
    'move_page',
    {
      title: 'Move a Docmost page',
      description:
        'Moves a page and its subpages under another page or to the root of a space, including into another space, placing it last among its new siblings.',
      inputSchema: {
        pageId: pageReferenceSchema,
        parentPageId: pageReferenceSchema
          .optional()
          .describe('Move the page under this page, in whichever space it is.'),
        spaceId: z
          .string()
          .optional()
          .describe('Space id from list_spaces; without parentPageId, moves the page to the root of this space.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ pageId, parentPageId, spaceId }) =>
      runTool(async (client) => {
        if (!parentPageId && !spaceId) {
          throw new Error('Provide parentPageId or spaceId.');
        }
        return toJson(summarizePage(client, await client.movePage({ pageId, parentPageId, spaceId })));
      }),
  );

  server.registerTool(
    'delete_page',
    {
      title: 'Delete a Docmost page',
      description:
        "Moves a page and its subpages to the space's trash, from which they can be restored, and never deletes anything permanently.",
      inputSchema: { pageId: pageReferenceSchema },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    ({ pageId }) =>
      runTool(async (client) => {
        const { page, alreadyInTrash } = await client.deletePage(pageId);
        return toJson({
          ...summarizePage(client, page),
          inTrash: true,
          ...(alreadyInTrash ? { note: 'The page was already in the trash.' } : {}),
        });
      }),
  );

  server.registerTool(
    'restore_page',
    {
      title: 'Restore a Docmost page',
      description:
        'Restores a page and its subpages from the trash to where they were, or to the space root when the old parent is still in the trash.',
      inputSchema: { pageId: pageReferenceSchema },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ pageId }) =>
      runTool(async (client) => {
        const { page, movedToSpaceRoot } = await client.restorePage(pageId);
        return toJson({
          ...summarizePage(client, page),
          ...(movedToSpaceRoot
            ? { note: 'Restored to the space root because its parent page is still in the trash.' }
            : {}),
        });
      }),
  );

  server.registerTool(
    'list_trash',
    {
      title: 'List Docmost trash',
      description:
        "Lists the pages in a space's trash, most recently deleted first, with the page ids restore_page takes; deleted subpages come back with their parent and aren't listed separately.",
      inputSchema: {
        spaceId: z.string().min(1).describe('Space id from list_spaces.'),
        limit: listLimitSchema,
        cursor: cursorSchema,
      },
      annotations: readOnlyAnnotations,
    },
    ({ spaceId, limit, cursor }) =>
      runTool(async (client) => {
        const { items, nextCursor } = await client.listTrash(spaceId, limit ?? 20, cursor);
        return toJson({
          pages: items.map((page) => ({
            id: page.id,
            slugId: page.slugId,
            title: page.title ?? null,
            parentPageId: page.parentPageId ?? null,
            deletedAt: page.deletedAt ?? null,
            deletedBy: page.deletedBy?.name ?? null,
            url: client.pageUrl(page.slugId),
          })),
          nextCursor,
        });
      }),
  );

  server.registerTool(
    'duplicate_page',
    {
      title: 'Duplicate a Docmost page',
      description:
        'Copies a page and its subpages, without their comments, next to the original as "Copy of" its title, or into another space or under a chosen page.',
      inputSchema: {
        pageId: pageReferenceSchema,
        parentPageId: pageReferenceSchema
          .optional()
          .describe('Put the copy under this page, in whichever space it is.'),
        spaceId: z
          .string()
          .optional()
          .describe(
            "Space id from list_spaces; without parentPageId, puts the copy at the end of this space's root pages.",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ pageId, parentPageId, spaceId }) =>
      runTool(async (client) => {
        const { page, ...result } = await client.duplicatePage({ pageId, parentPageId, spaceId });
        return toJson({ ...summarizePage(client, page), ...result });
      }),
  );

  server.registerTool(
    'list_comments',
    {
      title: 'List Docmost comments',
      description:
        'Lists the comment threads on a page with their replies, authors, text and the quoted text each one is attached to.',
      inputSchema: {
        pageId: pageReferenceSchema,
        includeResolved: z.boolean().optional().describe('Include resolved threads too; defaults to false.'),
      },
      annotations: readOnlyAnnotations,
    },
    ({ pageId, includeResolved }) =>
      runTool(async (client) => toJson({ threads: await client.listComments(pageId, includeResolved ?? false) })),
  );

  server.registerTool(
    'add_comment',
    {
      title: 'Add a Docmost comment',
      description:
        'Posts a comment on a page, attached to a quoted piece of text when quote is given, and notifies the people it mentions.',
      inputSchema: {
        pageId: pageReferenceSchema,
        text: commentTextSchema,
        quote: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Exact text to attach the comment to, copied from get_page; must appear once inside one paragraph or heading.',
          ),
      },
      annotations: commentWriteAnnotations,
    },
    ({ pageId, text, quote }) =>
      runTool(async (client) => {
        const { comment, ...anchoring } = await client.addComment({ pageId, text, quote });
        return toJson({
          id: comment.id,
          pageId: comment.pageId,
          type: comment.type ?? (quote ? 'inline' : 'page'),
          ...anchoring,
        });
      }),
  );

  server.registerTool(
    'reply_to_comment',
    {
      title: 'Reply to a Docmost comment',
      description: "Replies in a comment's thread, posting under the thread's top comment when given a reply's id.",
      inputSchema: { commentId: commentIdSchema, text: commentTextSchema },
      annotations: commentWriteAnnotations,
    },
    ({ commentId, text }) =>
      runTool(async (client) => {
        const { reply, threadId, postedToThread } = await client.replyToComment(commentId, text);
        return toJson({
          id: reply.id,
          threadId,
          ...(postedToThread ? { note: `Posted in thread ${threadId}, since replies are one level deep.` } : {}),
        });
      }),
  );

  server.registerTool(
    'edit_comment',
    {
      title: 'Edit a Docmost comment',
      description: "Replaces the text of one of this account's own comments.",
      inputSchema: { commentId: commentIdSchema, text: commentTextSchema },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    ({ commentId, text }) => runTool(async (client) => toJson(await client.editComment(commentId, text))),
  );

  server.registerTool(
    'delete_comment',
    {
      title: 'Delete a Docmost comment',
      description:
        'Permanently deletes a comment and removes its highlight from the page, deleting a whole thread only when deleteReplies is set.',
      inputSchema: {
        commentId: commentIdSchema,
        deleteReplies: z
          .boolean()
          .optional()
          .describe(
            "Also delete the comment's replies, which Docmost requires for a thread's top comment; defaults to false.",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    ({ commentId, deleteReplies }) =>
      runTool(async (client) => toJson(await client.deleteComment(commentId, deleteReplies ?? false))),
  );

  server.registerTool(
    'resolve_comment',
    {
      title: 'Resolve a Docmost comment thread',
      description:
        "Resolves or reopens a comment thread by its top comment's id, which Docmost before 0.98 allows only with an Enterprise licence.",
      inputSchema: {
        commentId: commentIdSchema,
        resolved: z.boolean().optional().describe('false reopens the thread; defaults to true.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ commentId, resolved }) =>
      runTool(async (client) => toJson(await client.resolveComment(commentId, resolved ?? true))),
  );

  server.registerTool(
    'upload_attachment',
    {
      title: 'Upload a file to a Docmost page',
      description:
        'Uploads a local image or file of up to 50 MB to a page and returns its URL and a Markdown image or link to place in the page with edit_page or update_page.',
      inputSchema: {
        pageId: pageReferenceSchema,
        filePath: z
          .string()
          .min(1)
          .describe('Path to the file on the machine running this server; ~ means the home directory.'),
        altText: z
          .string()
          .min(1)
          .optional()
          .describe('Alt text for an image, or link text for another file; defaults to the file name.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ pageId, filePath, altText }) =>
      runTool(async (client) => toJson(await client.uploadAttachment({ pageId, filePath, altText }))),
  );

  server.registerTool(
    'export_page',
    {
      title: 'Export a Docmost page to a file',
      description:
        'Saves a page as a Markdown or HTML file, or as a .zip when it includes subpages or attachments, to a path on the machine running this server and returns the path and size.',
      inputSchema: {
        pageId: pageReferenceSchema,
        format: exportFormatSchema,
        includeChildren: z
          .boolean()
          .optional()
          .describe('Include the subpages, which makes a .zip; defaults to false.'),
        includeAttachments: z
          .boolean()
          .optional()
          .describe('Include images and attached files, which makes a .zip; defaults to false.'),
        outputPath: outputPathSchema,
        overwrite: overwriteSchema,
      },
      annotations: exportAnnotations,
    },
    ({ pageId, format, includeChildren, includeAttachments, outputPath, overwrite }) =>
      runTool(async (client) =>
        toJson(await client.exportPage({ pageId, format, includeChildren, includeAttachments, outputPath, overwrite })),
      ),
  );

  server.registerTool(
    'export_space',
    {
      title: 'Export a Docmost space to a file',
      description:
        'Saves every page of a space as a .zip of Markdown or HTML files to a path on the machine running this server, which needs space admin rights, and returns the path and size.',
      inputSchema: {
        spaceId: z.string().min(1).describe('Space id from list_spaces.'),
        format: exportFormatSchema,
        includeAttachments: z.boolean().optional().describe('Include images and attached files; defaults to false.'),
        outputPath: outputPathSchema,
        overwrite: overwriteSchema,
      },
      annotations: exportAnnotations,
    },
    ({ spaceId, format, includeAttachments, outputPath, overwrite }) =>
      runTool(async (client) =>
        toJson(await client.exportSpace({ spaceId, format, includeAttachments, outputPath, overwrite })),
      ),
  );

  server.registerTool(
    'import_pages',
    {
      title: 'Import files into Docmost',
      description:
        "Creates pages from a .md or .html file, a .zip, or a folder of them on the machine running this server through Docmost's importer, which nests pages by folder, links pages and uploads images, at the space root or under parentPageId.",
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe(
            'Path to a .md, .html or .zip file or a folder on the machine running this server; ~ means the home directory.',
          ),
        spaceId: z
          .string()
          .optional()
          .describe('Space id from list_spaces; may be omitted when parentPageId is given.'),
        parentPageId: pageReferenceSchema.optional().describe('Put the imported pages under this page.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ path, spaceId, parentPageId }) =>
      runTool(async (client) => toJson(await client.importPages({ path, spaceId, parentPageId }))),
  );
  return server;
};

const httpConfig = loadHttpConfig(process.argv.slice(2));
if (httpConfig) {
  await startHttpServer(createServer, httpConfig);
} else {
  await createServer().connect(new StdioServerTransport());
}
