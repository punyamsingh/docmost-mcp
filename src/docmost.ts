import { randomInt, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  LiveRefusedError,
  LiveUnavailableError,
  LiveUnconfirmedError,
  openLiveDocument,
  type LiveDocument,
} from './collab.js';
import type { DocmostConfig } from './config.js';

export const MAX_LIST_ITEMS = 1000;
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
  spaceId: z.string().nullish(),
  parentPageId: z.string().nullish(),
  hasChildren: z.boolean().nullish(),
  position: z.string().nullish(),
  updatedAt: z.string().nullish(),
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
  deletedAt: z.string().nullish(),
  space: z
    .object({
      name: z.string().nullish(),
      slug: z.string().nullish(),
    })
    .nullish(),
});

export type EditorNode = {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; [field: string]: unknown }[];
  content?: EditorNode[];
  [field: string]: unknown;
};

const editorNodeSchema: z.ZodType<EditorNode> = z.lazy(() =>
  z.looseObject({
    type: z.string(),
    text: z.string().optional(),
    attrs: z.record(z.string(), z.unknown()).optional(),
    marks: z.array(z.looseObject({ type: z.string() })).optional(),
    content: z.array(editorNodeSchema).optional(),
  }),
);

const editorPageSchema = z.object({
  id: z.string(),
  slugId: z.string(),
  title: z.string().nullish(),
  icon: z.string().nullish(),
  spaceId: z.string(),
  parentPageId: z.string().nullish(),
  updatedAt: z.string().nullish(),
  content: editorNodeSchema.nullish(),
});

type EditorPage = z.infer<typeof editorPageSchema>;

const memberSchema = z.object({ id: z.string(), name: z.string().nullish() });

const commentSchema = z.object({
  id: z.string(),
  pageId: z.string(),
  parentCommentId: z.string().nullish(),
  content: z.unknown(),
  selection: z.string().nullish(),
  type: z.string().nullish(),
  creator: memberSchema.nullish(),
  resolvedAt: z.string().nullish(),
  createdAt: z.string(),
});

type DocmostComment = z.infer<typeof commentSchema>;

const suggestSchema = z.looseObject({ users: z.array(memberSchema).optional() });

const LIVE_SYNC_TIMEOUT_MS = 10_000;
const LIVE_CONFIRM_TIMEOUT_MS = 5_000;

const MARKDOWN_SAFE_NODES = new Set([
  'doc',
  'paragraph',
  'text',
  'hardBreak',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'taskList',
  'taskItem',
  'blockquote',
  'horizontalRule',
  'codeBlock',
  'mathBlock',
  'callout',
  'details',
  'detailsSummary',
  'detailsContent',
  'image',
  'table',
  'tableRow',
  'tableHeader',
  'tableCell',
]);

const MARKDOWN_SAFE_MARKS = new Set(['bold', 'italic', 'strike', 'code', 'link']);

const isMergedCell = (node: EditorNode): boolean =>
  [node.attrs?.colspan, node.attrs?.rowspan].some((span) => typeof span === 'number' && span > 1);

export const findMarkdownLossyContent = (root: EditorNode): string[] => {
  const lossyContent = new Set<string>();
  const visit = (node: EditorNode) => {
    if (!MARKDOWN_SAFE_NODES.has(node.type)) {
      lossyContent.add(node.type);
    }
    if (isMergedCell(node)) {
      lossyContent.add('merged table cell');
    }
    for (const mark of node.marks ?? []) {
      if (!MARKDOWN_SAFE_MARKS.has(mark.type)) {
        lossyContent.add(mark.type);
      }
    }
    node.content?.forEach(visit);
  };
  visit(root);
  return [...lossyContent];
};

const TEXT_BLOCK_TYPES = new Set(['paragraph', 'heading', 'codeBlock', 'detailsSummary']);
const INLINE_NODE_PLACEHOLDER = '￼';
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;

const isWordCharacter = (character: string | undefined): boolean =>
  character !== undefined && /[\p{L}\p{N}]/u.test(character);

const toPlainText = (markdown: string): string | undefined => {
  let plainText = '';
  for (let index = 0; index < markdown.length; index++) {
    const character = markdown.charAt(index);
    const nextCharacter = markdown[index + 1];
    if (character === '\\' && nextCharacter !== undefined && ASCII_PUNCTUATION.test(nextCharacter)) {
      plainText += nextCharacter;
      index++;
      continue;
    }
    const isFormatting =
      '*`[]$<\n'.includes(character) ||
      ((character === '~' || character === '=') && nextCharacter === character) ||
      (character === '_' && (!isWordCharacter(markdown[index - 1]) || !isWordCharacter(nextCharacter)));
    if (isFormatting) {
      return undefined;
    }
    plainText += character;
  }
  return plainText;
};

const inlineText = (node: EditorNode, showMentions: boolean): string => {
  if (node.type === 'text') {
    return node.text ?? '';
  }
  if (showMentions && node.type === 'mention') {
    const label = typeof node.attrs?.label === 'string' ? node.attrs.label : '';
    return node.attrs?.entityType === 'user' ? `@${label}` : label;
  }
  return INLINE_NODE_PLACEHOLDER;
};

