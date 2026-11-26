import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isLoopbackHost, type HttpConfig } from './config.js';

const digest = (value: string) => createHash('sha256').update(value).digest();

const isAuthorized = (request: IncomingMessage, token: string | undefined) =>
  token === undefined || timingSafeEqual(digest(request.headers.authorization ?? ''), digest(`Bearer ${token}`));

export const startHttpServer = async (createServer: () => McpServer, config: HttpConfig) => {
  let allowedHosts: string[] = [];

  const httpServer = createHttpServer(async (request, response) => {
    if (new URL(request.url ?? '/', 'http://localhost').pathname !== '/mcp') {
      response.writeHead(404).end();
      return;
    }
    if (!isAuthorized(request, config.token)) {
      response.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end();
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' }).end();
      return;
    }

    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      enableDnsRebindingProtection: allowedHosts.length > 0,
      allowedHosts,
    });
    response.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response);
    } catch (error) {
      console.error(error);
      if (!response.headersSent) {
        response.writeHead(500).end();
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.port, config.host, resolve);
  });
  const address = httpServer.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The HTTP server has no TCP address.');
  }
  if (isLoopbackHost(config.host)) {
    allowedHosts = ['127.0.0.1', 'localhost', '[::1]'].map((name) => `${name}:${address.port}`);
  }
  const urlHost = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  console.error(`Docmost MCP server listening on http://${urlHost}:${address.port}/mcp`);
};
