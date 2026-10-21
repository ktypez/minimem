# Prompt A/B evidence

Per-pair verdicts behind the prompt comparison in
[`../same-fact.md`](../same-fact.md), so the table can be re-scored without
re-running the model — and so a later correction to the hand labels can be
applied to the *same* verdicts.

- `verdicts-A.json` — production prompt (the merge test)
- `verdicts-B.json` — the "sharpened" prompt from the earlier experiment
- `verdicts-C.json` — production prompt plus only the replacement-wording rule
- `verdicts-D.json` — production prompt with the `is_update` flag exposed to the judge
- `ab3.log` — the run output
- `variance-*.json` — repeated runs of each arm, for the noise measurement

Labels come from [`../hand-labels.json`](../hand-labels.json). Each verdict
file carries the label as it was at the time of the run, so re-score with the
current label file, not the embedded one.

## The two experiments

- `variance-*.json` / `variance.log` — the **unpinned** runs: the model was
  `auto`, which on this router is a lottery (eight different free models
  served eight consecutive calls). Between two runs of the same arm, 14-16 of
  the 55 pairs change verdict. This is why the first prompt comparison was
  invalid.
- `pinned-*.json` / `pinned.log` — the **pinned** runs: `ag/gemini-3.8-flash-low`
  (served by `gemini-3.8-flash-n` on every call), six pairs per call, three
  runs per arm. Between two runs of the same arm, 1-4 of the 55 pairs change
  verdict.

Arms: `A` production (merge test), `B` the sharpened prompt, `C` production
plus only the replacement-wording rule.

Note for anyone re-scoring: the prompts' worked examples are themselves
labelled pairs in the corpus (#992/#993, #1091/#1093, #934/#935 in the
production prompt; #848/#849, #1064/#1065 in the sharpened one), so a score
on this corpus is inflated for every arm. Hold those pairs out to compare
prompts honestly.