const findAll = (text: string, searchText: string): number[] => {
  const starts: number[] = [];
  for (let at = text.indexOf(searchText); at >= 0; at = text.indexOf(searchText, at + searchText.length)) {
    starts.push(at);
  }
  return starts;
};

const mergeTextNodes = (nodes: EditorNode[]): EditorNode[] =>
  nodes.reduce<EditorNode[]>((merged, node) => {
    const previous = merged.at(-1);
    if (
      previous?.type === 'text' &&
      node.type === 'text' &&
      isDeepStrictEqual({ ...previous, text: '' }, { ...node, text: '' })
    ) {
      merged[merged.length - 1] = { ...previous, text: `${previous.text ?? ''}${node.text ?? ''}` };
    } else {
      merged.push(node);
    }
    return merged;
  }, []);

const replaceRange = (children: EditorNode[], start: number, end: number, newText: string): EditorNode[] => {
  const result: EditorNode[] = [];
  let offset = 0;
  let inserted = false;
  for (const child of children) {
    const childStart = offset;
    offset += inlineText(child, false).length;
    if (offset <= start || childStart >= end) {
      result.push(child);
      continue;
    }
    const text = child.text ?? '';
    if (childStart < start) {
      result.push({ ...child, text: text.slice(0, start - childStart) });
    }
    if (!inserted && newText !== '') {
      result.push({ ...child, text: newText });
    }
    inserted = true;
    if (offset > end) {
      result.push({ ...child, text: text.slice(end - childStart) });
    }
  }
  return mergeTextNodes(result);
};

const BLOCK_SYNTAX_START = /^(?:#{1,6}(?:\s|$)|[-+]\s|-{3,}\s*$|>|\d{1,9}[.)]\s|```|~~~|\|)/;

export type InPlaceMatch = { block: EditorNode; starts: number[]; length: number; replacement: string };

type NotInPlace = { ambiguousMatches: number } | { reason: string };

export type InPlacePlan = { matches: InPlaceMatch[]; replacements: number } | NotInPlace;

export type InPlaceEdit = { content: EditorNode; replacements: number } | NotInPlace;

export const visibleText = (document: EditorNode): string => {
  const blocks: string[] = [];
  const visit = (node: EditorNode) => {
    if (TEXT_BLOCK_TYPES.has(node.type)) {
      blocks.push((node.content ?? []).map((child) => inlineText(child, true)).join(''));
      return;
    }
    node.content?.forEach(visit);
  };
  visit(document);
  return blocks.join('\n');
};

export const planInPlaceEdit = (
  document: EditorNode,
  oldText: string,
  newText: string,
  replaceAll: boolean,
): InPlacePlan => {
  const plainOldText = toPlainText(oldText);
  const plainNewText = toPlainText(newText);
  const matches: { block: EditorNode; starts: number[]; length: number; replacement: string | undefined }[] = [];
  let crossesMention = false;
  let crossesInlineNode = false;

  const visit = (node: EditorNode) => {
    if (!TEXT_BLOCK_TYPES.has(node.type)) {
      node.content?.forEach(visit);
      return;
    }
    const isCode = node.type === 'codeBlock';
    const searchText = isCode ? oldText : plainOldText;
    if (!searchText) {
      return;
    }
    const children = node.content ?? [];
    const inlineNodeOffsets: number[] = [];
    let offset = 0;
    for (const child of children) {
      if (child.type !== 'text') {
        inlineNodeOffsets.push(offset);
      }
      offset += inlineText(child, false).length;
    }
    const allStarts = findAll(children.map((child) => inlineText(child, false)).join(''), searchText);
    const starts = allStarts.filter(
      (start) => !inlineNodeOffsets.some((at) => at >= start && at < start + searchText.length),
    );
    if (starts.length < allStarts.length) {
      crossesInlineNode = true;
    }
    if (!isCode && findAll(children.map((child) => inlineText(child, true)).join(''), searchText).length > starts.length) {
      crossesMention = true;
    }
    if (starts.length > 0) {
      const startsBlockWithSyntax = starts.includes(0) && BLOCK_SYNTAX_START.test(newText);
      const replacement = isCode ? newText : startsBlockWithSyntax ? undefined : plainNewText;
      matches.push({ block: node, starts, length: searchText.length, replacement });
    }
  };
  visit(document);

  const replacements = matches.reduce((total, match) => total + match.starts.length, 0);
  if (crossesInlineNode) {
    return { reason: 'oldText crosses an inline element such as a mention' };
  }
  if (crossesMention) {
    return { reason: 'oldText crosses a mention' };
  }
  if (replacements === 0) {
    return {
      reason:
        plainOldText === undefined
          ? 'oldText has Markdown formatting or spans more than one line'
          : 'oldText was not found within a single paragraph, heading or code block',
    };
  }
  if (replacements > 1 && !replaceAll) {
    return { ambiguousMatches: replacements };
  }
  const plannedMatches: InPlaceMatch[] = [];
  for (const { replacement, ...match } of matches) {
    if (replacement === undefined) {
      return { reason: 'newText has Markdown formatting or a line break' };
    }
    plannedMatches.push({ ...match, replacement });
  }
  return { matches: plannedMatches, replacements };
};

export const editInPlace = (document: EditorNode, oldText: string, newText: string, replaceAll: boolean): InPlaceEdit => {
  const editedDocument = structuredClone(document);
  const plan = planInPlaceEdit(editedDocument, oldText, newText, replaceAll);
  if (!('matches' in plan)) {
    return plan;
  }
  for (const match of plan.matches) {
    const children = [...match.starts]
      .reverse()
      .reduce(
        (current, start) => replaceRange(current, start, start + match.length, match.replacement),
        match.block.content ?? [],
      );
    if (children.length > 0) {
      match.block.content = children;
    } else {
      delete match.block.content;
    }
  }
  return { content: editedDocument, replacements: plan.replacements };
};

const MENTION_PATTERN = /@\[([^\]\n]+)\]/g;
const MENTION_SEARCH_LIMIT = 100;

