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
in isolation, 0.75 end-to-end over the whole pipeline (precision 0.83,
recall 0.68).

Worked examples in the prompt matter a lot, and so does the *direction* of the
examples: the hard cases are "same tracked thing, later state" (a version bump
is the same fact) versus "two events about one project" (a migration and its
E2E test are two facts).

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
