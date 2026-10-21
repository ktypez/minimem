// The dedupe suite for the relation-based design.
//
// The behaviour changed deliberately: "these two memories state the same fact"
// is no longer guessed from cosine, it is READ from the `supersedes` relation
// table. A pair with no relation is never collapsed, because a false collapse
// deletes a distinct fact from the recall of every query that would have
// found it, while a redundant memory costs far less.
//
// On the live corpus the old cosine rule collapsed 67 pairs: 28 were the same
// fact and 27 were DIFFERENT facts that merely shared a topic — and the false
// ones were not marginal (the swiss-redesign screenshot cluster sat at
// 0.90-0.96, above most of the genuine revision pairs).

import { describe, expect, test } from "bun:test";
import { rankHybrid, type Cand } from "./embed.ts";
import { closeRelations, dedupeByMeaning } from "./embed.ts";

const NOW = Date.parse("2026-10-20T00:00:00Z");
const daysAgo = (d: number) =>
  new Date(NOW - d * 86400000).toISOString().replace("T", " ").slice(0, 19);

for (const k of [
  "SEM_HALF_LIFE_DAYS",
  "SEM_DEDUPE_THRESHOLD",
  "SEM_NEAR_DUP_COS",
  "NEAR_DUP_COS",
  "SEM_DECAY_HALF_LIFE_DAYS",
  "DECAY_HALF_LIFE_DAYS",
  "SEM_MIN_RELEVANCE",
  "SEM_COS_NOISE_FLOOR",
  "SEM_COS_GOOD_CEIL",
  "SEM_FTS_STRONG",
  "HYBRID_W_FTS",
  "HYBRID_W_VEC",
  "HYBRID_W_REC",
]) {
  delete process.env[k];
}

const { weights } = await import("./embed.ts");
const W = weights();

const cand = (over: Partial<Cand> & { id: number }): Cand => ({
  text: "x",
  created_at: daysAgo(1),
  updated_at: daysAgo(1),
  ...over,
});

const DIM = 64;
const axisPair = (c: number, ortho: number) => {
  const v = new Float32Array(DIM);
  v[0] = c;
  v[ortho] = Math.sqrt(Math.max(0, 1 - c * c));
  return v;
};
const pairAt = (target: number) => {
  const v0 = new Float32Array(DIM);
  v0[0] = 1;
  const v1 = new Float32Array(DIM);
  v1[0] = target;
  v1[1] = Math.sqrt(1 - target * target);
  return [v0, v1] as const;
};

/** a relation saying "current supersedes other" */
const rel = (current: number, other: number) => new Map([[`${current}:${other}`, other]]);