const normalizeName = (name: string): string => name.trim().replace(/\s+/g, ' ').toLowerCase();

const parseCommentContent = (content: unknown): EditorNode | undefined => {
  let value = content;
  if (typeof content === 'string') {
    try {
      value = JSON.parse(content);
    } catch {
      return undefined;
    }
  }
  const parsed = editorNodeSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

const inlineCommentText = (node: EditorNode): string => {
  if (node.type === 'text' || node.type === 'mention') {
    return inlineText(node, true);
  }
  return node.type === 'hardBreak' ? '\n' : (node.content ?? []).map(inlineCommentText).join('');
};

export const commentText = (content: unknown): string =>
  (parseCommentContent(content)?.content ?? []).map(inlineCommentText).join('\n\n');

type Member = { id: string; name: string };

const commentLine = (line: string, members: Map<string, Member>): EditorNode[] => {
  const nodes: EditorNode[] = [];
  let consumed = 0;
  for (const match of line.matchAll(MENTION_PATTERN)) {
    const member = members.get(normalizeName(match[1] ?? ''));
    if (member === undefined) {
      continue;
    }
    if (match.index > consumed) {
      nodes.push({ type: 'text', text: line.slice(consumed, match.index) });
    }
    nodes.push({ type: 'mention', attrs: { id: randomUUID(), label: member.name, entityType: 'user', entityId: member.id } });
    consumed = match.index + match[0].length;
  }
  if (consumed < line.length) {
    nodes.push({ type: 'text', text: line.slice(consumed) });
  }
  return nodes;
};

export const commentContent = (text: string, members: Map<string, Member>): EditorNode => ({
  type: 'doc',
  content: text
    .replaceAll('\r\n', '\n')
    .split(/\n{2,}/)
    .filter((block) => block.trim() !== '')
    .map((block) => ({
      type: 'paragraph',
      content: block
        .split('\n')
        .flatMap((line, index) => [...(index > 0 ? [{ type: 'hardBreak' }] : []), ...commentLine(line, members)]),
    })),
});

const hasMarkInRange = (block: EditorNode, start: number, end: number, markType: string): boolean => {
  let offset = 0;
  return (block.content ?? []).some((child) => {
    const childStart = offset;
    offset += inlineText(child, false).length;
    return offset > start && childStart < end && (child.marks ?? []).some((mark) => mark.type === markType);
  });
};

const commentIdSchema = z.looseObject({ commentId: z.string() });

const hasCommentMark = (node: EditorNode, commentId: string): boolean =>
  (node.marks ?? []).some((mark) => mark.type === 'comment' && commentIdSchema.safeParse(mark.attrs).data?.commentId === commentId) ||
  (node.content ?? []).some((child) => hasCommentMark(child, commentId));

const hasStaleMark = (node: EditorNode, isStale: (attrs: Record<string, unknown>) => boolean): boolean =>
  (node.marks ?? []).some((mark) => mark.type === 'comment' && isStale(z.record(z.string(), z.unknown()).catch({}).parse(mark.attrs))) ||
  (node.content ?? []).some((child) => hasStaleMark(child, isStale));

const countOverlapping = (text: string, searchText: string): number => {
  let count = 0;
  for (let at = text.indexOf(searchText); at >= 0; at = text.indexOf(searchText, at + 1)) {
    count += 1;
  }
  return count;
};

export type QuoteMatch = { block: EditorNode; start: number; end: number; text: string };

export const findQuote = (document: EditorNode, quote: string): QuoteMatch => {
  const plan = planInPlaceEdit(document, quote.replaceAll('\r\n', '\n'), '', false);
  if ('ambiguousMatches' in plan) {
    throw new DocmostError(`Refused: the quote appears ${plan.ambiguousMatches} times; include more surrounding text. Nothing was posted.`);
  }
  if ('reason' in plan) {
    throw new DocmostError(`Refused: ${plan.reason.replace('oldText', 'the quote')}. Nothing was posted.`);
  }
  const [match] = plan.matches;
  const start = match?.starts[0];
  if (match === undefined || start === undefined) {
    throw new DocmostError('Refused: the quote was not found. Nothing was posted.');
  }
  if (match.block.type === 'codeBlock') {
    throw new DocmostError('Refused: the quote is inside a code block, which cannot hold comments. Nothing was posted.');
  }
  const end = start + match.length;
  const blockText = (match.block.content ?? []).map((child) => inlineText(child, false)).join('');
  const occurrences = countOverlapping(blockText, blockText.slice(start, end));
  if (occurrences > 1) {
    throw new DocmostError(`Refused: the quote appears ${occurrences} times; include more surrounding text. Nothing was posted.`);
  }
  if (hasMarkInRange(match.block, start, end, 'comment')) {
    throw new DocmostError(
      'Refused: the quoted text already has a comment, and Docmost keeps one comment per stretch of text; reply to that comment instead. Nothing was posted.',
    );
  }
  return { block: match.block, start, end, text: blockText.slice(start, end) };
};

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
  expectedUpdatedAt?: string;
};

