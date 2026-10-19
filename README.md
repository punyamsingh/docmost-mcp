# docmost-mcp

An MCP server for **self-hosted [Docmost](https://docmost.com)**. Read, search, create and update wiki pages in Markdown from Claude Code, Claude Desktop, Cursor or any other MCP client.

Docmost's official MCP server and API keys are part of its paid Enterprise edition. This server needs neither. It logs in with a normal Docmost account and calls the same API the Docmost web app uses. Since Docmost v0.70 that API accepts and returns Markdown, and the server converts it to and from its editor format.

## Tools

| Tool | What it does |
|---|---|
| `list_spaces` | Lists the spaces the account can see, with their ids |
| `list_pages` | Lists the root pages of a space, or the children of a page |
| `search_pages` | Full-text search, optionally within one space |
| `get_page` | Returns a page as Markdown, with its id, space, parent and URL |
| `create_page` | Creates a page from Markdown, at a space root or under a parent page |
| `update_page` | Replaces, appends to or prepends to a page body; can rename it or change its icon |

Every tool that takes a page accepts a page id, a slug id, or the page URL copied from the browser.

Content updates go through Docmost's real-time collaboration layer, so if someone has the page open while it is updated, their editor picks up the change instead of overwriting it.

## Requirements

- Node.js 20.12 or newer
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

## Limitations

- Uploading local image files is not supported yet; reference images that are already hosted somewhere by URL.
- No tools for deleting or moving pages, comments, or permissions.
- Accounts with MFA cannot log in, because the server has no way to complete the second factor.

## License

MIT
