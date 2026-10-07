import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createServer } from '../../src/server.js';
import type { FastifyInstance } from 'fastify';
import { createMcpServer } from '../../src/mcp-server/index.js';
import { isLoopback } from '../../src/mcp-server/transport.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

describe('isLoopback', () => {
  it('returns true for IPv4 loopback', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
  });
  it('returns true for IPv6 loopback', () => {
    expect(isLoopback('::1')).toBe(true);
  });
  it('returns true for IPv4-mapped IPv6 loopback', () => {
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
  });
  it('returns false for LAN addresses', () => {
    expect(isLoopback('10.0.0.5')).toBe(false);
    expect(isLoopback('192.168.1.42')).toBe(false);
  });
  it('returns false for undefined', () => {
    expect(isLoopback(undefined)).toBe(false);
  });
});

describe('MCP server — loopback guard on Fastify routes', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await createServer();
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  it('GET /api/mcp-server/sse from non-loopback → 403', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/mcp-server/sse',
      remoteAddress: '10.0.0.5',
    });
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).error).toBe('loopback only');
  });

  it('POST /api/mcp-server/message from non-loopback → 403', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/mcp-server/message?sessionId=anything',
      remoteAddress: '192.168.1.42',
      payload: { jsonrpc: '2.0', id: 1, method: 'ping' },
    });
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).error).toBe('loopback only');
  });

  it('POST /api/mcp-server/message from loopback without sessionId → 400', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/mcp-server/message',
      remoteAddress: '127.0.0.1',
      payload: { jsonrpc: '2.0', id: 1, method: 'ping' },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toContain('sessionId');
  });

  it('POST /api/mcp-server/message from loopback with unknown sessionId → 404', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/mcp-server/message?sessionId=does-not-exist',
      remoteAddress: '127.0.0.1',
      payload: { jsonrpc: '2.0', id: 1, method: 'ping' },
    });
    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body).error).toContain('unknown sessionId');
  });
});

describe('MCP server — handshake + empty registries', () => {
  let client: Client;

  beforeEach(async () => {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const mcpServer = createMcpServer();
    await mcpServer.connect(serverT);

    client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(clientT);
  });

  afterEach(async () => {
    await client.close();
  });

  it('advertises server info after initialize', () => {
    const info = client.getServerVersion();
    expect(info).toBeDefined();
    expect(info!.name).toBe('gellyfish-gateway');
    expect(info!.version).toBe('0.1.0');
  });

  it('advertises resources + tools capabilities', () => {
    const caps = client.getServerCapabilities();
    expect(caps).toBeDefined();
    expect(caps!.resources).toBeDefined();
    expect(caps!.tools).toBeDefined();
  });

  it('resources/list returns an empty array', async () => {
    const result = await client.listResources();
    expect(result.resources).toEqual([]);
  });

  it('tools/list returns an empty array', async () => {
    const result = await client.listTools();
    expect(result.tools).toEqual([]);
  });
});
