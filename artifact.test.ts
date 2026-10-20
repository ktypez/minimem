import { describe, expect, test } from "bun:test";
import { isDifferentArtifact } from "./artifact.ts";

describe("same template, different artifact", () => {
  test("five screenshots of one app are five different facts", () => {
    // this is the class that broke the old cosine rule: the corpus holds
    // swiss-redesign screenshots at /tmp/opencode/swiss-<page>.png and they sat
    // at 0.90-0.96 against each other, ABOVE most genuine revision pairs.
    const pages = ["dash", "mobile-dash", "tags", "recent", "gate"];
    for (const a of pages) {
      for (const b of pages) {
        if (a === b) continue;
        const ta = `swiss-redesign screenshot: /tmp/opencode/swiss-${a}.png`;
        const tb = `swiss-redesign screenshot: /tmp/opencode/swiss-${b}.png`;
        expect(isDifferentArtifact(ta, tb)).toBe(true);
      }
    }
  });

  test("the same path is not a different artifact", () => {
    const t = "screenshot: /tmp/opencode/swiss-dash.png";
    expect(isDifferentArtifact(t, t)).toBe(false);
  });

  test("a genuine revision is not a template pair", () => {
    // the collage cutover notes talk about the same branch but assert different
    // things: one is about landing the branch, the other about the production
    // promote. They share no path slot, they share a TOPIC.
    const a =
      "collage 2026-10-14 final state: the port landed as branch `collage-sveltekit` (commit 0222810) from apps/web-svelte; the root vercel.json still points at the old build output.";
    const b =
      "collage SvelteKit cutover DONE 2026-10-14: branch collage-sveltekit (0222810) pushed, project 'collage' promoted to production, /api/cleanup and /api/webhook live.";
    expect(isDifferentArtifact(a, b)).toBe(false);
  });

  test("the Hermes index card and its longer sibling are not a template pair", () => {
    const a = "# Hermes # Hermes — AI Agent Herb 🌿 running on POCO F1. - Vault: ~/vault - Dashboard: /dashboard";
    const b = "# Hermes # Hermes 🌿 — Herb AI agent running on POCO F1 (postmarketOS). Watches ~/vault directly. - Config: ~/.hermes/config.yaml";
    expect(isDifferentArtifact(a, b)).toBe(false);
  });

  test("texts without paths are never a template pair", () => {
    expect(isDifferentArtifact("port 4096 is the opencode port", "port 4097 is the other port")).toBe(false);
  });
});
