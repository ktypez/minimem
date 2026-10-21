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

| model | precision | recall | F1 | pairs decided | time |
|---|---|---|---|---|---|
| **hyper/glm-5.3-flash** | 0.94 | 0.90 | **0.92** | 48 of 55 | 76s |
| hyper/qwen3.8-flash | 0.83 | 0.87 | 0.85 | 55 | 195s |
| ag/gemini-3.8-flash-high | 0.90 | 0.78 | 0.84 | 55 | 552s |

The sweep that produced this table ran before the model was asked again for
the pairs it quietly omitted, so `hyper/glm-5.3-flash` is scored on the 48
pairs it answered and the other two on all 55. Its rate of answering every
pair at all was part of why it won.

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

**The live relation set is the merge of a model run and a hand check.** The
model's own false collapses were removed by hand, and three confirmed revisions
that the model found but the earlier run had missed were added. On the
hand-labelled corpus the live set now scores:

| | relations | correct | wrong | precision | recall | F1 |
|---|---|---|---|---|---|---|
| before | 32 | 19 | 3 | 0.86 | 0.68 | 0.76 |
| **after** | **32** | **22** | **0** | **1.00** | **1.00** | **1.00** |

Every relation the model proposed was checked against the labels before it
was written, and the ones it got wrong — a *branch display* note collapsed
into a *copy format* note, and a *Signal API migration* collapsed into two
*Clerk Core 3 migration* notes — were removed. The one relation a human
made is still marked as such and was left alone.

The last row is not a model score: it is a hand-checked set. Every relation
in it was compared with a hand label before it was written, so a perfect
score is the expected result of the check, not evidence that the model
would have got there unaided. What the model score above *does* show is
that its suggestions can be used as they are, which is the thing that makes
the hand check cheap.

**Six of the hand labels were wrong**, and they were found by *disagreeing*
with the model rather than by agreeing with it. #1064 (what the port
*contains*: 7 themes ported, typed manifests, one generic canvas renderer,
svelte-check, build and the full test suite) and #1065 (the *deployment*:
branch pushed, `vercel promote`, a new production deployment) had both been
labelled *same* — one fact in two vintages. They are not: one states what
was built, the other where it went. The best model called both *diff* and
was being scored as wrong for it.

Fixing that one label exposed the rule the labels had been missing, and
re-auditing the rest of the corpus against it corrected five more: #1063
(the deployment *setup* and its gotchas) against #1065 (the cutover
*completing*), #853 (a routing map over four model names) against #891
(the systemone API contract), #890 (OpenChamber's classification-provider
role) against #891 again, and #803 (the catalog row layout and its deploy)
against #810 (the compaction of those rows, plus a separate Maps layout
change). The criterion is now written down and applies to all of them:

> **Two records are the same fact when they assert the same thing about the
> same subject.** The later one may add detail, refine a number, correct the
> earlier one, or re-measure it — that is still the same fact. They are
> different facts when they are about different subjects or record different
> events and neither replaces the other.

A later note that *explicitly replaces* the earlier one is the same fact by
definition: #855 "Removed CF Workers AI code", #849 "Correction 2026-09-26",
#810 "after the first spacing pass", #1096 "was PUSHED". That wording is the
signal, and every model tested here under-read it — which is why the false
negatives clustered on exactly those pairs.

That observation suggests the obvious fix, and the obvious fix does not work.
A prompt that says "extra detail does not make a pair DIFFERENT" and "wording
that announces replacement is strong evidence of SAME" was measured against
the production prompt on the same claims, the same model and the same votes:

| prompt | precision | recall | F1 |
|---|---|---|---|
| **production (merge test)** | 0.571 | 0.909 | **0.702** |
| sharpened | 0.525 | 0.955 | 0.677 |

It does exactly what it was designed to do — false negatives fall from 2 to 1
— and it is still a net loss, because false positives rise from 15 to 19. The
trade is asymmetric and the reason is structural: the corpus holds more
distinct pairs (33) than same-fact pairs (22), and a false collapse is not
a wrong answer, it is a *deletion* — the distinct fact stops being recalled
for every query that would have found it. Recall is cheap to lose and
expensive to spend, so the prompt stays where it is.

(The measurement ran on the fallback model, because the provider was out of
credits; the comparison is between the two prompts on one model, which is
what makes it valid. `judgePairs` now takes a prompt override so an A/B runs
on the production path rather than on a copy of it.)

The obvious next move would be to fix the *extraction*, on the theory that the
judge is being misled by the `subject` field: for the pair that every model
got wrong, the extractor had written

    #848 subject = "Jev model on Vercel AI Gateway"
    #849 subject = "Vercel AI Gateway free promos: jev vs tako-search"

and the judge sees those two lines first. If the subject disagreement is
what drives the false negative, the fix belongs upstream. It does not.

Measuring subject overlap (Jaccard over the two subjects) against the labels
says the opposite:

| | subject overlap |
|---|---|
| same-fact pairs (22) | mean 0.406 |
| different-fact pairs (33) | mean **0.501** |

The overlap is *higher* for the pairs that are not the same fact. All 22
same-fact pairs share at least one subject token, but 8 different-fact pairs
have **identical** subjects — six of them the swiss-redesign screenshots
("swiss-redesign screenshot" on both sides), and #1096/#1099 ("Portal
(me.mcky.space) status" on both sides), which is exactly the false positive
the best model made.

So the `subject` field is not a signal for this decision; it is slightly
anti-correlated with it, and the deterministic veto in `curate.ts` — not the
judge — is what keeps the screenshot family apart. The judge is right to work
from the *claim*. No change was made to the extractor, and the live
`is_update` flag was left where it is.

Calibrated against the pairs the labels are confident about — #948/#949 both
describe the cutover *arrangement* (same), #907/#916 carry explicit
supersession wording (same) — every score in this document is against the
corrected labels. Correcting them took the best model from F1 0.85 to 0.92
and the live set from 0.88 to 1.00.

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

## The check must own its server

`check-dedupe.ts` starts its own server and queries it over HTTP. It used to
bind a **fixed** port, and eight servers from earlier runs were still bound
to it, so `fetch` landed on whichever one the kernel picked — not the server
this run had just started. The check then read a stranger's state and failed
for reasons that had nothing to do with the code under test; one run crashed
on the missing row.

Two rules follow, and they are cheap:

- **the port is found, not chosen** — bind it first, release it, and use it
  only if it was free, so the script always owns the server it queries
- **the child is killed on the way out** — on exit and on SIGINT, so a run
  cannot leave a server behind for the next one to trip over

A check that can pass or fail depending on which process answers it is not a
check. If the verdict ever disagrees with the code, look for this first.
