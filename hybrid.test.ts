import { describe, expect, test } from "bun:test";
import {
  ageDays,
  cosSig,
  cosine,
  decay,
  dedupeByMeaning,
  ftsSig,
  packVec,
  rankHybrid,
  unpackVec,
  weights,
  type Cand,
} from "./embed.ts";

const NOW = Date.parse("2026-10-20T00:00:00Z");
const daysAgo = (d: number) =>
  new Date(NOW - d * 86400000).toISOString().replace("T", " ").slice(0, 19);

// The tests below assert the CODE DEFAULTS, so the semantic env knobs must not
// leak in from the shell (the deployed env file sets SEM_DEDUPE_THRESHOLD=0.94
// and SEM_HALF_LIFE_DAYS=45, which would otherwise change every expectation).
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

const W = weights();

const cand = (over: Partial<Cand> & { id: number }): Cand => ({
  text: "x",
  created_at: daysAgo(1),
  updated_at: daysAgo(1),
  ...over,
});

// Vectors for the dedupe tests are built on canonical axes so the intended
// pairwise cosine is EXACT — no provider call, no database.
const DIM = 64;
const axisPair = (c: number, ortho: number) => {
  const v = new Float32Array(DIM);
  v[0] = c;
  v[ortho] = Math.sqrt(Math.max(0, 1 - c * c));
  return v;
};
// two rows whose texts sit at cosine `target` against each other (both share axis 0)
const pairAt = (target: number) => {
  const a = new Float32Array(DIM);
  const b = new Float32Array(DIM);
  const s = Math.sqrt(Math.max(0, 1 - target * target));
  a[0] = target;
  a[1] = s;
  b[0] = target;
  b[2] = s;
  // cos(a,b) = target^2 + s^2*0 -> normalise properly: use shared component x
  // a = x*e0 + y*e1, b = x*e0 + z*e2 with unit norms => cos(a,b) = x^2
  const x = Math.sqrt(Math.max(0, Math.min(1, target)));
  const y = Math.sqrt(Math.max(0, 1 - x * x));
  a.fill(0);
  b.fill(0);
  a[0] = x;
  a[1] = y;
  b[0] = x;
  b[2] = y;
  return [a, b] as const;
};

describe("vectors", () => {
  test("pack/unpack round-trips the vector", () => {
    const v = [0.5, -0.25, 0.125, 1];
    const back = unpackVec(packVec(v));
    expect(Array.from(back)).toEqual(v);
  });

  test("cosine of identical vectors is 1 and orthogonal is 0", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1, 6);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });

  test("cosine of a zero vector is 0, never NaN", () => {
    expect(cosine([0, 0], [1, 2])).toBe(0);
  });

  test("pairAt builds an exact cosine between two rows", () => {
    const [a, b] = pairAt(0.82);
    expect(cosine(a, b)).toBeCloseTo(0.82, 6);
  });
});

describe("recency decay", () => {
  test("age is computed in days", () => {
    expect(ageDays(daysAgo(10), NOW)).toBeCloseTo(10, 1);
  });

  test("decay halves every half-life", () => {
    expect(decay(0, 45)).toBeCloseTo(1, 6);
    expect(decay(45, 45)).toBeCloseTo(0.5, 6);
    expect(decay(90, 45)).toBeCloseTo(0.25, 6);
  });
});

describe("signal calibration", () => {
  test("cosine maps onto the same 0..1 scale as bm25, with absolute anchors", () => {
    expect(cosSig(0.65)).toBe(1); // measured good-hit level
    expect(cosSig(0.45)).toBe(0); // measured noise ceiling
    expect(cosSig(0.55)).toBeCloseTo(0.5, 6);
    expect(cosSig(0.3)).toBe(0); // noise clipped, never negative
    expect(cosSig(null)).toBe(0);
    expect(cosSig(undefined)).toBe(0);
  });

  test("bm25 saturates at the strong threshold instead of min-max across candidates", () => {
    expect(ftsSig(8, W.ftsStrong)).toBe(1);
    expect(ftsSig(4, W.ftsStrong)).toBeCloseTo(0.5, 6); // weak trigram hit
    expect(ftsSig(0, W.ftsStrong)).toBe(0);
    expect(ftsSig(40, W.ftsStrong)).toBe(1); // never exceeds 1
  });
});

