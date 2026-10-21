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