export type EditPageResult = {
  page: DocmostPage;
  replacements: number;
  editedInPlace: boolean;
  liveMerge: boolean;
  liveMergeSkipped?: string;
};

export type EditPageInput = {
  pageId: string;
  oldText: string;
  newText: string;
  replaceAll: boolean;
};

export type MovePageInput = {
  pageId: string;
  parentPageId?: string;
  spaceId?: string;
};

export type AddCommentInput = {
  pageId: string;
  text: string;
  quote?: string;
};

export type AddCommentResult = {
  comment: DocmostComment;
  anchored?: boolean;
  anchorMissing?: string;
};

export class DocmostError extends Error {
  status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

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

const BASE_62_DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const POSITION_JITTER_LENGTH = 3;

const integerPartLength = (position: string): number => {
  const head = position.charCodeAt(0);
  if (head >= 97 && head <= 122) {
    return head - 97 + 2;
  }
  if (head >= 65 && head <= 90) {
    return 90 - head + 2;
  }
  throw new DocmostError(`Unexpected page position "${position}" from Docmost.`);
};

const incrementInteger = (integer: string): string | undefined => {
  const head = integer.charAt(0);
  const digits = integer.slice(1).split('');
  for (let index = digits.length - 1; index >= 0; index--) {
    const next = BASE_62_DIGITS.indexOf(digits[index] ?? '0') + 1;
    if (next < BASE_62_DIGITS.length) {
      digits[index] = BASE_62_DIGITS.charAt(next);
      return head + digits.join('');
    }
    digits[index] = '0';
  }
  if (head === 'Z') {
    return 'a0';
  }
  if (head === 'z') {
    return undefined;
  }
  const nextHead = String.fromCharCode(head.charCodeAt(0) + 1);
  if (nextHead > 'a') {
    digits.push('0');
  } else {
    digits.pop();
  }
  return nextHead + digits.join('');
};

// Docmost orders siblings by jittered fractional-index keys of 5 to 12 characters.
export const positionAfter = (lastPosition: string | undefined): string => {
  const integer =
    lastPosition === undefined
      ? 'a0'
      : (incrementInteger(lastPosition.slice(0, integerPartLength(lastPosition))) ?? lastPosition);
  const jitter = Array.from({ length: POSITION_JITTER_LENGTH }, () =>
    BASE_62_DIGITS.charAt(1 + randomInt(BASE_62_DIGITS.length - 1)),
  ).join('');
  return integer + jitter;
};

export const createDocmostClient = (config: DocmostConfig) => {
  let tokenPromise: Promise<string> | undefined;

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

    await mkdir(dirname(config.sessionFile), { recursive: true, mode: 0o700 })
      .then(() =>
        writeFile(config.sessionFile, JSON.stringify({ baseUrl: config.baseUrl, email: config.email, token }), {
          mode: 0o600,
        }),
      )
      .catch(() => undefined);
    return token;
  };

  const setTokenPromise = (nextToken: Promise<string>): Promise<string> => {
    tokenPromise = nextToken;
    nextToken.catch(() => {
      if (tokenPromise === nextToken) {
        tokenPromise = undefined;
      }
    });
    return nextToken;
  };

  const getToken = (): Promise<string> =>
    tokenPromise ?? setTokenPromise(readCachedToken().then((cachedToken) => cachedToken ?? login()));

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

    const usedToken = getToken();
    let response = await send(await usedToken);
    if (response.status === 401) {
      const freshToken = tokenPromise === usedToken ? setTokenPromise(login()) : getToken();
      response = await send(await freshToken);
    }
    if (!response.ok) {
      throw new DocmostError(`Docmost ${endpoint} failed (${response.status}): ${await readErrorMessage(response)}`, response.status);
    }

