/**
 * Live check of the near-duplicate collapse. Starts its own server, runs a
 * query built from the text of a KNOWN revision pair, and shows which of the
 * two vintages survives the recall.
 *
 *   bun run check-dedupe.ts
 *
 * WHAT "SAME FACT" MEANS NOW
 *
 * It used to be a cosine threshold, which was measurably wrong: cosine
 * measures topical similarity, not factual identity, so distinct facts that
 * shared a topic were collapsed too (27 of 67 pairs on the live corpus — and
 * the false ones were the HIGHEST cosine ones). The answer is now a stored
 * relation in the `supersedes` table, produced by `curate.ts` and readable
 * with GET /supersedes.
 *
 * So this script checks the two things that must both hold:
 *   1. a pair KNOWN to be the same fact collapses to the current vintage
 *   2. a pair known to be DIFFERENT facts survives intact
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DB = process.env.MINIMEM_DB_PATH ?? "/tmp/mm-verify/minimem.db";
// The port must be OURS. A fixed port means a leftover server from an
// earlier run can still be bound there, and fetch() will then hit whichever
// one the kernel hands out — the checks then read another server's database
// and fail for reasons that have nothing to do with the code under test.
const freePort = async (): Promise<number> => {
  for (let i = 0; i < 40; i++) {
    const p = 3400 + Math.floor(Math.random() * 2600);
    const s = Bun.listen({ hostname: "127.0.0.1", port: p, socket: { data() {}, open() {}, close() {} } });
    s.stop();
    return p;
  }
  throw new Error("no free port");
};
const PORT = Number(process.env.MM_PORT ?? (await freePort()));
const BASE = `http://127.0.0.1:${PORT}`;

// the pairs the user verified in the corpus: [OLD id, NEW id, label]
const PAIRS: [number, number, string][] = [
  [848, 849, "Jev EXISTS on Vercel AI Gateway / Correction: the two Free promos"],
  [907, 916, "truck cold-start optimisations NOT DONE / SUPERSEDES the earlier"],
  [588, 894, "Hermes Provider Setup / Hermes current model/provider topology (SUPERSEDES)"],
  // #1099 re-states #1096 in full and advances the state, so #1096 is the
  // stale vintage. #1096 is itself the current one for #1093, so this also
  // checks that a chain (1093 <- 1096 <- 1099) shadows the right end.
  [1096, 1099, "Portal status: Signal API branch NOT pushed / MERGED and PUSHED"],
];

// pairs that must NOT be collapsed: two different facts that share a topic
const DIFFERENT: [number, number, string][] = [
  [587, 588, "Hermes Maintenance / Hermes Provider Setup"],
  [714, 720, "Hermes Memory Policy / Vault Rules"],
  [970, 973, "swiss-redesign screenshot: dash / mobile-dash"],
  // #803 and #810 look like a revision pair — same spacing work, same deploy
  // lineage — but #810 also records a separate Maps layout change, so #803
  // still holds information (the 76px virtual estimate, the 473-item
  // verification, deploy a1093a85) that #810 does not. Merging them would
  // lose it, so both stay.
  [803, 810, "catalog spacing fix / compacted rows PLUS a separate Maps layout change"],
];

const dir = mkdtempSync(join(tmpdir(), "minimem-dedupe-"));
const env: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  MINIMEM_DB_PATH: DB,
  AUTH_ENABLED: "0",
  HOST: "127.0.0.1",
  PORT: String(PORT),
};
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
const child = Bun.spawn([process.execPath, "run", "server.ts"], {
  cwd: import.meta.dir,
  env,
  stdout: "pipe",
  stderr: "pipe",
});
// Never leave the server behind: a leftover on this port is exactly what
// made an earlier run read a different database and fail.
const stopChild = () => {
  try {
    child.kill();
  } catch {}
};
process.on("exit", stopChild);
process.on("SIGINT", () => {
  stopChild();
  process.exit(130);
});
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
  console.error("server did not start:\n" + (await new Response(child.stderr).text()));
  child.kill();
  process.exit(2);
}
// The server's own state decides whether the dedupe runs at all: without the
// semantic index there are no vectors, so nothing can be collapsed. Say so
// when a check fails.
const embedState = await (await fetch(`${BASE}/embeddings`)).json().catch(() => null);
const serverLog = () => {
  if (!embedState) return;
  console.log(
    `\n[server] db=${DB} embeddings=${embedState.ready ? "ready" : "NOT READY"} (${embedState.embedded ?? "?"} vectors)`,
  );
};

const db = new Database(DB, { readonly: true });
const textOf = (id: number) =>
  ((db.query("SELECT text FROM memories WHERE id=?").get(id) as { text: string } | null)?.text ?? "");

let failures = 0;

// ---------- 1. same fact -> the current vintage wins ----------
// The elected row is not necessarily the pair's own "new" member: a fact can
// have several records of the same vintage and the newest of all of them
// wins. So the requirement is: the OLD vintage must not be recalled, and the
// row that superseded it must be.
for (const [oldId, newId, label] of PAIRS) {
  const q = textOf(oldId).slice(0, 40);
  const res = await fetch(`${BASE}/memories/recall?q=${encodeURIComponent(q)}&limit=20`);
  const out = (await res.json()) as {
    items: { id: number; score: number; match: string; supersedes?: number[] }[];
    shadowed: { id: number; by: number; cos: number }[];
  };
  const ids = out.items.map((i) => i.id);
  const oldIn = ids.includes(oldId);
  const sh = out.shadowed.find((s) => s.id === oldId); // attribution of the shadowing
  const elected = sh?.by ?? newId; // the row that took over
  const electedIn = ids.includes(elected);
  const winner = out.items.find((i) => i.id === elected || i.id === oldId);

  console.log(`\n### SAME FACT: ${label}`);
  console.log(`  query: ${JSON.stringify(q)}`);
  console.log(`  old #${oldId} in the page: ${oldIn ? "YES  <-- STALE VINTAGE RECALLED" : "no"}`);
  console.log(`  current #${elected} in the page: ${electedIn ? "yes" : "no"}`);
  console.log(`  shadowed: ${JSON.stringify(out.shadowed)}`);
  if (winner)
    console.log(
      `  winner: #${winner.id} score=${winner.score?.toFixed(4)} match=${winner.match} supersedes=${JSON.stringify(winner.supersedes ?? [])}`,
    );
  serverLog();
  if (!oldIn && electedIn) {
    console.log(`  OK: the stale vintage #${oldId} is not recalled; the current #${elected} is`);
  } else {
    console.log(`  FAIL: old in page=${oldIn} (want false), current in page=${electedIn} (want true)`);
    serverLog();
    failures++;
  }
}

// ---------- 2. different facts -> they must not be collapsed INTO EACH OTHER ----------
// Either of them may still be shadowed by a THIRD record of its own fact —
// that is correct behaviour. What must never happen is one swallowing the
// other.
for (const [aId, bId, label] of DIFFERENT) {
  const q = textOf(aId).slice(0, 40);
  const res = await fetch(`${BASE}/memories/recall?q=${encodeURIComponent(q)}&limit=20`);
  const out = (await res.json()) as {
    items: { id: number }[];
    shadowed: { id: number; by: number }[];
  };
  const ids = out.items.map((i) => i.id);
  const aShadowedByB = out.shadowed.some((s) => s.id === aId && s.by === bId);
  const bShadowedByA = out.shadowed.some((s) => s.id === bId && s.by === aId);
  const merged = aShadowedByB || bShadowedByA;
  console.log(`\n### DIFFERENT FACTS: ${label}`);
  console.log(`  query: ${JSON.stringify(q)}`);
  console.log(`  #${aId} in page: ${ids.includes(aId)}   #${bId} in page: ${ids.includes(bId)}`);
  console.log(`  shadowed: ${JSON.stringify(out.shadowed)}`);
  if (!merged) {
    console.log(`  OK: neither swallowed the other; both stay distinct facts`);
  } else {
    console.log(`  FAIL: one distinct fact was collapsed into the other`);
    failures++;
  }
}

db.close();
child.kill();
rmSync(dir, { recursive: true, force: true });
console.log(
  `\n=== ${failures === 0 ? "PASS: revision pairs collapse to the current vintage, distinct facts survive" : `FAIL: ${failures} check(s)`}`,
);
process.exit(failures === 0 ? 0 : 1);
