import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import type { EditorNode } from './docmost.js';

export class LiveUnavailableError extends Error {}
export class LiveRefusedError extends Error {}
export class LiveUnconfirmedError extends Error {}

export type LiveDocument = {
  document: EditorNode;
  replace: (block: EditorNode, start: number, end: number, newText: string) => void;
  transact: (change: () => void) => void;
  confirm: (timeoutMs: number) => Promise<void>;
  close: () => void;
};

const markName = (attributeName: string): string => attributeName.replace(/--.*$/, '');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

type DeltaOperation = { insert: unknown; attributes?: Record<string, unknown> };

const isDeltaOperation = (value: unknown): value is DeltaOperation =>
  isRecord(value) && 'insert' in value && (value.attributes === undefined || isRecord(value.attributes));

const deltaOf = (text: Y.XmlText): DeltaOperation[] => {
  const delta: unknown = text.toDelta();
  return Array.isArray(delta) ? delta.filter(isDeltaOperation) : [];
};

const textNodes = (text: Y.XmlText): EditorNode[] =>
  deltaOf(text).flatMap((operation) => {
    if (typeof operation.insert !== 'string') {
      return [];
    }
    const marks = Object.entries(operation.attributes ?? {}).map(([name, attrs]) =>
      isRecord(attrs) && Object.keys(attrs).length > 0 ? { type: markName(name), attrs } : { type: markName(name) },
    );
    return [{ type: 'text', text: operation.insert, ...(marks.length > 0 ? { marks } : {}) }];
  });

const toEditorNode = (element: Y.XmlElement, blocks: Map<EditorNode, Y.XmlElement>): EditorNode => {
  const attrs = element.getAttributes();
  const content = element
    .toArray()
    .flatMap((child) => (child instanceof Y.XmlText ? textNodes(child) : child instanceof Y.XmlElement ? [toEditorNode(child, blocks)] : []));
  const node: EditorNode = {
    type: element.nodeName,
    ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
    ...(content.length > 0 ? { content } : {}),
  };
  blocks.set(node, element);
  return node;
};

const attributesAt = (text: Y.XmlText, index: number): Record<string, unknown> => {
  let position = 0;
  for (const operation of deltaOf(text)) {
    const length = typeof operation.insert === 'string' ? operation.insert.length : 1;
    if (index < position + length) {
      return { ...(operation.attributes ?? {}) };
    }
    position += length;
  }
  return {};
};

const createLiveDocument = (provider: HocuspocusProvider, ydoc: Y.Doc): LiveDocument => {
  const blocks = new Map<EditorNode, Y.XmlElement>();
  const fragment = ydoc.getXmlFragment('default');
  const content = fragment
    .toArray()
    .flatMap((child) => (child instanceof Y.XmlElement ? [toEditorNode(child, blocks)] : []));

  const replace = (block: EditorNode, start: number, end: number, newText: string) => {
    const element = blocks.get(block);
    if (element === undefined) {
      throw new LiveUnconfirmedError('The live document changed shape while editing; re-read the page.');
    }
    const pieces: { text: Y.XmlText; from: number; to: number }[] = [];
    let offset = 0;
    for (const child of element.toArray()) {
      const length = child instanceof Y.XmlText ? child.length : 1;
      if (child instanceof Y.XmlText && offset < end && offset + length > start) {
        pieces.push({ text: child, from: Math.max(start, offset) - offset, to: Math.min(end, offset + length) - offset });
      }
      offset += length;
    }
    const [first] = pieces;
    if (first === undefined) {
      throw new LiveUnconfirmedError('The matched text is no longer in the live document; re-read the page.');
    }
    const attributes = attributesAt(first.text, first.from);
    for (const piece of [...pieces].reverse()) {
      piece.text.delete(piece.from, piece.to - piece.from);
    }
    if (newText !== '') {
      first.text.insert(first.from, newText, attributes);
    }
  };

  const confirm = (timeoutMs: number) =>
    new Promise<void>((resolve, reject) => {
      if (provider.unsyncedChanges === 0) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        provider.off('unsyncedChanges', onChange);
        reject(new LiveUnconfirmedError(`The edit was sent but Docmost did not confirm it within ${timeoutMs / 1000} s; re-read the page before trying again.`));
      }, timeoutMs);
      const onChange = () => {
        if (provider.unsyncedChanges === 0) {
          clearTimeout(timer);
          provider.off('unsyncedChanges', onChange);
          resolve();
        }
      };
      provider.on('unsyncedChanges', onChange);
    });

  return {
    document: { type: 'doc', content },
    replace,
    transact: (change) => ydoc.transact(change),
    confirm,
    close: () => {
      provider.destroy();
      ydoc.destroy();
    },
  };
};

export const openLiveDocument = (options: { url: string; pageId: string; token: string; timeoutMs: number }) =>
  new Promise<LiveDocument>((resolve, reject) => {
    const ydoc = new Y.Doc();
    let settled = false;
    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      provider.destroy();
      ydoc.destroy();
      reject(error);
    };
    const timer = setTimeout(
      () => fail(new LiveUnavailableError(`the live-editing connection did not sync within ${options.timeoutMs / 1000} s`)),
      options.timeoutMs,
    );
    const provider = new HocuspocusProvider({
      url: options.url,
      name: `page.${options.pageId}`,
      document: ydoc,
      token: options.token,
      awareness: null,
      onAuthenticationFailed: ({ reason }) => fail(new LiveRefusedError(`Docmost refused the live-editing connection: ${reason}`)),
      onAuthenticated: ({ scope }) => {
        if (scope === 'readonly') {
          fail(new LiveRefusedError('This account can only view the page, so it cannot edit it.'));
        }
      },
      onClose: ({ event }) => fail(new LiveUnavailableError(`the live-editing connection closed (code ${event.code})`)),
      onSynced: ({ state }) => {
        if (!state || settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(createLiveDocument(provider, ydoc));
      },
    });
  });
