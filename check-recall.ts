/**
 * End-to-end check of the hybrid recall ranking against the LIVE verify DB.
 *
 *   MINIMEM_DB_PATH=/tmp/mm-verify/minimem.db bun run check-recall.ts
 *
 * By default it starts its OWN server on a spare port (so the check cannot be
 * confused by a stale instance) and kills it at the end. Point it at a
 * running server instead with:
 *
 *   MM_URL=http://127.0.0.1:3312 bun run check-recall.ts
 *
 * For each query it prints the top-5 with the signals that produced the order
 * (score / fts_norm / cos / recency / match), so it is visible that:
 *
 *   - the rows that actually match the query come first (not the newest rows);
 *   - a row that matched by MEANING carries its cosine into the score;
 *   - an older near-duplicate of a fact is shadowed, not recalled as current;
 *   - no response carries the internal 1024-float vector.
 *
 * It talks to a RUNNING server over HTTP so the whole response path is
 * exercised (REST /memories/recall, REST /memories/search, MCP memory_search,
 * MCP memory_recall).
 */
const DB = process.env.MINIMEM_DB_PATH ?? "/tmp/mm-verify/minimem.db";
const TOKEN = process.env.MINIMEM_TOKEN ?? "";
const LIMIT = Number(process.env.LIMIT ?? 5);
const EXTERNAL = process.env.MM_URL ?? "";
const PORT = Number(process.env.MM_PORT ?? 3312);

// start our own server unless one was named
let child: ReturnType<typeof Bun.spawn> | null = null;
let BASE = EXTERNAL;

if (!EXTERNAL) {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    MINIMEM_DB_PATH: DB,
    AUTH_ENABLED: "0",
    HOST: "127.0.0.1",
    PORT: String(PORT),
  };
  // embeddings on, when the provider is configured
  for (const k of [
    "EMBED_ENABLED",
    "EMBED_MODEL",
    "EMBED_BATCH",
    "EMBED_TIMEOUT_MS",
    "CF_ACCOUNT_ID",
    "CF_AI_TOKEN",
    "CLOUDFLARE_AI_API_TOKEN",
    "SEM_HALF_LIFE_DAYS",
    "SEM_DEDUPE_THRESHOLD",
  ]) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  child = Bun.spawn([process.execPath, "run", "server.ts"], {
    cwd: import.meta.dir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  BASE = `http://127.0.0.1:${PORT}`;
  const deadline = Date.now() + 25000;
  let up = false;
  while (Date.now() < deadline && !up) {
    try {
      up = (await fetch(`${BASE}/health`)).ok;
    } catch {
      await Bun.sleep(150);
    }
  }
  if (!up) {
    const err = await new Response(child.stderr).text();
    console.error("server did not start:\n" + err);
    child.kill();
    process.exit(2);
  }
}

const QUERIES = [
  "ทำไมเว็บโหลดช้า",
  "ล็อกอินเข้าเว็บไม่ได้",
  "อะไรคือ minimem",
  "ปุ่มบันทึกในฟอร์มไม่ทำงาน",
];

type Item = {
  id: number;
  text: string;
  score: number;
  fts_norm: number;
  cos: number | null;
  recency: number;
  age_days: number;
  match?: string;
  supersedes?: number[];
};
type RecallOut = {
  mode: string;
  degraded: string | null;
  candidates: number;
  total: number;
  items: Item[];
  shadowed: { id: number; by: number; cos: number }[];
};

const auth = (): Record<string, string> =>
  TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};

async function get(path: string): Promise<any> {
  const res = await fetch(`${BASE}${path}`, { headers: auth() });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

const pad = (s: string | number, n: number) => String(s).padEnd(n);
const rpad = (s: string | number, n: number) => String(s).padStart(n);
const one = (v: number | null | undefined, d = 3) => (v === null || v === undefined ? "  -  " : v.toFixed(d));
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

async function main() {
  console.log(`# minimem hybrid recall — live check against ${BASE}`);
  console.log(`# db: ${process.env.MINIMEM_DB_PATH ?? "(server default)"}  limit: ${LIMIT}\n`);

  let leaks = 0;
  let anyDegraded = false;

  for (const q of QUERIES) {
    const enc = encodeURIComponent(q);
    const out: RecallOut = await get(`/memories/recall?q=${enc}&limit=${LIMIT}`);
    if (out.degraded) anyDegraded = true;

    console.log(`=== ${q}`);
    console.log(
      `    mode=${out.mode}  degraded=${out.degraded ?? "null"}  candidates=${out.candidates}  returned=${out.total}`,
    );
    console.log(
      `    ${pad("id", 6)}${rpad("score", 9)}${rpad("fts", 8)}${rpad("cos", 8)}${rpad("rec", 8)}${rpad("age_d", 8)}  ${pad("match", 9)}text`,
    );
    for (const it of out.items) {
      console.log(
        `    ${pad(it.id, 6)}${rpad(it.score.toFixed(4), 9)}${rpad(one(it.fts_norm), 8)}${rpad(one(it.cos), 8)}` +
          `${rpad(one(it.recency), 8)}${rpad(it.age_days, 8)}  ${pad(it.match ?? "-", 9)}${clip(it.text.replace(/\s+/g, " "), 64)}`,
      );
    }
    if (out.shadowed.length) {
      console.log(`    shadowed (older near-duplicates, kept in /memories):`);
      for (const s of out.shadowed) console.log(`      #${s.id} superseded by #${s.by} (cos ${s.cos})`);
    }
    console.log();

    // the vector must not appear in ANY response
    const raw = JSON.stringify(out);
    if (raw.includes('"vec"')) {
      console.log(`  !! LEAK: "vec" present in /memories/recall response for ${q}`);
      leaks++;
    }
  }

  // ---- every response path must be free of the internal vector ----
  console.log("=== response-shape audit (the internal vector must not leak)");
  const q = encodeURIComponent(QUERIES[0]);
  const paths: [string, string][] = [
    ["GET /memories/recall", `/memories/recall?q=${q}&limit=3`],
    ["GET /memories/search", `/memories/search?q=${q}&limit=3`],
    ["MCP memory_search", ""],
    ["MCP memory_recall", ""],
  ];
  for (const [name, path] of paths) {
    let body: string;
    if (path) {
      body = JSON.stringify(await get(path));
    } else {
      const tool = name.endsWith("search") ? "memory_search" : "memory_recall";
      const res = await fetch(`${BASE}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...auth() },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: tool, arguments: { query: QUERIES[0], limit: 3 } },
        }),
      });
      body = await res.text();
    }
    const hasVec = body.includes('"vec"');
    if (hasVec) leaks++;
    console.log(`  ${pad(name, 26)} vec leaked: ${hasVec ? "YES <-- BUG" : "no"}   bytes=${body.length}`);
  }

  // ---- the recency-only fallback must still answer ----
  console.log("\n=== keyword-only fallback (no embeddings) still answers");
  const kw = await get(`/memories/recall?q=${q}&limit=3&mode=keyword`);
  console.log(`  mode=${kw.mode} degraded=${kw.degraded ?? "null"} returned=${kw.total}`);
  for (const it of kw.items ?? []) console.log(`    #${it.id} ${clip((it.text ?? "").replace(/\s+/g, " "), 64)}`);

  console.log(`\n=== ${leaks === 0 ? "PASS: no vector leak on any response path" : `FAIL: ${leaks} leak(s)`}`);
  if (anyDegraded) console.log("=== note: at least one query was served in degraded mode");
  if (child) {
    child.kill(); // kill ONLY this child, by its own handle
    child = null;
  }
  process.exit(leaks === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
