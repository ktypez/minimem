# Deciding "is this the same fact?"

A design note on the supersede mechanism, and on why the thing it replaced was
wrong.

## The complaint

> an old memory is recalled as if it were current

Two notes about one thing, written on different days, are two **vintages of one
fact**. Recalling the old one as if it were the truth is the bug. The fix is to
not recall it — not to delete it: the old note stays in the store, in
`/memories`, in the history, and in `shadowed` when it gets superseded.

## Why cosine could not do it

The first version decided "these two memories state the same thing" when their
bge-m3 embeddings sat at cosine >= 0.78.

Cosine measures **topical similarity**, not **factual identity**. Two notes
about the same project that assert different things land very close together.
Measured on the live corpus at 0.78:

| | count |
|---|---|
| candidate pairs | 67 |
| really the same fact (collapse was right) | 28 |
| **different facts (collapse was wrong)** | **27** |
| borderline | 12 |

And the false ones were not the marginal ones. The corpus holds five
`swiss-redesign screenshot: /tmp/opencode/swiss-<page>.png` notes — five
*different* screenshots — and they sat at **0.90 to 0.96** against each other,
above most of the genuine revision pairs.

A false collapse is not cosmetic. It deletes a distinct fact from the recall of
every query that would have found it. The recall for "how do I check the lab
health" was returning the *provider setup* note, because the two documents
happened to be about the same product.

## Why no lexical substitute works either

"Different facts" versus "the same fact" was re-measured with five
deterministic features over the same 67 hand-labelled pairs:

| feature | best F1 |
|---|---|
| rare-token containment | 0.68 |
| IDF-weighted token overlap | 0.77 |
| heading skeleton | 0.68 |
| chunk-level claim coverage | 0.68 |
| topic-claim cosine | 0.69 |
| *(prior: always collapse)* | 0.68 |

None of them beats guessing. The two populations overlap almost completely:
there is no threshold on any of these that separates them.

Chunk-level claim coverage was measured a second time, more carefully, because
it is the most plausible of the five: split each document into its claims,
embed every claim, and call two documents the same fact when every claim of
one is matched by a claim of the other at cosine 0.80. It is *precise* and
*incomplete*:

| rule | precision | recall | F1 |
|---|---|---|---|
| chunk coverage, every claim matched | 0.92 | 0.61 | 0.73 |
| merge test + stored relations | 0.86 | 0.68 | **0.76** |

Seven of the eighteen genuine revision pairs share no claim at all — a
reworded note and its correction have no common sentence — so coverage
cannot see them however the threshold is set. It is a good *precision* signal
and a poor *identity* test, which is the opposite of what this feature needs.

## What is done instead

The question is semantic, so it is answered by a model — but **once**, offline,
and the answer is stored.

### Stage 1 — reduce each memory to its claim

Each memory is reduced to `subject` / `claim` / `artifact` / `time` and cached
in `memory_claims`. The cost is paid once per memory, not once per pair.

The subject is the note's **headline topic**, and the prompt says so with a
worked example, because the first version read the subject off the note's
opening clause — so a note that opens *"this supersedes an earlier note about
X"* got filed under X. That is exactly how the Hermes maintenance note came to
be filed as "provider configuration" and then collapsed with the provider setup
note.

### Stage 2 — the merge test

The two reduced claims are compared with one question:

> Imagine merging the two notes into ONE note that keeps every piece of
> information from both. If the merged note would be **one coherent
> statement** (the second just updates, refines or corrects the first) ->
> **SAME**. If it would have to be **two separate statements** (each carrying
> information the other lacks) -> **DIFFERENT**.

The merge test is what made this work. Asking *"are these the same fact?"*
scored 56% accuracy; the merge test with the same model family scored F1 0.85
in isolation, 0.76 end-to-end over the whole pipeline.

Worked examples in the prompt matter a lot, and so does the *direction* of the
examples: the hard cases are "same tracked thing, later state" (a version bump
is the same fact) versus "two events about one project" (a migration and its
E2E test are two facts).

A stricter prompt was tried and rejected on measurement: symmetric wording,
"the same SUBJECT and the same ATTRIBUTE", "the shared project name or date
alone is NEVER enough for SAME". It reads better and scores **worse** — F1 0.65
against 0.76 — because it refuses the vintage pairs whose *value* changed (a
row height that went from 77px to 65px, a roster re-listed with a different
set, a commit that went from not-pushed to pushed). Those are exactly the
pairs the feature exists to collapse.

A third framing is worth recording because it sounds best of all: *"if one of
the notes were deleted, would information exist that is ONLY in the deleted
note?"* On a weak model it produced **no false collapses at all**, which is
exactly what made it worth measuring properly. Through the real pipeline it
is a disaster — F1 0.29, recall 0.18, answering DIFFERENT for 59 of 67
pairs. The question is vacuously "yes" for any revision, because a later
version always adds *something*: a new value, a new timestamp, a correction.
So it collapses nothing, and it misses 23 of the 28 genuine pairs. It is
selectable with `--style deletion` so the comparison stays reproducible.

