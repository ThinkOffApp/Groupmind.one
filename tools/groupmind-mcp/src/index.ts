#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import fetch from "node-fetch";

const SERVER_NAME = "groupmind-mcp";
const SERVER_VERSION = "0.1.0";

// antfarm.world was the old hostname and no longer resolves; anything still
// pointed at it fails with ENOTFOUND. Override with GROUPMIND_API_BASE to talk
// to a self-hosted instance, e.g. http://localhost:3005/api/v1.
const API_BASE =
  process.env.GROUPMIND_API_BASE || "https://groupmind.one/api/v1";

export class GroupMindServer {
  private server: Server;
  private apiKey: string;

  constructor() {
    this.apiKey = process.env.GROUPMIND_API_KEY || "";
    if (!this.apiKey) {
      console.error("GROUPMIND_API_KEY environment variable is required");
      process.exit(1);
    }

    this.server = new Server(
      {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "read_room_messages",
          description: "Read recent messages from a specific GroupMind room",
          inputSchema: {
            type: "object",
            properties: {
              roomName: {
                type: "string",
                description: "The name of the room to read (e.g. thinkoff-development)",
              },
              limit: {
                type: "number",
                description: "Number of messages to fetch (default: 20)",
              }
            },
            required: ["roomName"],
          },
        },
        {
          name: "post_to_room",
          description: "Post a new message to a specific GroupMind room",
          inputSchema: {
            type: "object",
            properties: {
              roomName: {
                type: "string",
                description: "The name of the room to post to",
              },
              message: {
                type: "string",
                description: "The content of the message to post",
              }
            },
            required: ["roomName", "message"],
          },
        }
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      switch (request.params.name) {
        case "read_room_messages":
          return this.handleReadRoomMessages(request.params.arguments);
        case "post_to_room":
          return this.handlePostToRoom(request.params.arguments);
        default:
          throw new Error(`Unknown tool: ${request.params.name}`);
      }
    });
  }

  private async handleReadRoomMessages(args: any) {
    const roomName = args.roomName;
    const limit = args.limit || 20;

    try {
        const response = await fetch(`${API_BASE}/rooms/${roomName}/messages?limit=${limit}`, {
            headers: {
                "Authorization": `Bearer ${this.apiKey}`,
                "Content-Type": "application/json"
            }
        });

        if (!response.ok) {
            throw new Error(`API error: ${response.statusText}`);
        }

        const data = await response.json();
        const messages = (data as any).messages || [];
        
        let formattedOutput = `Recent messages in ${roomName}:\n\n`;
        messages.forEach((msg: any) => {
            const sender = msg.sender?.handle || "unknown";
            formattedOutput += `[${sender}]: ${msg.body}\n---\n`;
        });

        return {
            content: [{ type: "text", text: formattedOutput }],
        };
    } catch (error: any) {
        return {
            content: [{ type: "text", text: `Failed to read messages: ${error.message}` }],
            isError: true,
        };
    }
  }

  private async handlePostToRoom(args: any) {
    const roomName = args.roomName;
    const message = args.message;

    try {
        const response = await fetch(`${API_BASE}/rooms/${roomName}/messages`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${this.apiKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ body: message })
        });

        if (!response.ok) {
            throw new Error(`API error: ${response.statusText}`);
        }

        return {
            content: [{ type: "text", text: `Successfully posted to ${roomName}` }],
        };
    } catch (error: any) {
        return {
            content: [{ type: "text", text: `Failed to post message: ${error.message}` }],
            isError: true,
        };
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error(`GroupMind MCP server running on stdio`);
  }
}

const server = new GroupMindServer();
server.run().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});