describe("dedupe by relation", () => {
  test("a related pair collapses to the newer row, the older one is shadowed", () => {
    const [va, vb] = pairAt(0.95);
    const older = cand({
      id: 1,
      updated_at: daysAgo(100),
      cos: 0.95,
      text: "9router คือ reverse proxy หลักของ lab",
    });
    const newer = cand({
      id: 2,
      updated_at: daysAgo(1),
      cos: 0.95,
      text: "9router เป็น reverse proxy หลักของ lab",
    });
    const { kept, shadowed } = dedupeByMeaning(
      [newer, older],
      W,
      new Map([[1, va], [2, vb]]),
      rel(2, 1),
      NOW,
    );
    expect(kept.map((k) => k.id)).toEqual([2]);
    expect(kept[0].supersedes).toEqual([1]);
    expect(shadowed.map((s) => s.id)).toEqual([1]);
    expect(shadowed[0].by).toBe(2);
  });

  test("NO relation means NO collapse, even at cosine 0.98", () => {
    // this is the fix. The old rule collapsed on cosine alone and merged
    // distinct facts: the screenshot cluster sat at 0.90-0.96.
    const [va, vb] = pairAt(0.98);
    const a = cand({ id: 970, updated_at: daysAgo(90), cos: 0.6, text: "swiss-redesign screenshot: /tmp/opencode/swiss-dash.png" });
    const b = cand({ id: 973, updated_at: daysAgo(90), cos: 0.6, text: "swiss-redesign screenshot: /tmp/opencode/swiss-mobile-dash.png" });
    const ranked = rankHybrid([a, b], W, NOW);
    const { kept, shadowed } = dedupeByMeaning(ranked, W, new Map([[970, va], [973, vb]]), undefined, NOW);
    expect(kept.length).toBe(2);
    expect(shadowed).toEqual([]);
  });

  test("an EMPTY relation map is the conservative default: nothing collapses", () => {
    const [va, vb] = pairAt(0.8);
    const older = cand({ id: 848, updated_at: daysAgo(90), cos: 0.6 });
    const newer = cand({ id: 849, updated_at: daysAgo(2), cos: 0.58 });
    const ranked = rankHybrid([older, newer], W, NOW);
    const { kept, shadowed } = dedupeByMeaning(ranked, W, new Map([[848, va], [849, vb]]), new Map(), NOW);
    expect(kept.length).toBe(2);
    expect(shadowed).toEqual([]);
  });

  test("the relation works in EITHER direction — direction only picks the winner", () => {
    const [va, vb] = pairAt(0.8);
    const stamp = daysAgo(90);
    const old = cand({ id: 848, updated_at: stamp, created_at: stamp, cos: 0.6 });
    const correction = cand({ id: 849, updated_at: stamp, created_at: stamp, cos: 0.58 });
    const ranked = rankHybrid([old, correction], W, NOW);
    // the relation says 849 supersedes 848
    const { kept, shadowed } = dedupeByMeaning(ranked, W, new Map([[848, va], [849, vb]]), rel(849, 848), NOW);
    expect(kept.map((k) => k.id)).toEqual([849]);
    expect(kept[0].supersedes).toEqual([848]);
    expect(shadowed.map((s) => s.id)).toEqual([848]);
    expect(shadowed[0].by).toBe(849);
  });

  test("IDENTICAL timestamps: the higher id is the newer vintage and wins", () => {
    // this corpus was bulk-imported, so every row shares an import timestamp
    // and the age cannot tell the vintages apart. Insertion order can.
    const [va, vb] = pairAt(0.828);
    const stamp = daysAgo(90);
    const old = cand({ id: 848, updated_at: stamp, created_at: stamp, cos: 0.6 });
    const correction = cand({ id: 849, updated_at: stamp, created_at: stamp, cos: 0.58 });
    const ranked = rankHybrid([old, correction], W, NOW);
    const { kept, shadowed } = dedupeByMeaning(ranked, W, new Map([[848, va], [849, vb]]), rel(849, 848), NOW);
    expect(kept.map((k) => k.id)).toEqual([849]);
    expect(kept[0].supersedes).toEqual([848]);
    expect(shadowed.map((s) => s.id)).toEqual([848]);
    expect(shadowed[0].by).toBe(849);
  });

  test("beyond the margin the genuinely younger row wins even with a lower id", () => {
    const [va, vb] = pairAt(0.85);
    const old = cand({ id: 99, updated_at: daysAgo(100), cos: 0.6 }); // older AND higher id
    const fresh = cand({ id: 10, updated_at: daysAgo(0.5), cos: 0.58 });
    const ranked = rankHybrid([old, fresh], W, NOW);
    const { kept, shadowed } = dedupeByMeaning(ranked, W, new Map([[99, va], [10, vb]]), rel(10, 99), NOW);
    expect(kept.map((k) => k.id)).toEqual([10]); // age wins outside the margin
    expect(shadowed.map((s) => s.id)).toEqual([99]);
  });

  test("a related CLUSTER elects the newest vintage, not the most similar", () => {
    // the "Hermes Provider Setup" / "Hermes Model Setup" / "current topology"
    // trio: #647 is the most SIMILAR to #588 (0.80) but #894 is the current
    // version. Picking by cosine alone would keep the wrong survivor.
    const dim = 3;
    const mk = (x: number, y: number, z: number) => {
      const v = new Float32Array(dim);
      v[0] = x;
      v[1] = y;
      v[2] = z;
      return v;
    };
    const v588 = mk(1, 0, 0);
    const v647 = mk(0.8, 0.6, 0);
    const v894 = mk(0.78, 0.26, 0.5692099788357746);
    expect(cosineOf(v588, v647)).toBeCloseTo(0.8, 5);
    expect(cosineOf(v588, v894)).toBeCloseTo(0.78, 5);
    expect(cosineOf(v647, v894)).toBeCloseTo(0.78, 5);

    const stamp = daysAgo(90);
    const r588 = cand({ id: 588, updated_at: stamp, created_at: stamp, cos: 0.6 });
    const r647 = cand({ id: 647, updated_at: stamp, created_at: stamp, cos: 0.6 });
    const r894 = cand({ id: 894, updated_at: stamp, created_at: stamp, cos: 0.6 });
    const ranked = rankHybrid([r588, r647, r894], W, NOW);
    const relations = new Map([
      ["588:647", 647],
      ["647:894", 894],
      ["588:894", 894],
    ]);
    const { kept, shadowed } = dedupeByMeaning(
      ranked,
      W,
      new Map([
        [588, v588],
        [647, v647],
        [894, v894],
      ]),
      relations,
      NOW,
    );
    // #894 is the highest id => the newest vintage => it survives
    expect(kept.map((k) => k.id)).toEqual([894]);
    expect(shadowed.map((s) => s.id).sort()).toEqual([588, 647]);
  });

  test("rows without a vector pass through untouched", () => {
    const [va, vb] = pairAt(0.9);
    const noVec = cand({ id: 40, updated_at: daysAgo(1), fts: -5 });
    const older = cand({ id: 1, updated_at: daysAgo(100), cos: 0.9 });
    const newer = cand({ id: 2, updated_at: daysAgo(1), cos: 0.9 });
    const ranked = rankHybrid([noVec, older, newer], W, NOW);
    const { kept } = dedupeByMeaning(ranked, W, new Map([[1, va], [2, vb]]), rel(2, 1), NOW);
    expect(kept.map((k) => k.id)).toContain(40);
  });

  test("no vector map means no dedupe and no crash", () => {
    const ranked = rankHybrid([cand({ id: 1, cos: 0.9 }), cand({ id: 2, cos: 0.9 })], W, NOW);
    const { kept, shadowed } = dedupeByMeaning(ranked, W, null, rel(2, 1), NOW);
    expect(kept.length).toBe(2);
    expect(shadowed).toEqual([]);
  });

  // --- revision CHAINS -------------------------------------------------
  //
  // "a supersedes b" and "b supersedes c" are three vintages of one fact.
  // The collapse lookup used to check a single edge, so the root was only
  // dropped when the MIDDLE vintage happened to be in the result set. On the
  // live corpus that made the answer depend on which notes the vector
  // search returned: "NOT pushed" and "MERGED and PUSHED" came back together.

  test("a chain shadows its root even when the middle vintage is absent", () => {
    const [v1, v3] = pairAt(0.8);
    const root = cand({ id: 1, updated_at: daysAgo(100), cos: 0.8 });
    const leaf = cand({ id: 3, updated_at: daysAgo(1), cos: 0.8 });
    const ranked = rankHybrid([leaf, root], W, NOW);
    // the chain: 3 supersedes 2, 2 supersedes 1 — but 2 is not in the results
    const chain = closeRelations(
      new Map([
        ["3:2", 2],
        ["2:1", 1],
      ]),
    );
    const { kept, shadowed } = dedupeByMeaning(
      ranked,
      W,
      new Map([
        [1, v1],
        [3, v3],
      ]),
      chain,
      NOW,
    );
    expect(kept.map((k) => k.id)).toEqual([3]);
    expect(shadowed.map((s) => s.id)).toEqual([1]);
  });

  test("a relation survives a LOW cosine: the verdict is the authority", () => {
    // two vintages of one fact, worded very differently — cosine 0.3
    const va = new Float32Array(DIM);
    va[0] = 1;
    const vb = new Float32Array(DIM);
    vb[0] = 0.3;
    vb[1] = Math.sqrt(1 - 0.09);
    const root = cand({ id: 1, updated_at: daysAgo(100), cos: 0.3 });
    const leaf = cand({ id: 2, updated_at: daysAgo(1), cos: 0.3 });
    const ranked = rankHybrid([leaf, root], W, NOW);
    const { kept, shadowed } = dedupeByMeaning(
      ranked,
      W,
      new Map([
        [1, va],
        [2, vb],
      ]),
      rel(2, 1),
      NOW,
    );
    expect(kept.map((k) => k.id)).toEqual([2]);
    expect(shadowed.map((s) => s.id)).toEqual([1]);
  });

  test("closeRelations adds only reachable pairs, and never a self-pair", () => {
    const closed = closeRelations(
      new Map([
        ["3:2", 2],
        ["2:1", 1],
        ["9:9", 9],
      ]),
    );
    expect(closed.has("3:2")).toBe(true);
    expect(closed.has("2:1")).toBe(true);
    expect(closed.has("3:1")).toBe(true); // the chain
    expect(closed.has("1:3")).toBe(false); // direction is not invented
    expect(closed.has("3:3")).toBe(false); // never a self-pair
    expect(closed.has("1:2")).toBe(false); // 1 does not supersede 2
  });

  test("dedupe output still carries no raw vector", () => {
    const [va, vb] = pairAt(0.9);
    const ranked = rankHybrid(
      [cand({ id: 1, updated_at: daysAgo(100), cos: 0.9 }), cand({ id: 2, updated_at: daysAgo(1), cos: 0.9 })],
      W,
      NOW,
    );
    const { kept } = dedupeByMeaning(ranked, W, new Map([[1, va], [2, vb]]), rel(2, 1), NOW);
    expect(JSON.stringify(kept)).not.toContain('"vec"');
  });
});

// local helper so the test file does not need another import
function cosineOf(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}
