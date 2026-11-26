# Docmost MCP server

[![npm version](https://img.shields.io/npm/v/@punyamsingh/docmost-mcp.svg)](https://www.npmjs.com/package/@punyamsingh/docmost-mcp)
[![npm downloads](https://img.shields.io/npm/dm/@punyamsingh/docmost-mcp.svg)](https://www.npmjs.com/package/@punyamsingh/docmost-mcp)
[![tests](https://github.com/punyamsingh/docmost-mcp/actions/workflows/test.yml/badge.svg)](https://github.com/punyamsingh/docmost-mcp/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/npm/l/@punyamsingh/docmost-mcp.svg)](./LICENSE)
[![punyamsingh/docmost-mcp MCP server](https://glama.ai/mcp/servers/punyamsingh/docmost-mcp/badges/score.svg)](https://glama.ai/mcp/servers/punyamsingh/docmost-mcp)

An MCP server for **self-hosted [Docmost](https://docmost.com)**. Read, search, create and edit wiki pages in Markdown from Claude Code, Claude Desktop, Cursor, VS Code or any other MCP client. Works with the free Community Edition: no Enterprise licence and no API key, just a normal Docmost login.

```bash
claude mcp add docmost --scope user \
  -e DOCMOST_URL=https://docs.example.com \
  -e DOCMOST_EMAIL=you@example.com \
  -e DOCMOST_PASSWORD='your-password' \
  -- npx -y @punyamsingh/docmost-mcp
```

That is all Claude Code needs; config for Claude Desktop, Cursor and VS Code is under [Setup](#setup).

Docmost's official MCP server and API keys are part of its paid Enterprise edition. This server needs neither. It logs in with a normal Docmost account and calls the same API the Docmost web app uses. Since Docmost v0.70 that API accepts and returns Markdown, and the server converts it to and from its editor format.

- **Markdown in and out**: pages come back as Markdown and are written from Markdown.
- **Safe edits**: an optional stale-write check stops a replace from overwriting someone else's newer change, and rewrites that would delete comments, mentions or diagrams are refused.
- **Live collaboration**: text edits are made in the live document, the way Docmost's own editor makes them, so they merge with whatever people with the page open are typing.
- **Any page reference**: a page id, slug id or the URL copied from the browser.

## Tools

| Tool | What it does |
|---|---|
| `list_spaces` | Lists the spaces the account can see, with their ids |
| `list_pages` | Lists the root pages of a space, or the children of a page |
| `search_pages` | Full-text search, optionally within one space |
| `get_page` | Returns a page as Markdown, 500 lines at a time by default, with its id, space, parent, URL and `updatedAt` |
| `create_page` | Creates a page from Markdown, at a space root or under a parent page |
| `update_page` | Replaces, appends to or prepends to a page body; can rename it or change its icon |
| `edit_page` | Replaces an exact piece of text in a page, in place when it is plain text, leaving the rest of the page as it is |
| `list_comments` | Lists a page's open comment threads with their replies, or every thread with `includeResolved` |
| `add_comment` | Posts a page comment, or an inline comment attached to a `quote` copied from `get_page` |
| `reply_to_comment` | Replies in a comment's thread |
| `edit_comment` | Replaces the text of one of the account's own comments |
| `delete_comment` | Permanently deletes a comment and removes its highlight; a whole thread needs `deleteReplies` |
| `resolve_comment` | Resolves or reopens a thread, on Docmost instances licensed for it |
| `upload_attachment` | Uploads a local image or file (up to 50 MB) to a page and returns a Markdown image or link to place with `edit_page` or `update_page` |

Every tool that takes a page accepts a page id, a slug id, or the page URL copied from the browser.

Pass the `updatedAt` from `get_page` as `expectedUpdatedAt` to `update_page`, and a replace is refused if someone changed the page in the meantime. `edit_page` reads the current body itself, so it applies on top of other people's changes as long as the text still matches exactly once.

When `oldText` and `newText` are plain text and each match sits inside one paragraph, heading or code block, `edit_page` changes just that text in the page's live document, over Docmost's collaboration websocket, the same connection Docmost's editor uses. The change merges with what anyone with the page open is typing, and comments, mentions, colours and everything else on the page are kept. The new text takes the formatting of the text it replaces, as typing over a selection does in the editor. Docmost saves the change within 45 seconds, so the result's `updatedAt` is `null`; `editedInPlace` and `liveMerge` say which way the edit went. If the websocket can't be reached within 10 seconds, the edit is written to the saved page instead and `liveMergeSkipped` says why.

Otherwise, for example when the new text has Markdown formatting or the match crosses a line break or a mention, the edit rewrites the whole body from Markdown, as an `update_page` replace does. Content that Markdown cannot carry would be deleted, so the server refuses such a rewrite on any page that holds it: mentions, comments, highlights, coloured or underlined text, drawio and excalidraw diagrams, embeds, attachments, merged table cells, and any block type it does not recognise. Append and prepend only add blocks, so they still work on those pages.

A whole-body rewrite can't be merged, so it is refused while someone with the page open has typing that Docmost hasn't saved yet; retry a minute later. Append and prepend are merged by Docmost, so they always go through.

### Comments

Comment text is plain text: blank lines start new paragraphs, and `@[Full Name]` mentions the one member with that name, which notifies them. A name that matches no member, or several, refuses the call before anything is posted.

An inline comment's `quote` must appear exactly once inside one paragraph or heading, without crossing a mention or sitting in a code block or on text that already has a comment. The server finds it in the page's live document and sends its position with the comment, and Docmost adds the highlight, as it does in its own editor. The server then waits up to 5 seconds for the highlight; if it doesn't appear, the comment still exists and the result says `anchored: false`.

Docmost threads are one level deep, so a reply to a reply is posted in the same thread, and only a thread's top comment can be resolved. Resolving is a Docmost Enterprise feature in some releases; without the licence the call is refused and nothing changes. Docmost 0.95 leaves an inline thread's highlight looking open after a resolve, so the server updates it through the live document; `highlightUpdated` says whether it could. Deletes are permanent and take a comment's replies with them, so deleting a thread's top comment needs `deleteReplies: true`. Docmost's API leaves a deleted comment's highlight on the page, so the server removes it through the live document; if it can't, for an account that can only comment, the result says `highlightRemoved: false`.

## Requirements

- Node.js 22.18 or newer
- Docmost v0.70 or newer
- A Docmost account without MFA. Edits are attributed to this account in page history, so each person should use their own.

## Setup

There is nothing to clone. Register the server with your MCP client and pass your Docmost login as environment variables. `npx` downloads and runs it.

### Claude Code: all projects

```bash
claude mcp add docmost --scope user \
  -e DOCMOST_URL=https://docs.example.com \
  -e DOCMOST_EMAIL=you@example.com \
  -e DOCMOST_PASSWORD='your-password' \
  -- npx -y @punyamsingh/docmost-mcp
```

### Claude Desktop, Cursor and other clients

Add the following to the client's MCP config (`claude_desktop_config.json`, `~/.cursor/mcp.json`, …):

```json
{
  "mcpServers": {
    "docmost": {
      "command": "npx",
      "args": ["-y", "@punyamsingh/docmost-mcp"],
      "env": {
        "DOCMOST_URL": "https://docs.example.com",
        "DOCMOST_EMAIL": "you@example.com",
        "DOCMOST_PASSWORD": "your-password"
      }
    }
  }
}
```

### VS Code

Add the following to `.vscode/mcp.json` in a workspace, or to your user MCP config:

```json
{
  "servers": {
    "docmost": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@punyamsingh/docmost-mcp"],
      "env": {
        "DOCMOST_URL": "https://docs.example.com",
        "DOCMOST_EMAIL": "you@example.com",
        "DOCMOST_PASSWORD": "your-password"
      }
    }
  }
}
```

To run the latest code on GitHub instead of the npm release, replace `@punyamsingh/docmost-mcp` with `github:punyamsingh/docmost-mcp`. The first start is slower because it builds from source.

The client stores these values in its own config file in plain text, the same as a `.env` file would, so use a config file only you can read.

After the first login the session token is cached in `~/.cache/docmost-mcp/` (or `$XDG_CACHE_HOME/docmost-mcp/`), with file mode `600`. Restarting the client therefore does not open a new Docmost session each time. A new login happens automatically when the token expires or is revoked.

### From a clone

```bash
git clone https://github.com/punyamsingh/docmost-mcp.git
cd docmost-mcp
npm install          # also builds into build/
cp .env.example .env # then fill in DOCMOST_URL, DOCMOST_EMAIL, DOCMOST_PASSWORD
claude mcp add docmost --scope user -- node "$PWD/build/index.js"
```

`.env` is git-ignored. Variables set in the client's config take precedence over it.

The server reaches Docmost's collaboration websocket at `DOCMOST_URL` + `/collab`. If your Docmost serves it elsewhere (its `COLLAB_URL` setting), set `DOCMOST_COLLAB_URL` to that address.

`npm test` builds the server and runs the test suite against a fake Docmost, so it needs no Docmost instance.

## Limitations

- No tools for deleting or moving pages, or for permissions.
- Mentions are looked up through Docmost's people search, 100 people at a time; when 100 or more people match a name, uniqueness can't be confirmed and the mention is refused.
- `delete_comment` checks a thread for replies just before deleting it. A reply posted in the moment between that check and the delete is deleted with the thread, because Docmost's delete can't be made conditional.
- Accounts with MFA cannot log in, because the server has no way to complete the second factor.
- When the collaboration websocket can't be reached, `edit_page` falls back to writing the saved page. Docmost saves what people type 10 to 45 seconds after they type it, so in that case text typed in that window by someone with the page open can be lost.
- Before a whole-body rewrite the server compares the live text with the saved text, not formatting, so bold or colour added in the last 45 seconds without typing can still be lost by a rewrite.

## License

MIT
