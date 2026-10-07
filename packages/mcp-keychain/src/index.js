#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execSync } from "child_process";
import { z } from "zod";

const server = new McpServer({
  name: "mcp-keychain",
  version: "1.0.0"
});

server.tool(
  "get_password",
  "Fetch a password from macOS Keychain. Returns the password directly - do NOT log or display it.",
  {
    account: z.string().describe("Account name (e.g., email address)"),
    service: z.string().describe("Service name (e.g., microsoftonline.com)")
  },
  async ({ account, service }) => {
    try {
      const password = execSync(
        `security find-generic-password -a "${account}" -s "${service}" -w`,
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
      ).trim();

      return {
        content: [{ type: "text", text: password }]
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Keychain error: ${error.message}` }],
        isError: true
      };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
