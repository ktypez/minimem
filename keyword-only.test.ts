/**
 * Regression test for the production configuration: NO embeddings.
 *
 * The production env (/etc/minimem/minimem.env) has no CF_AI_TOKEN, no
 * CF_ACCOUNT_ID and no EMBED_ENABLED, so `embedReady()` is false and recall()
 * takes the keyword-only fallback branch. That branch used to reference
 * `CF_AI_TOKEN` in server.ts WITHOUT importing it, so the route threw
 *
 *     ReferenceError: CF_AI_TOKEN is not defined
 *
 * and the production memory store answered every search with the raw error
 * text instead of results. It only fired with embeddings OFF — every other
 * test had a token in the environment, so the branch never executed.
 *
 * This test starts a REAL server with a scrubbed environment and asserts the
 * route returns a valid JSON body (mode/items), not an error string.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 3499;
const BASE = `http://127.0.0.1:${PORT}`;

let dir: string;
let child: ReturnType<typeof Bun.spawn> | null = null;

/** wait for the server to answer /health */
async function waitReady(timeoutMs = 20000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(120);
  }
  return false;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "minimem-kwonly-"));
  // a scrubbed environment: no token, no account, embeddings explicitly off.
  // this is the production shape.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    MINIMEM_DB_PATH: join(dir, "minimem.db"),
    AUTH_ENABLED: "0",
    HOST: "127.0.0.1",
    PORT: String(PORT),
    EMBED_ENABLED: "0",
  };
  child = Bun.spawn([process.execPath, "run", "server.ts"], {
    cwd: import.meta.dir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const up = await waitReady();
  if (!up) {
    const err = await new Response(child.stderr).text();
    throw new Error(`server did not come up: ${err}`);
  }
});

afterAll(() => {
  // kill ONLY this child, by its exact pid — never a broad pkill
  if (child) {
    child.kill();
    child = null;
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("keyword-only mode (the PRODUCTION configuration)", () => {
  test("/memories/recall returns a valid JSON body, not an error string", async () => {
    // seed one memory so the search has something to find
    const created = await fetch(`${BASE}/memories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "production keyword only regression canary", tags: ["canary"] }),
    });
    expect(created.ok).toBe(true);

    const res = await fetch(`${BASE}/memories/recall?q=canary&limit=5`);
    const text = await res.text();

    // the bug: the route threw and the body WAS the error text
    expect(text).not.toContain("is not defined");
    expect(text).not.toContain("ReferenceError");

    expect(res.status).toBe(200);
    const body = JSON.parse(text); // must parse as JSON
    expect(body.mode).toBe("keyword");
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items[0].text).toContain("canary");
    // the shape is unchanged: mode, degraded, items[], shadowed[], candidates
    expect(body).toHaveProperty("degraded");
    expect(body).toHaveProperty("shadowed");
    expect(body).toHaveProperty("candidates");
    // and no internal vector ever leaks
    expect(text).not.toContain('"vec"');
  });

  test("/memories/search returns a JSON array, not an error string", async () => {
    const res = await fetch(`${BASE}/memories/search?q=canary&limit=5`);
    const text = await res.text();
    expect(text).not.toContain("is not defined");
    expect(text).not.toContain("ReferenceError");
    expect(res.status).toBe(200);
    const body = JSON.parse(text);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    expect(text).not.toContain('"vec"');
  });

  test("MCP memory_search and memory_recall return valid JSON", async () => {
    for (const tool of ["memory_search", "memory_recall"]) {
      const res = await fetch(`${BASE}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: tool, arguments: { query: "canary", limit: 3 } },
        }),
      });
      const text = await res.text();
      expect(text).not.toContain("is not defined");
      expect(text).not.toContain("ReferenceError");
      expect(res.status).toBe(200);
      expect(() => JSON.parse(text)).not.toThrow();
      expect(text).not.toContain('"vec"');
    }
  });
});