describe("hybrid ranking", () => {
  test("a fresh memory outranks an identical-but-old one", () => {
    const old = cand({ id: 1, updated_at: daysAgo(180), cos: 0.9, fts: -10 });
    const fresh = cand({ id: 2, updated_at: daysAgo(1), cos: 0.9, fts: -10 });
    const ranked = rankHybrid([old, fresh], W, NOW);
    expect(ranked[0].id).toBe(2);
    expect(ranked[0].age_days).toBeLessThan(ranked[1].age_days);
  });

  test("a strong semantic hit beats a weak one", () => {
    const strong = cand({ id: 1, cos: 0.95, updated_at: daysAgo(2) });
    const weak = cand({ id: 2, cos: 0.6, updated_at: daysAgo(2) });
    const ranked = rankHybrid([strong, weak], W, NOW);
    expect(ranked[0].id).toBe(1);
    expect(ranked[0].cos).toBeCloseTo(0.95, 6);
  });

  test("RELEVANCE GATE: a fresh irrelevant row cannot outrank a stale relevant one", () => {
    const freshNoise = cand({ id: 1, updated_at: daysAgo(0), cos: 0.3 }); // new, off-topic
    const staleRelevant = cand({ id: 2, updated_at: daysAgo(120), cos: 0.62 });
    const ranked = rankHybrid([freshNoise, staleRelevant], W, NOW);
    expect(ranked[0].id).toBe(2);
    expect(ranked[0].match).toBe("semantic");
    expect(ranked[1].match).toBe("none");
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  test("RELEVANCE GATE: every relevant row scores above every non-relevant row", () => {
    const cands = [
      cand({ id: 1, updated_at: daysAgo(0), cos: 0.28 }),
      cand({ id: 2, updated_at: daysAgo(400), cos: 0.55 }),
      cand({ id: 3, updated_at: daysAgo(0), fts: -1 }),
      cand({ id: 4, updated_at: daysAgo(0), cos: 0.31 }),
    ];
    const ranked = rankHybrid(cands, W, NOW);
    const cut = ranked.findIndex((r) => r.match === "none");
    expect(ranked.slice(0, cut).every((r) => r.match !== "none")).toBe(true);
    expect(ranked.slice(cut).every((r) => r.match === "none")).toBe(true);
  });

  test("a keyword-only hit counts as relevant even with no vector", () => {
    const kw = cand({ id: 4, updated_at: daysAgo(200), fts: -6 });
    const ranked = rankHybrid([cand({ id: 5, updated_at: daysAgo(0), cos: 0.3 }), kw], W, NOW);
    expect(ranked[0].id).toBe(4);
    expect(ranked[0].match).toBe("keyword");
    expect(ranked[0].fts_norm).toBeGreaterThan(0);
  });

  test("matching both ways beats matching one way, and is labelled", () => {
    const both = cand({ id: 5, updated_at: daysAgo(40), fts: -9, cos: 0.6 });
    const only = cand({ id: 6, updated_at: daysAgo(1), cos: 0.6 });
    const ranked = rankHybrid([only, both], W, NOW);
    expect(ranked[0].id).toBe(5);
    expect(ranked[0].match).toBe("both");
    expect(ranked[1].match).toBe("semantic");
  });

  test("a missing vector does not punish a keyword hit", () => {
    const withVec = cand({ id: 1, cos: 0.6, fts: -8, updated_at: daysAgo(2) });
    const withoutVec = cand({ id: 2, fts: -8, updated_at: daysAgo(2) });
    const ranked = rankHybrid([withVec, withoutVec], W, NOW);
    expect(ranked.find((r) => r.id === 2)!.score).toBeGreaterThan(0.2);
    expect(ranked.every((r) => r.match !== "none")).toBe(true);
  });

  test("a row with no signal at all ranks BELOW any row that has one", () => {
    // the old bug: a recency-only row scored ~0.07 and was carried by recency
    const noSignal = cand({ id: 1, updated_at: daysAgo(0) }); // fresh, no fts, no cos
    const keywordHit = cand({ id: 2, updated_at: daysAgo(300), fts: -4 }); // stale, matches
    const ranked = rankHybrid([noSignal, keywordHit], W, NOW);
    expect(ranked[0].id).toBe(2);
    expect(ranked[0].match).toBe("keyword");
    expect(ranked[1].match).toBe("none");
    expect(ranked[1].score).toBe(0);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  test("an embedded row that did NOT match never outranks a keyword hit", () => {
    // the anti-punishment intent, stated correctly: being un-embedded is not a
    // penalty, but a row that matched nothing is not an answer either.
    const unembeddedButMatched = cand({ id: 1, fts: -6, updated_at: daysAgo(50) });
    const embeddedButUnmatched = cand({ id: 2, cos: 0.2, updated_at: daysAgo(1) });
    const ranked = rankHybrid([embeddedButUnmatched, unembeddedButMatched], W, NOW);
    expect(ranked[0].id).toBe(1);
    expect(ranked[0].match).toBe("keyword");
    expect(ranked[1].match).toBe("none");
  });

  test("an embedded row's cosine actually influences its score", () => {
    // same keyword hit, same age — only the cosine differs
    const low = cand({ id: 1, fts: -8, cos: 0.46, updated_at: daysAgo(5) });
    const high = cand({ id: 2, fts: -8, cos: 0.65, updated_at: daysAgo(5) });
    const ranked = rankHybrid([low, high], W, NOW);
    expect(ranked[0].id).toBe(2);
    expect(ranked[0].cos).toBeCloseTo(0.65, 6);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
    // and the cosine is not decorative: drop it and the scores must collapse
    const withoutCos = rankHybrid([cand({ id: 1, fts: -8, updated_at: daysAgo(5) })], W, NOW);
    expect(withoutCos[0].score).toBeLessThan(ranked[1].score);
  });

  test("cosine is used for a row that is not in the semantic top pool", () => {
    // the BUG B shape: a keyword hit that happens to be embedded must still
    // contribute its cosine, whether or not it made the semantic top-N
    const embedded = cand({ id: 1, fts: -8, cos: 0.62, updated_at: daysAgo(5) });
    const notEmbedded = cand({ id: 2, fts: -8, updated_at: daysAgo(5) });
    const ranked = rankHybrid([notEmbedded, embedded], W, NOW);
    const e = ranked.find((r) => r.id === 1)!;
    const n = ranked.find((r) => r.id === 2)!;
    expect(e.match).toBe("both");
    expect(n.match).toBe("keyword");
    expect(e.score).toBeGreaterThan(n.score);
  });

  test("disputed trust ranks below verified at equal relevance", () => {
    const verified = cand({ id: 1, trust: "verified", cos: 0.8, updated_at: daysAgo(2) });
    const disputed = cand({ id: 2, trust: "disputed", cos: 0.8, updated_at: daysAgo(2) });
    const ranked = rankHybrid([verified, disputed], W, NOW);
    expect(ranked[0].id).toBe(1);
  });

  test("ranking is deterministic for equal candidates", () => {
    const a = cand({ id: 10, cos: 0.6, updated_at: daysAgo(3) });
    const b = cand({ id: 11, cos: 0.6, updated_at: daysAgo(3) });
    const r1 = rankHybrid([a, b], W, NOW).map((r) => r.id);
    const r2 = rankHybrid([b, a], W, NOW).map((r) => r.id);
    expect(r1).toEqual(r2);
  });

  test("with no vectors anywhere the order collapses to the bm25 order (FTS5 guard)", () => {
    const cands = [
      cand({ id: 10, updated_at: daysAgo(1), fts: -2 }),
      cand({ id: 11, updated_at: daysAgo(300), fts: -9 }),
      cand({ id: 12, updated_at: daysAgo(1), fts: -5 }),
    ];
    const ranked = rankHybrid(cands, W, NOW);
    expect(ranked.map((r) => r.id)).toEqual([11, 12, 10]);
    expect(ranked.every((r) => r.cos === null)).toBe(true);
  });

  test("no candidate leaks a raw vector field", () => {
    const ranked = rankHybrid([cand({ id: 50, cos: 0.6, fts: -9 })], W, NOW);
    const json = JSON.stringify(ranked);
    expect(json).not.toContain('"vec"');
    expect(json.length).toBeLessThan(1000);
  });
});

describe("dedupe by meaning", () => {
  test("a newer near-duplicate supersedes the older one, older is shadowed", () => {
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
    const { kept, shadowed } = dedupeByMeaning([newer, older], W, new Map([[1, va], [2, vb]]), NOW);
    expect(kept.map((k) => k.id)).toEqual([2]);
    expect(kept[0].supersedes).toEqual([1]);
    expect(shadowed.map((s) => s.id)).toEqual([1]);
    expect(shadowed[0].by).toBe(2);
  });

  test("the measured 0.78-0.83 near-dup band IS collapsed (the BUG F case)", () => {
    const [va, vb] = pairAt(0.8);
    const older = cand({ id: 848, updated_at: daysAgo(90), cos: 0.6 });
    const newer = cand({ id: 849, updated_at: daysAgo(2), cos: 0.58 });
    const ranked = rankHybrid([older, newer], W, NOW);
    const { kept, shadowed } = dedupeByMeaning(ranked, W, new Map([[848, va], [849, vb]]), NOW);
    expect(kept.map((k) => k.id)).toEqual([849]);
    expect(shadowed[0]).toEqual({ id: 848, by: 849, cos: 0.8 });
  });

  test("IDENTICAL timestamps: the higher id is the newer vintage and wins", () => {
    // this corpus was bulk-imported, so every row shares an import timestamp
    // and the age cannot tell the vintages apart. Insertion order can.
    const [va, vb] = pairAt(0.828);
    const stamp = daysAgo(90);
    const old = cand({ id: 848, updated_at: stamp, created_at: stamp, cos: 0.6 });
    const correction = cand({ id: 849, updated_at: stamp, created_at: stamp, cos: 0.58 });
    const ranked = rankHybrid([old, correction], W, NOW);
    const { kept, shadowed } = dedupeByMeaning(ranked, W, new Map([[848, va], [849, vb]]), NOW);
    expect(kept.map((k) => k.id)).toEqual([849]);
    expect(kept[0].supersedes).toEqual([848]);
    expect(shadowed.map((s) => s.id)).toEqual([848]);
    expect(shadowed[0].by).toBe(849);
  });

  test("a near-duplicate pair 100 days apart still collapses to the newer row", () => {
    const [va, vb] = pairAt(0.82);
    const old = cand({ id: 10, updated_at: daysAgo(100), cos: 0.6 });
    const new_ = cand({ id: 11, updated_at: daysAgo(0.5), cos: 0.58 });
    const ranked = rankHybrid([old, new_], W, NOW);
    const { kept, shadowed } = dedupeByMeaning(ranked, W, new Map([[10, va], [11, vb]]), NOW);
    expect(kept.map((k) => k.id)).toEqual([11]);
    expect(shadowed.map((s) => s.id)).toEqual([10]);
  });

  test("the SUPERSEDES pair (#907 / #916) collapses to the higher id", () => {
    const [va, vb] = pairAt(0.79);
    const stamp = daysAgo(90);
    const old = cand({ id: 907, updated_at: stamp, created_at: stamp, cos: 0.6 });
    const supersedes = cand({ id: 916, updated_at: stamp, created_at: stamp, cos: 0.58 });
    const ranked = rankHybrid([old, supersedes], W, NOW);
    const { kept, shadowed } = dedupeByMeaning(ranked, W, new Map([[907, va], [916, vb]]), NOW);
    expect(kept.map((k) => k.id)).toEqual([916]);
    expect(shadowed.map((s) => s.id)).toEqual([907]);
  });

  test("genuinely different memories are both kept", () => {
    const a = cand({ id: 1, cos: 0.6 });
    const b = cand({ id: 2, cos: 0.6 });
    const { kept, shadowed } = dedupeByMeaning([a, b], W, new Map([[1, axisPair(0, 1)], [2, axisPair(0, 2)]]), NOW);
    expect(kept.length).toBe(2);
    expect(shadowed.length).toBe(0);
  });

  test("a pair just below the threshold is NOT collapsed", () => {
    const [va, vb] = pairAt(0.74);
    const a = cand({ id: 1, updated_at: daysAgo(90), cos: 0.6 });
    const b = cand({ id: 2, updated_at: daysAgo(2), cos: 0.6 });
    const ranked = rankHybrid([a, b], W, NOW);
    const { kept, shadowed } = dedupeByMeaning(ranked, W, new Map([[1, va], [2, vb]]), NOW);
    expect(kept.length).toBe(2);
    expect(shadowed).toEqual([]);
  });

  test("within the margin the pair is a TIE: insertion order decides, not match quality", () => {
    // the old rule let the better-matching row keep its place whenever the two
    // were within the margin. On an imported corpus that keeps the OLD vintage
    // and shadows the correction — the exact bug this feature exists to fix.
    // Within the margin the pair is one vintage, and the higher id is newer.
    const [va, vb] = pairAt(0.85);
    const a = cand({ id: 30, updated_at: daysAgo(10), cos: 0.62 });
    const b = cand({ id: 31, updated_at: daysAgo(10 - 2 / 24), cos: 0.6 }); // 2h newer only
    const ranked = rankHybrid([a, b], W, NOW);
    const { kept, shadowed } = dedupeByMeaning(ranked, W, new Map([[30, va], [31, vb]]), NOW);
    expect(kept.length).toBe(1);
    expect(shadowed.length).toBe(1);
    expect(kept[0].id).toBe(31); // the newer vintage, by insertion order
    expect(shadowed[0].id).toBe(30);
    expect(shadowed[0].by).toBe(31);
  });

  test("beyond the margin the genuinely younger row wins even with a lower id", () => {
    const [va, vb] = pairAt(0.85);
    const old = cand({ id: 99, updated_at: daysAgo(100), cos: 0.6 }); // older AND higher id
    const fresh = cand({ id: 10, updated_at: daysAgo(0.5), cos: 0.58 });
    const ranked = rankHybrid([old, fresh], W, NOW);
    const { kept, shadowed } = dedupeByMeaning(ranked, W, new Map([[99, va], [10, vb]]), NOW);
    expect(kept.map((k) => k.id)).toEqual([10]); // age wins outside the margin
    expect(shadowed.map((s) => s.id)).toEqual([99]);
  });

  test("a near-duplicate CLUSTER elects the newest vintage, not the most similar", () => {
    // the "Hermes Provider Setup" / "Hermes Model Setup" / "current topology"
    // trio: #647 is the most SIMILAR to #588 (0.80) but #894 is the current
    // version. Picking by cosine alone would keep the wrong survivor.
    //   cos(588,647)=0.80   cos(588,894)=0.78   cos(647,894)=0.78
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
    expect(cosine(v588, v647)).toBeCloseTo(0.8, 5);
    expect(cosine(v588, v894)).toBeCloseTo(0.78, 5);
    expect(cosine(v647, v894)).toBeCloseTo(0.78, 5);

    const stamp = daysAgo(90);
    const r588 = cand({ id: 588, updated_at: stamp, created_at: stamp, cos: 0.6 });
    const r647 = cand({ id: 647, updated_at: stamp, created_at: stamp, cos: 0.6 });
    const r894 = cand({ id: 894, updated_at: stamp, created_at: stamp, cos: 0.6 });
    const ranked = rankHybrid([r588, r647, r894], W, NOW);
    const { kept, shadowed } = dedupeByMeaning(
      ranked,
      W,
      new Map([
        [588, v588],
        [647, v647],
        [894, v894],
      ]),
      NOW,
    );
    // #894 is the highest id => the newest vintage => it survives, and the
    // older two are shadowed by it (not by the merely-more-similar #647)
    expect(kept.map((k) => k.id)).toEqual([894]);
    expect(kept[0].supersedes?.sort()).toEqual([588, 647]);
    expect(shadowed.map((s) => s.id).sort()).toEqual([588, 647]);
    expect(shadowed.every((s) => s.by === 894)).toBe(true);
  });

  test("rows without a vector pass through untouched", () => {
    const [va, vb] = pairAt(0.9);
    const noVec = cand({ id: 40, updated_at: daysAgo(1), fts: -5 });
    const older = cand({ id: 1, updated_at: daysAgo(100), cos: 0.9 });
    const newer = cand({ id: 2, updated_at: daysAgo(1), cos: 0.9 });
    const ranked = rankHybrid([noVec, older, newer], W, NOW);
    const { kept } = dedupeByMeaning(ranked, W, new Map([[1, va], [2, vb]]), NOW);
    expect(kept.map((k) => k.id)).toContain(40);
  });

  test("no vector map means no dedupe and no crash", () => {
    const ranked = rankHybrid([cand({ id: 1, cos: 0.9 }), cand({ id: 2, cos: 0.9 })], W, NOW);
    const { kept, shadowed } = dedupeByMeaning(ranked, W, null, NOW);
    expect(kept.length).toBe(2);
    expect(shadowed).toEqual([]);
  });

  test("dedupe output still carries no raw vector", () => {
    const [va, vb] = pairAt(0.9);
    const ranked = rankHybrid(
      [cand({ id: 1, updated_at: daysAgo(100), cos: 0.9 }), cand({ id: 2, updated_at: daysAgo(1), cos: 0.9 })],
      W,
      NOW,
    );
    const { kept } = dedupeByMeaning(ranked, W, new Map([[1, va], [2, vb]]), NOW);
    expect(JSON.stringify(kept)).not.toContain('"vec"');
  });
});

describe("env knobs", () => {
  const withEnv = (vars: Record<string, string | undefined>, fn: () => void) => {
    const saved = { ...process.env };
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      fn();
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  };

  test("the DEPLOYED env spelling is honoured (the BUG E case)", () => {
    // the deployed env file uses SEM_HALF_LIFE_DAYS and SEM_DEDUPE_THRESHOLD.
    // The generic `SEM_${k}` rule cannot produce those from DECAY_HALF_LIFE_DAYS
    // / NEAR_DUP_COS, so they need an explicit alias list.
    withEnv({ SEM_HALF_LIFE_DAYS: "10", SEM_DEDUPE_THRESHOLD: "0.5" }, () => {
      const w = weights();
      expect(w.halfLifeDays).toBe(10);
      expect(w.nearDupCos).toBe(0.5);
    });
  });

  test("the deployed spelling wins over the legacy one", () => {
    withEnv(
      {
        SEM_HALF_LIFE_DAYS: "10",
        SEM_DECAY_HALF_LIFE_DAYS: "20",
        DECAY_HALF_LIFE_DAYS: "30",
        SEM_DEDUPE_THRESHOLD: "0.5",
        SEM_NEAR_DUP_COS: "0.6",
        NEAR_DUP_COS: "0.7",
      },
      () => {
        const w = weights();
        expect(w.halfLifeDays).toBe(10);
        expect(w.nearDupCos).toBe(0.5);
      },
    );
  });

  test("the legacy spelling still works when the deployed one is absent", () => {
    withEnv(
      {
        SEM_HALF_LIFE_DAYS: undefined,
        SEM_DEDUPE_THRESHOLD: undefined,
        SEM_DECAY_HALF_LIFE_DAYS: "20",
        DECAY_HALF_LIFE_DAYS: undefined,
        SEM_NEAR_DUP_COS: "0.6",
        NEAR_DUP_COS: undefined,
      },
      () => {
        const w = weights();
        expect(w.halfLifeDays).toBe(20);
        expect(w.nearDupCos).toBe(0.6);
      },
    );
    withEnv(
      {
        SEM_HALF_LIFE_DAYS: undefined,
        SEM_DEDUPE_THRESHOLD: undefined,
        SEM_DECAY_HALF_LIFE_DAYS: undefined,
        DECAY_HALF_LIFE_DAYS: "30",
        SEM_NEAR_DUP_COS: undefined,
        NEAR_DUP_COS: "0.7",
      },
      () => {
        const w = weights();
        expect(w.halfLifeDays).toBe(30);
        expect(w.nearDupCos).toBe(0.7);
      },
    );
  });

  test("legacy SEM_* spelling is honoured by the same knob", () => {
    withEnv(
      {
        SEM_NEAR_DUP_COS: "0.81",
        SEM_DECAY_HALF_LIFE_DAYS: "7",
        SEM_MIN_RELEVANCE: "0.52",
        SEM_DEDUPE_THRESHOLD: undefined,
        SEM_HALF_LIFE_DAYS: undefined,
        NEAR_DUP_COS: undefined,
        DECAY_HALF_LIFE_DAYS: undefined,
      },
      () => {
        const w = weights();
        expect(w.nearDupCos).toBe(0.81);
        expect(w.halfLifeDays).toBe(7);
        expect(w.minRelevance).toBe(0.52);
      },
    );
    // canonical spelling wins when both are present
    withEnv(
      {
        SEM_DEDUPE_THRESHOLD: undefined,
        SEM_HALF_LIFE_DAYS: undefined,
        SEM_NEAR_DUP_COS: undefined,
        SEM_DECAY_HALF_LIFE_DAYS: undefined,
        NEAR_DUP_COS: "0.77",
        DECAY_HALF_LIFE_DAYS: "9",
      },
      () => {
        const w = weights();
        expect(w.nearDupCos).toBe(0.77);
        expect(w.halfLifeDays).toBe(9);
      },
    );
    expect(weights().minRelevance).toBe(0.5);
  });

  test("defaults match the measured corpus distribution", () => {
    const w = weights();
    // measured on the live corpus: true revision pairs sit at 0.767-0.828,
    // the p50 top-1 neighbour is 0.702 and unrelated topical pairs at 0.61-0.68
    expect(w.nearDupCos).toBe(0.76);
    // good semantic hits measure 0.51-0.65, corpus p50 0.28-0.44
    expect(w.minRelevance).toBe(0.5);
    expect(w.noiseFloor).toBeLessThan(w.goodCeil);
    expect(w.noiseFloor).toBe(0.45);
    expect(w.goodCeil).toBe(0.65);
    // recency is a tie-breaker, not a signal of its own
    expect(w.rec).toBeLessThanOrEqual(0.2);
  });
});