    const envelope = z.object({ data: z.unknown() }).safeParse(await response.json().catch(() => undefined));
    const parsedData = responseSchema.safeParse(envelope.success ? envelope.data.data : undefined);
    if (!parsedData.success) {
      throw new DocmostError(`Unexpected response from Docmost ${endpoint}: ${z.prettifyError(parsedData.error)}`);
    }
    return parsedData.data;
  };

  const collectPages = async <ItemSchema extends z.ZodType>(
    endpoint: string,
    body: object,
    itemSchema: ItemSchema,
  ): Promise<{ items: z.infer<ItemSchema>[]; complete: boolean }> => {
    const collectedItems: z.infer<ItemSchema>[] = [];
    let cursor: string | undefined;
    let dropped = false;
    do {
      const result = await post(endpoint, { ...body, limit: PAGE_SIZE, cursor }, paginatedSchema(itemSchema));
      const room = MAX_LIST_ITEMS - collectedItems.length;
      collectedItems.push(...result.items.slice(0, room));
      dropped = result.items.length > room;
      cursor = result.meta.hasNextPage ? (result.meta.nextCursor ?? undefined) : undefined;
    } while (cursor && collectedItems.length < MAX_LIST_ITEMS);
    return { items: collectedItems, complete: cursor === undefined && !dropped };
  };

  const collectAllPages = async <ItemSchema extends z.ZodType>(
    endpoint: string,
    body: object,
    itemSchema: ItemSchema,
  ): Promise<z.infer<ItemSchema>[]> => (await collectPages(endpoint, body, itemSchema)).items;

  const pageUrl = (slugId: string): string => `${config.baseUrl}/p/${slugId}`;

  const listSpaces = (): Promise<{ items: DocmostSpace[]; complete: boolean }> =>
    collectPages('/spaces', {}, spaceSchema);

  const searchPages = async (query: string, spaceId?: string, limit = 20, offset = 0): Promise<DocmostSearchResult[]> => {
    const result = await post('/search', { query, spaceId, limit, offset }, z.object({ items: z.array(searchResultSchema) }));
    return result.items;
  };

  const getPage = async (pageId: string): Promise<DocmostPage> =>
    toPage(await post('/pages/info', { pageId: normalizePageReference(pageId), format: 'markdown' }, pageSchema));

  const resolvePageId = async (pageReference: string): Promise<string> => {
    const normalizedReference = normalizePageReference(pageReference);
    return UUID_PATTERN.test(normalizedReference) ? normalizedReference : (await getPage(normalizedReference)).id;
  };

  const listChildPages = async (
    target: { spaceId: string } | { parentPageId: string },
  ): Promise<{ items: DocmostTreePage[]; complete: boolean }> =>
    collectPages(
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

  const openLive = async (pageId: string, readOnly = false): Promise<{ live: LiveDocument } | { skipped: string }> => {
    let token: string;
    try {
      token = (await post('/auth/collab-token', {}, z.object({ token: z.string() }))).token;
    } catch (error) {
      return { skipped: `no live-editing token: ${error instanceof Error ? error.message : String(error)}` };
    }
    try {
      return {
        live: await openLiveDocument({ url: config.collabUrl, pageId, token, timeoutMs: LIVE_SYNC_TIMEOUT_MS, readOnly }),
      };
    } catch (error) {
      if (error instanceof LiveUnavailableError) {
        return { skipped: error.message };
      }
      if (error instanceof LiveRefusedError) {
        throw new DocmostError(error.message);
      }
      throw error;
    }
  };

  const refuseUnsavedTyping = (live: LiveDocument | undefined, page: EditorPage) => {
    if (live !== undefined && visibleText(live.document) !== visibleText(page.content ?? { type: 'doc' })) {
      throw new DocmostError(
        `Refused: ${page.title ?? page.id} has unsaved edits from an open editor, which rewriting the body would delete. Docmost saves them within 45 seconds, so retry in a minute, or make a plain-text edit_page, which merges with them.`,
      );
    }
  };

  const refuseLossyRewrite = (page: z.infer<typeof editorPageSchema>, inPlaceReason?: string) => {
    const lossyContent = page.content ? findMarkdownLossyContent(page.content) : [];
    if (lossyContent.length > 0) {
      const inPlaceNote = inPlaceReason === undefined ? '' : ` It couldn't be edited in place because ${inPlaceReason}.`;
      throw new DocmostError(
        `Refused: ${page.title ?? page.id} holds content Markdown cannot carry (${lossyContent.join(', ')}), which rewriting the body would delete.${inPlaceNote} Use append or prepend, or edit it in Docmost.`,
      );
    }
  };

  const updatePage = async (input: UpdatePageInput): Promise<DocmostPage> => {
    if (input.markdown !== undefined && input.operation === 'replace') {
      const expectedTime = input.expectedUpdatedAt === undefined ? undefined : Date.parse(input.expectedUpdatedAt);
      if (Number.isNaN(expectedTime)) {
        throw new DocmostError(`expectedUpdatedAt "${input.expectedUpdatedAt}" is not a timestamp; pass updatedAt from get_page.`);
      }
      const currentPage = await post('/pages/info', { pageId: normalizePageReference(input.pageId) }, editorPageSchema);
      if (expectedTime !== undefined && Date.parse(currentPage.updatedAt ?? '') !== expectedTime) {
        throw new DocmostError(
          `Page changed at ${currentPage.updatedAt ?? 'an unknown time'} (you read ${input.expectedUpdatedAt}); re-read it with get_page before replacing.`,
        );
      }
      refuseLossyRewrite(currentPage);
      const attempt = await openLive(currentPage.id);
      if ('live' in attempt) {
        try {
          refuseUnsavedTyping(attempt.live, currentPage);
        } finally {
          attempt.live.close();
        }
      }
    }
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

  const editPage = async (input: EditPageInput): Promise<EditPageResult> => {
    const oldText = input.oldText.replaceAll('\r\n', '\n');
    const newText = input.newText.replaceAll('\r\n', '\n');
    const editorPage = await post('/pages/info', { pageId: normalizePageReference(input.pageId) }, editorPageSchema);
    const attempt = await openLive(editorPage.id);
    const live = 'live' in attempt ? attempt.live : undefined;
    const liveMergeSkipped = 'skipped' in attempt ? { liveMergeSkipped: attempt.skipped } : {};
    try {
      return live === undefined
        ? { ...(await editSavedPage(editorPage, oldText, newText, input.replaceAll)), liveMerge: false, ...liveMergeSkipped }
        : await editLivePage(live, editorPage, oldText, newText, input.replaceAll);
    } finally {
      live?.close();
    }
  };

  const tooManyMatches = (count: number) =>
    new DocmostError(`oldText appears ${count} times; include more surrounding text or set replaceAll.`);

  const editLivePage = async (
    live: LiveDocument,
    editorPage: EditorPage,
    oldText: string,
    newText: string,
    replaceAll: boolean,
  ): Promise<EditPageResult> => {
    const plan = planInPlaceEdit(live.document, oldText, newText, replaceAll);
    if ('ambiguousMatches' in plan) {
      throw tooManyMatches(plan.ambiguousMatches);
    }
    if ('reason' in plan) {
      return { ...(await rewriteFromMarkdown(editorPage, oldText, newText, replaceAll, plan.reason, live)), liveMerge: false };
    }
    try {
      live.transact(() => {
        for (const match of plan.matches) {
          for (const start of [...match.starts].reverse()) {
            live.replace(match.block, start, start + match.length, match.replacement);
          }
        }
      });
      await live.confirm(LIVE_CONFIRM_TIMEOUT_MS);
    } catch (error) {
      throw error instanceof LiveUnconfirmedError ? new DocmostError(error.message) : error;
    }
    const { content: _content, ...pageFields } = editorPage;
    return {
      page: { ...pageFields, updatedAt: null, markdown: '' },
      replacements: plan.replacements,
      editedInPlace: true,
      liveMerge: true,
    };
  };

  const editSavedPage = async (editorPage: EditorPage, oldText: string, newText: string, replaceAll: boolean) => {
    const inPlace = editorPage.content
      ? editInPlace(editorPage.content, oldText, newText, replaceAll)
      : { reason: 'the page is empty' };
    if ('ambiguousMatches' in inPlace) {
      throw tooManyMatches(inPlace.ambiguousMatches);
    }
    if ('content' in inPlace) {
      const page = toPage(
        await post(
          '/pages/update',
          { pageId: editorPage.id, content: inPlace.content, operation: 'replace', format: 'json' },
          pageSchema,
        ),
      );
      return { page, replacements: inPlace.replacements, editedInPlace: true };
    }
    return rewriteFromMarkdown(editorPage, oldText, newText, replaceAll, inPlace.reason, undefined);
  };

  const rewriteFromMarkdown = async (
    editorPage: EditorPage,
    oldText: string,
    newText: string,
    replaceAll: boolean,
    inPlaceReason: string,
    live: LiveDocument | undefined,
  ) => {
    const currentPage = await getPage(editorPage.id);
    const bodyParts = currentPage.markdown.split(oldText);
    const replacements = bodyParts.length - 1;
    if (replacements === 0) {
      throw new DocmostError(
        `oldText not found in ${currentPage.title ?? currentPage.id}; re-read the page with get_page and copy the text exactly.`,
      );
    }
    if (replacements > 1 && !replaceAll) {
      throw tooManyMatches(replacements);
    }
    const latestPage = await post('/pages/info', { pageId: editorPage.id }, editorPageSchema);
    refuseLossyRewrite(latestPage, inPlaceReason);
    refuseUnsavedTyping(live, latestPage);
    const page = toPage(
      await post(
        '/pages/update',
        { pageId: editorPage.id, content: bodyParts.join(newText), operation: 'replace', format: 'markdown' },
        pageSchema,
      ),
    );
    return { page, replacements, editedInPlace: false };
  };

  const findMembers = async (text: string): Promise<Map<string, Member>> => {
    const names = [...new Set([...text.matchAll(MENTION_PATTERN)].map((match) => (match[1] ?? '').trim()))];
    const members = new Map<string, Member>();
    for (const name of names) {
      const { users = [] } = await post(
        '/search/suggest',
        { query: name, includeUsers: true, limit: MENTION_SEARCH_LIMIT },
        suggestSchema,
      );
      const exactMatches = users.filter((user) => normalizeName(user.name ?? '') === normalizeName(name));
      if (exactMatches.length === 1 && users.length >= MENTION_SEARCH_LIMIT) {
        throw new DocmostError(
          `Refused: at least ${MENTION_SEARCH_LIMIT} members match "${name}", so the mention can't be confirmed as unique. Nothing was posted.`,
        );
      }
      const [member] = exactMatches;
      if (exactMatches.length !== 1 || member === undefined) {
        const closest = users.flatMap((user) => (user.name ? [user.name] : [])).slice(0, 5);
        throw new DocmostError(
          exactMatches.length === 0
            ? `Refused: no member is named "${name}"${closest.length > 0 ? `; closest: ${closest.join(', ')}` : ''}. Nothing was posted.`
            : `Refused: ${exactMatches.length} members are named "${name}", so the mention is ambiguous. Nothing was posted.`,
        );
      }
      members.set(normalizeName(name), { id: member.id, name: member.name ?? name });
    }
    return members;
  };

  const buildCommentContent = async (text: string): Promise<string> => {
    const content = commentContent(text, await findMembers(text));
    if ((content.content ?? []).length === 0) {
      throw new DocmostError('Refused: the comment text is empty. Nothing was posted.');
    }
    return JSON.stringify(content);
  };

  const commentInfo = (commentId: string) => post('/comments/info', { commentId }, commentSchema);

  const summarizeComment = (comment: DocmostComment) => ({
    id: comment.id,
    author: comment.creator?.name ?? null,
    createdAt: comment.createdAt,
    text: commentText(comment.content),
  });

  const listComments = async (pageReference: string, includeResolved: boolean) => {
    const comments = await collectAllPages('/comments', { pageId: await resolvePageId(pageReference) }, commentSchema);
    const byTime = (first: DocmostComment, second: DocmostComment) => Date.parse(first.createdAt) - Date.parse(second.createdAt);
    return comments
      .filter((comment) => !comment.parentCommentId && (includeResolved || !comment.resolvedAt))
      .sort(byTime)
      .map((thread) => ({
        ...summarizeComment(thread),
        quote: thread.selection ?? null,
        resolved: Boolean(thread.resolvedAt),
        replies: comments
          .filter((comment) => comment.parentCommentId === thread.id)
          .sort(byTime)
          .map(summarizeComment),
      }));
  };

  const addComment = async (input: AddCommentInput): Promise<AddCommentResult> => {
    const pageId = await resolvePageId(input.pageId);
    const content = await buildCommentContent(input.text);
    if (input.quote === undefined) {
      return { comment: await post('/comments/create', { pageId, content, type: 'page' }, commentSchema) };
    }
    const attempt = await openLive(pageId, true);
    if ('skipped' in attempt) {
      throw new DocmostError(`Refused: the quote can't be anchored because ${attempt.skipped}. Nothing was posted.`);
    }
    const { live } = attempt;
    try {
      const quote = findQuote(live.document, input.quote);
      const comment = await post(
        '/comments/create',
        { pageId, content, type: 'inline', selection: quote.text, yjsSelection: live.selection(quote.block, quote.start, quote.end) },
        commentSchema,
      );
      const anchored = await live.waitFor((document) => hasCommentMark(document, comment.id), LIVE_CONFIRM_TIMEOUT_MS);
      return anchored
        ? { comment, anchored }
        : {
            comment,
            anchored,
            anchorMissing: `Docmost saved the comment but did not add its highlight within ${LIVE_CONFIRM_TIMEOUT_MS / 1000} s`,
          };
    } finally {
      live.close();
    }
  };

  const replyToComment = async (commentId: string, text: string) => {
    const target = await commentInfo(commentId);
    const content = await buildCommentContent(text);
    const threadId = target.parentCommentId ?? target.id;
    const reply = await post('/comments/create', { pageId: target.pageId, content, parentCommentId: threadId }, commentSchema);
    return { reply, threadId, postedToThread: Boolean(target.parentCommentId) };
  };

  const editComment = async (commentId: string, text: string) => {
    const target = await commentInfo(commentId);
    const content = await buildCommentContent(text);
    await post('/comments/update', { commentId: target.id, content }, z.unknown());
    return { id: target.id, threadId: target.parentCommentId ?? target.id };
  };

  const removeCommentHighlight = async (comment: DocmostComment): Promise<{ highlightRemoved: boolean; highlightLeft?: string }> => {
    let attempt: Awaited<ReturnType<typeof openLive>>;
    try {
      attempt = await openLive(comment.pageId);
    } catch (error) {
      return { highlightRemoved: false, highlightLeft: error instanceof Error ? error.message : String(error) };
    }
    if ('skipped' in attempt) {
      return { highlightRemoved: false, highlightLeft: attempt.skipped };
    }
    const { live } = attempt;
    try {
      live.updateMarks('comment', (attrs) => attrs.commentId === comment.id, () => null);
      await live.confirm(LIVE_CONFIRM_TIMEOUT_MS);
      return { highlightRemoved: true };
    } catch (error) {
      return { highlightRemoved: false, highlightLeft: error instanceof Error ? error.message : String(error) };
    } finally {
      live.close();
    }
  };

  const deleteComment = async (commentId: string, deleteReplies: boolean) => {
    const target = await commentInfo(commentId);
    const pageComments = target.parentCommentId
      ? { items: [], complete: true }
      : await collectPages('/comments', { pageId: target.pageId }, commentSchema);
    const replies = pageComments.items.filter((comment) => comment.parentCommentId === target.id);
    if (!pageComments.complete && !deleteReplies) {
      throw new DocmostError(
        `Refused: the page has more than ${MAX_LIST_ITEMS} comments, so the server can't confirm this comment has no replies; pass deleteReplies: true to delete it with any replies. Nothing was deleted.`,
      );
    }
    if (replies.length > 0 && !deleteReplies) {
      throw new DocmostError(
        `Refused: this comment has ${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}, which Docmost deletes with it permanently; pass deleteReplies: true to delete the whole thread. Nothing was deleted.`,
      );
    }
    await post('/comments/delete', { commentId: target.id }, z.unknown());
    const deleted = [target.id, ...replies.map((reply) => reply.id)];
    return target.type === 'inline' ? { deleted, ...(await removeCommentHighlight(target)) } : { deleted };
  };

  const resolveComment = async (commentId: string, resolved: boolean) => {
    const target = await commentInfo(commentId);
    if (target.parentCommentId) {
      throw new DocmostError(
        `Refused: ${target.id} is a reply, and Docmost resolves whole threads; resolve the thread's top comment ${target.parentCommentId} instead. Nothing changed.`,
      );
    }
    try {
      await post('/comments/resolve', { commentId: target.id, pageId: target.pageId, resolved }, z.unknown());
    } catch (error) {
      if (error instanceof DocmostError && error.status === 403 && /licen[cs]e/i.test(error.message)) {
        throw new DocmostError(
          `Refused: resolving comment threads needs a Docmost Enterprise licence on this instance, so the thread stays ${resolved ? 'open' : 'resolved'}. Nothing changed.`,
        );
      }
      throw error;
    }
    return target.type === 'inline'
      ? { id: target.id, resolved, ...(await syncHighlightResolved(target, resolved)) }
      : { id: target.id, resolved };
  };

  // Docmost 0.95 leaves the highlight's resolved flag to its editor; newer releases set it on the server.
  const syncHighlightResolved = async (
    comment: DocmostComment,
    resolved: boolean,
  ): Promise<{ highlightUpdated?: boolean; highlightLeft?: string }> => {
    let attempt: Awaited<ReturnType<typeof openLive>>;
    try {
      attempt = await openLive(comment.pageId, true);
    } catch (error) {
      return { highlightUpdated: false, highlightLeft: error instanceof Error ? error.message : String(error) };
    }
    if ('skipped' in attempt) {
      return { highlightUpdated: false, highlightLeft: attempt.skipped };
    }
    const { live } = attempt;
    try {
      if (!hasCommentMark(live.document, comment.id)) {
        return {};
      }
      const isStale = (attrs: Record<string, unknown>) => attrs.commentId === comment.id && attrs.resolved !== resolved;
      if (!hasStaleMark(live.document, isStale)) {
        return { highlightUpdated: true };
      }
      if (!live.canEdit) {
        return { highlightUpdated: false, highlightLeft: 'this account can only view the page, so it cannot update the highlight' };
      }
      live.updateMarks('comment', isStale, (attrs) => ({ ...attrs, resolved }));
      await live.confirm(LIVE_CONFIRM_TIMEOUT_MS);
      return { highlightUpdated: true };
    } catch (error) {
      return { highlightUpdated: false, highlightLeft: error instanceof Error ? error.message : String(error) };
    } finally {
      live.close();
    }
  };

  const lastChildPosition = async (target: { spaceId: string } | { parentPageId: string }, movedPageId: string) =>
    (await listChildPages(target)).items
      .flatMap((sibling) => (sibling.id !== movedPageId && sibling.position ? [sibling.position] : []))
      .sort()
      .at(-1);

  const movePage = async (input: MovePageInput): Promise<DocmostPage> => {
    const page = await getPage(input.pageId);
    const parentPage = input.parentPageId === undefined ? undefined : await getPage(input.parentPageId);
    if (parentPage && input.spaceId && input.spaceId !== parentPage.spaceId) {
      throw new DocmostError(`Parent page ${input.parentPageId} is in space ${parentPage.spaceId}, not ${input.spaceId}.`);
    }
    const spaceId = parentPage?.spaceId ?? input.spaceId ?? page.spaceId;
    if (spaceId !== page.spaceId) {
      await post('/pages/move-to-space', { pageId: page.id, spaceId }, z.unknown());
    }
    if (parentPage || spaceId === page.spaceId) {
      const target = parentPage ? { parentPageId: parentPage.id } : { spaceId };
      const position = positionAfter(await lastChildPosition(target, page.id));
      await post('/pages/move', { pageId: page.id, parentPageId: parentPage?.id ?? null, position }, z.unknown());
    }
    return getPage(page.id);
  };

  const deletePage = async (pageReference: string): Promise<{ page: DocmostPage; alreadyInTrash: boolean }> => {
    const page = await getPage(pageReference);
    const alreadyInTrash = Boolean(page.deletedAt);
    if (!alreadyInTrash) {
      await post('/pages/delete', { pageId: page.id }, z.unknown());
    }
    return { page, alreadyInTrash };
  };

  const restorePage = async (pageReference: string): Promise<{ page: DocmostPage; movedToSpaceRoot: boolean }> => {
    const trashedPage = await getPage(pageReference);
    if (!trashedPage.deletedAt) {
      throw new DocmostError(`${trashedPage.title ?? trashedPage.id} is not in the trash.`);
    }
    const page = toPage(await post('/pages/restore', { pageId: trashedPage.id }, pageSchema));
    return { page, movedToSpaceRoot: Boolean(trashedPage.parentPageId) && !page.parentPageId };
  };

  return {
    pageUrl,
    listSpaces,
    listChildPages,
    searchPages,
    getPage,
    createPage,
    updatePage,
    editPage,
    movePage,
    deletePage,
    restorePage,
    listComments,
    addComment,
    replyToComment,
    editComment,
    deleteComment,
    resolveComment,
  };
};

export type DocmostClient = ReturnType<typeof createDocmostClient>;
