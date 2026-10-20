/**
 * Live check of the near-duplicate collapse. Starts its own server, runs a
 * query built from the text of a KNOWN revision pair, and shows which of the
 * two vintages survives the recall.
 *
 *   bun run check-dedupe.ts
 *
 * The corpus was bulk-imported, so both halves of a pair share a timestamp:
 * insertion order (the higher id) is what decides the vintage.
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DB = process.env.MINIMEM_DB_PATH ?? "/tmp/mm-verify/minimem.db";
const PORT = Number(process.env.MM_PORT ?? 3314);
const BASE = `http://127.0.0.1:${PORT}`;

// the pairs the user verified in the corpus: [OLD id, NEW id, label]
const PAIRS: [number, number, string][] = [
  [848, 849, "Jev EXISTS on Vercel AI Gateway / Correction: the two Free promos"],
  [907, 916, "truck cold-start optimisations NOT DONE / SUPERSEDES the earlier"],
  [803, 810, "Thai combining marks clipped / Compacted catalog rows"],
  [588, 894, "Hermes Provider Setup / Hermes current model/provider topology (SUPERSEDES)"],
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

const db = new Database(DB, { readonly: true });
const textOf = (id: number) =>
  ((db.query("SELECT text FROM memories WHERE id=?").get(id) as { text: string } | null)?.text ?? "");

let failures = 0;
for (const [oldId, newId, label] of PAIRS) {
  const q = textOf(oldId).slice(0, 40);
  const res = await fetch(`${BASE}/memories/recall?q=${encodeURIComponent(q)}&limit=20`);
  const out = (await res.json()) as {
    items: { id: number; score: number; match: string; supersedes?: number[] }[];
    shadowed: { id: number; by: number; cos: number }[];
  };
  const ids = out.items.map((i) => i.id);
  const oldIn = ids.includes(oldId);
  const newIn = ids.includes(newId);
  const sh = out.shadowed.find((s) => s.id === oldId); // attribution of the shadowing
  const winner = out.items.find((i) => i.id === newId || i.id === oldId);

  console.log(`\n### ${label}`);
  console.log(`  query: ${JSON.stringify(q)}`);
  console.log(`  old #${oldId} in the page: ${oldIn ? "YES  <-- STALE VINTAGE RECALLED" : "no"}`);
  console.log(`  new #${newId} in the page: ${newIn ? "yes" : "no"}`);
  console.log(`  shadowed: ${JSON.stringify(out.shadowed)}`);
  if (winner)
    console.log(
      `  winner: #${winner.id} score=${winner.score.toFixed(4)} match=${winner.match} supersedes=${JSON.stringify(winner.supersedes ?? [])}`,
    );
  // The requirement is: the OLD vintage must not be recalled as current, and
  // the NEW vintage must be. (Which row the shadowing is attributed to can be
  // a third, even-newer record of the same fact.)
  if (!oldIn && newIn) {
    console.log(`  OK: the stale vintage #${oldId} is not recalled; the current #${newId} is`);
  } else {
    console.log(`  FAIL: old in page=${oldIn} (want false), new in page=${newIn} (want true)`);
    failures++;
  }
}
db.close();
child.kill();
rmSync(dir, { recursive: true, force: true });
console.log(`\n=== ${failures === 0 ? "PASS: every revision pair collapsed to the newer vintage" : `FAIL: ${failures} pair(s)`}`);
process.exit(failures === 0 ? 0 : 1);
