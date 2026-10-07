#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BlueskyClient } from './blueskyClient.js';

const client = new BlueskyClient();

const server = new McpServer({
  name: "bluesky-mcp",
  version: "1.0.0",
});

// --- Helper ---

function formatTimeline(posts: Array<Record<string, unknown>>, baseUrl = "https://bsky.app/profile") {
  return {
    count: posts.length,
    posts: posts
      .filter((post) => (post as { author?: { handle?: string } }).author?.handle)
      .map((post: Record<string, unknown>, i: number) => {
        const author = post.author as { handle: string; displayName?: string };
        return {
          position: i + 1,
          author: { handle: author.handle, displayName: author.displayName },
          content: post.text,
          stats: { replies: post.replyCount, reposts: post.repostCount, likes: post.likeCount },
          createdAt: post.createdAt,
          uri: post.uri,
          cid: post.cid,
          url: `${baseUrl}/${author.handle}/post/${(post.uri as string).split("/").pop()}`,
        };
      }),
  };
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function err(msg: string) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ status: "error", message: msg }) }] };
}

// --- Tools ---

server.tool("login", "Login to Bluesky", {
  identifier: z.string().optional().describe("Bluesky handle or email (optional if set in env)"),
  password: z.string().optional().describe("Bluesky app password (optional if set in env)"),
}, async ({ identifier, password }) => {
  try {
    if (identifier && password) await client.login(identifier, password);
    else await client.autoLogin();
    return ok({ status: "success", message: "Successfully logged in to Bluesky" });
  } catch (error) { return err(`Failed to login: ${error}`); }
});

server.tool("create-post", "Create a new post on Bluesky. Supports threading via replyTo.", {
  text: z.string().describe("The text content of your post"),
  images: z.array(z.object({
    data: z.string().describe("Base64 encoded image data"),
    encoding: z.string().describe("Image MIME type (e.g., image/jpeg)"),
  })).optional().describe("Optional images to attach"),
  replyTo: z.object({
    uri: z.string().describe("URI of the post to reply to"),
    cid: z.string().describe("CID of the post to reply to"),
  }).optional().describe("Post to reply to (for threading)"),
  rootPost: z.object({
    uri: z.string().describe("URI of the thread root post"),
    cid: z.string().describe("CID of the thread root post"),
  }).optional().describe("Root of the thread (defaults to replyTo)"),
}, async ({ text, images, replyTo, rootPost }) => {
  try {
    const processedImages = images?.map(img => ({
      data: Buffer.from(img.data, 'base64'),
      encoding: img.encoding,
    }));
    const result = await client.createPost(text, processedImages, replyTo, rootPost);
    return ok({ status: "success", message: "Post created successfully", uri: result.uri, cid: result.cid });
  } catch (error) { return err(`Failed to create post: ${error}`); }
});

server.tool("create-thread", "Create a thread (multiple posts chained as replies)", {
  texts: z.array(z.string()).min(1).describe("Array of post texts — each becomes a post in the thread"),
  images: z.array(z.object({
    data: z.string().describe("Base64 encoded image data"),
    encoding: z.string().describe("Image MIME type"),
  })).optional().describe("Optional images for the first post only"),
}, async ({ texts, images }) => {
  try {
    const processedImages = images?.map(img => ({
      data: Buffer.from(img.data, 'base64'),
      encoding: img.encoding,
    }));
    const results = await client.createThread(texts, processedImages);
    return ok({
      status: "success",
      message: `Thread created with ${results.length} posts`,
      posts: results,
    });
  } catch (error) { return err(`Failed to create thread: ${error}`); }
});

server.tool("get-author-feed", "Get recent posts from a specific user", {
  actor: z.string().describe("Bluesky handle or DID (e.g., gellyfish-ai.bsky.social)"),
  limit: z.number().int().min(1).max(100).optional().describe("Number of posts (default 20)"),
}, async ({ actor, limit }) => {
  try {
    const feed = await client.getAuthorFeed(actor, limit);
    const formatted = formatTimeline(
      ((feed.data.feed || []) as Array<{ post: Record<string, unknown> }>)
        .map((item) => item.post)
        .filter(Boolean)
    );
    return ok(formatted);
  } catch (error) { return err(`Failed to get author feed: ${error}`); }
});

server.tool("get-profile", "Get your Bluesky profile", {}, async () => {
  try {
    const profile = await client.getProfile();
    return ok(profile);
  } catch (error) { return err(`Failed to get profile: ${error}`); }
});

server.tool("get-timeline", "Get Bluesky timeline", {
  limit: z.number().int().min(1).max(100).optional(),
}, async ({ limit }) => {
  try {
    const timeline = await client.getTimeline(limit);
    const formatted = formatTimeline(
      ((timeline.data.feed || []) as Array<{ post: Record<string, unknown> }>)
        .map((item) => item.post)
        .filter(Boolean)
    );
    return ok(formatted);
  } catch (error) { return err(`Failed to get timeline: ${error}`); }
});

server.tool("get-post", "Get a specific post by URI", {
  uri: z.string().describe("The URI of the post to fetch"),
}, async ({ uri }) => {
  try { return ok(await client.getPost(uri)); }
  catch (error) { return err(`Failed to get post: ${error}`); }
});

server.tool("get-posts", "Get multiple posts by their URIs", {
  uris: z.array(z.string()).describe("Array of post URIs to fetch"),
}, async ({ uris }) => {
  try { return ok(await client.getPosts(uris)); }
  catch (error) { return err(`Failed to get posts: ${error}`); }
});

server.tool("delete-post", "Delete one of your posts", {
  uri: z.string().describe("The URI of the post to delete"),
}, async ({ uri }) => {
  try { await client.deletePost(uri); return ok({ status: "success", message: "Post deleted" }); }
  catch (error) { return err(`Failed to delete post: ${error}`); }
});

server.tool("like-post", "Like a post", {
  uri: z.string().describe("The URI of the post to like"),
  cid: z.string().describe("The CID of the post to like"),
}, async ({ uri, cid }) => {
  try {
    const result = await client.likePost(uri, cid);
    return ok({ status: "success", message: `Liked. Like URI: ${result.uri}` });
  } catch (error) { return err(`Failed to like: ${error}`); }
});

server.tool("unlike-post", "Remove your like from a post", {
  likeUri: z.string().describe("The URI of the like to remove"),
}, async ({ likeUri }) => {
  try { await client.unlikePost(likeUri); return ok({ status: "success", message: "Like removed" }); }
  catch (error) { return err(`Failed to unlike: ${error}`); }
});

server.tool("repost", "Repost someone's post", {
  uri: z.string().describe("The URI of the post to repost"),
  cid: z.string().describe("The CID of the post to repost"),
}, async ({ uri, cid }) => {
  try {
    const result = await client.repostPost(uri, cid);
    return ok({ status: "success", message: `Reposted. Repost URI: ${result.uri}` });
  } catch (error) { return err(`Failed to repost: ${error}`); }
});

server.tool("unrepost", "Remove your repost", {
  repostUri: z.string().describe("The URI of the repost to remove"),
}, async ({ repostUri }) => {
  try { await client.unrepostPost(repostUri); return ok({ status: "success", message: "Repost removed" }); }
  catch (error) { return err(`Failed to unrepost: ${error}`); }
});

// --- Main ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  try {
    await client.autoLogin();
    console.error("Auto-logged in to Bluesky");
  } catch {
    console.error("Auto-login failed. Use the login tool to authenticate.");
  }
  console.error("Bluesky MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
