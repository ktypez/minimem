// RED test for Fix A: keyword extraction must preserve identifiers and drop stopwords.
// Run: bun test /home/admin/projects/minimem/search.test.ts
import { test, expect } from "bun:test";

import { keywords, matchExpr } from "./search_kw.ts";

test("keeps identifiers intact (the OLD bug truncated them)", () => {
  // Intl.Segmenter("th") splits on the hyphen: 13-theme -> ["13", "theme"].
  expect(keywords("13-theme")).toContain("13-theme");
  expect(keywords("0005_client_branch.sql")).toContain("0005_client_branch.sql");
  expect(keywords("2.0.0-preview.4")).toContain("2.0.0-preview.4");
  expect(keywords("HERMES_TELEGRAM_DISABLE_FALLBACK_IPS")).toContain(
    "HERMES_TELEGRAM_DISABLE_FALLBACK_IPS",
  );
});

test("does not flood the OR-query with stopwords", () => {
  // Only assert on stopwords that are actually in the shipped STOP list. Adding
  // new entries (e.g. "keeps", "using") would change retrieval behaviour away
  // from the 11/13 paraphrase benchmark, so that needs a re-measure, not a test edit.
  const k = keywords("what keeps the two versions of the app using identical colour sets");
  expect(k).not.toContain("what");
  expect(k).not.toContain("the");
  expect(k).not.toContain("of");
  // ...and the terms that ARE content must survive the filtering. Exact list
  // pins the behaviour so an accidental change to STOP or the cap is visible.
  expect(k).toEqual(["keeps", "two", "versions", "app", "using", "identical", "colour", "sets"]);
});

test("keeps content words", () => {
  expect(keywords("what keeps the two versions of the app using identical colour sets")).toContain("identical");
  expect(keywords("what keeps the two versions of the app using identical colour sets")).toContain("versions");
  expect(keywords("what keeps the two versions of the app using identical colour sets")).toContain("colour");
});

test("drops 1-2 char noise but keeps Thai of 3+ chars", () => {
  expect(keywords("a I to")).toHaveLength(0);
  expect(keywords("หน้า detail")).toContain("หน้า");
  expect(keywords("หน้า detail")).toContain("detail");
});

test("does not drop a short but meaningful identifier", () => {
  // "1-indexed" is 8 chars but only 1 leading digit token; trigram needs 3 chars.
  expect(keywords("1-indexed")).toContain("1-indexed");
});

test("caps output so the OR-query stays bounded", () => {
  expect(keywords("one two three four five six seven eight nine ten eleven twelve", 8).length).toBeLessThanOrEqual(8);
  expect(keywords("one two three four five six seven eight nine ten eleven twelve", 8).length).toBeGreaterThan(0);
});

test("dedupes and strips FTS5 double quotes", () => {
  const k = keywords('the "quoted" quoted');
  expect(k.filter((w) => w === "quoted").length).toBe(1);
  expect(k.some((w) => w.includes('"'))).toBe(false);
});