| prompt framing | precision | recall | F1 |
|---|---|---|---|
| merge test (default) | 0.78 | 0.75 | **0.76** |
| symmetric / "same subject and attribute" | 0.78 | 0.61 | 0.65 |
| "would anything be lost by deleting one?" | 0.83 | 0.18 | 0.29 |

### Which model decides

The adjudicator's model is chosen by measurement, not by taste. Same merge
prompt, same claims, same 55 hand-labelled pairs of the live corpus:

| model | precision | recall | F1 | time |
|---|---|---|---|---|
| **hyper/glm-5.3-flash** | 0.94 | 0.77 | **0.85** | 76s |
| hyper/qwen3.8-flash | 0.83 | 0.71 | 0.77 | 195s |
| auto (the router's pick) | 0.78 | 0.75 | 0.76 | 300s |
| ag/gemini-3.8-flash-high | 0.90 | 0.64 | 0.75 | 552s |

`hyper/glm-5.3-flash` wins on every axis that matters and is also the
fastest — seven times quicker than the route `auto` happened to pick, so the
better model is the cheaper one. It is the default. `auto` is a fallback
rather than the default because letting the router choose means the verdict
quality changes with whatever the router is routing to that day.

A provider that answers *out of credits* or *authentication failed* is
**quarantined for the rest of the run** instead of being retried on every
batch. Before this, a hyper outage cost one failed round trip per batch per
dead model; now it costs one, and the run continues on the fallback. This
mattered in practice: the sweep below was run while hyper had credits, and
a later pipeline run silently fell back to `auto` and scored 0.68 instead of
0.85 — a difference that would have looked like a regression in the feature
rather than an empty wallet.

**The live relations were hand-corrected on top of a model run**, which is why
they score better (F1 0.76) than a fresh pipeline run of the same fallback
model (F1 0.68): the model's own false collapses were removed by hand, and
the corrections are what the live set contains.

Scored against the 55 unambiguous hand-labelled pairs of the live corpus:

| rule | precision | recall | F1 | false collapses |
|---|---|---|---|---|
| cosine >= 0.78 (the old rule) | 0.52 | 1.00 | **0.51** | **27** |
| merge test + stored relations | 0.86 | 0.68 | **0.76** | **3** |

The old rule's perfect recall is not a virtue: it comes from collapsing
everything, including 27 distinct facts. The new rule trades some recall for
precision, and the trade is the right way round — a false collapse deletes a
fact from every query that would have found it, while a missed collapse only
leaves a redundant note next to the current one.


### Stage 3 — store the relation

A `SAME` verdict writes a row into `supersedes(id_a, id_b, reason,
decided_by)`. `id_a` is the current record.

A `DIFFERENT` verdict writes **nothing**. Both memories keep being recalled.
That is the safe direction: a redundant memory costs a little, a missing
memory is a silent hole.

A model failure is skipped, never guessed.

## How the recall path uses it

It **reads** the relations. It never guesses.

With no relation, nothing is collapsed. A pair is only ever shadowed when a
relation says it is a stale version of another. The vintage choice (which of
the two is current) falls back to time — newer `updated_at` wins, and on an
imported corpus where every row shares a timestamp, the higher id wins, since
it was inserted later.

## The deterministic veto

One class of false collapse is mechanical enough to catch without a model: the
same template pointing at a different artifact. Blank every path out of both
texts; if the remaining skeletons match, the two notes are one template with
the path slot filled differently.

On the 67 labelled pairs it fires on the 10 screenshot pairs and on **nothing
else** — precision 1.00, zero false positives. It is a veto, not a decision:
it says "these must not be collapsed" and says nothing about the pairs it does
not fire on.

## The part a model cannot do

When an agent writes a corrected version of something it already stored, it
knows that the two are the same fact. Nothing in the corpus says so — the
older note is simply there, and a model has to infer it from wording. That
inference is the weakest link in the whole chain.

So the store accepts the declaration directly:

```sh
curl -s -X POST localhost:3100/supersedes \
  -H "Authorization: Bearer $MINIMEM_TOKEN" -H 'content-type: application/json' \
  -d '{"current":849,"other":848,"reason":"#849 is the explicit correction of #848"}'
```

or, over MCP, the `memory_supersede` tool. A wrong relation is undone with
`DELETE /supersedes?current=849&other=848`.

## Files

| file | what it is |
|---|---|
| `adjudicate.ts` | the two stages: claim extraction and the merge test, plus the router client |
| `curate.ts` | the offline pass: find candidates, extract claims, judge, write relations |
| `artifact.ts` | the deterministic template/different-artifact veto |
| `embed.ts` | `dedupeByMeaning` — now takes the relations instead of a threshold |
| `check-dedupe.ts` | live check of both directions: revisions collapse, distinct facts do not |

## Running it

```sh
bun run curate.ts --db /path/to/minimem.db             # dry run — prints what it would write
bun run curate.ts --db /path/to/minimem.db --apply      # write
bun run check-dedupe.ts                                 # live verification
```

The adjudicator talks to the local 9router (`http://127.0.0.1:20128/v1`), so
minimem needs no key of its own and is not exposed to the public gateways'
rate limits. It never runs on the request path: a recall is a table read.

To copy the live database for a test, use `VACUUM INTO` — a plain `cp` misses
the WAL and gives you a stale file.
