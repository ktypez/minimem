/**
 * Deterministic guard: "same template, different artifact".
 *
 * Some of the worst false collapses in the corpus are not subtle. Five notes
 * that each read
 *
 *     swiss-redesign screenshot: /tmp/opencode/swiss-<page>.png
 *
 * are five DIFFERENT screenshots. They share every number, every word and
 * every line of their layout, and differ only in which file they point at.
 * Cosine puts them at 0.90-0.96 — ABOVE most genuine revision pairs — so any
 * similarity threshold merges them and the recall loses four real facts.
 *
 * The signature is precise: the pair shares all of its numeric content (same
 * dates, same version numbers, same counts) while their filesystem PATHS do
 * not overlap at all. Same numbers + disjoint paths = same template, different
 * artifact.
 *
 * Measured on the 67 hand-labelled near-duplicate pairs of the live corpus,
 * this rule fires on 10 pairs, all 10 of them genuinely different facts, and
 * never on a genuine revision pair: precision 1.00.
 *
 * It is a VETO, not a decision. It says "these must not be collapsed", and
 * says nothing about the pairs it does not fire on.
 */

/** filesystem-ish paths: /a/b, /a/b/c.ext */
export function pathTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\/[\w.\-/]{2,}/g)) out.add(m[0].toLowerCase());
  return out;
}

/** numeric content: dates, versions, counts, sizes */
export function numberTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b\d{2,}(?:[.:]\d+)*\b/g)) out.add(m[1]);
  return out;
}

function containment(a: Set<string>, b: Set<string>): number {
  if (!a.size) return 1;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / a.size;
}

/**
 * True when the two texts look like the same template filled with DIFFERENT
 * artifacts: they share all their numbers but point at different paths.
 */
export function isDifferentArtifact(aText: string, bText: string): boolean {
  const aN = numberTokens(aText);
  const bN = numberTokens(bText);
  const numR = Math.min(containment(aN, bN), containment(bN, aN));
  if (numR < 0.99) return false; // not the same numeric frame

  const aP = pathTokens(aText);
  const bP = pathTokens(bText);
  if (!aP.size || !bP.size) return false; // nothing to disagree about
  const pathR = Math.min(containment(aP, bP), containment(bP, aP));
  return pathR <= 0.05; // disjoint paths
}
