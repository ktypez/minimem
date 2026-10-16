# UI checks

Behaviour checks for `public/index.html`, driven in a headless browser over the
Chrome DevTools Protocol. No test framework, no npm dependency: the drivers are
plain `node` scripts using the global `WebSocket` (node ≥ 22).

```sh
sh test/ui/run.sh            # everything
sh test/ui/run.sh drive      # UI suite only   (auth off, :3311)
sh test/ui/run.sh gate       # gate suite only  (auth on,  :3312)
```

`run.sh` brings up one headless chromium and two throwaway server instances
(:3311 with `AUTH_ENABLED=0`, :3312 with `AUTH_ENABLED=1`), runs the suites,
prints `UI CHECK: PASS|FAIL`, and tears everything down. The live service on
`:3100` is never touched. Artefacts (screenshots `NN-*.png`, dbs, logs) land in
`$UI_OUT`, default `$TMPDIR/minimem-uicheck` — nothing is written into the repo.

Needs `chromium` (or `chromium-browser` / `google-chrome`) on `PATH`, or
`CHROME=/path/to/chromium`. `BUN`, `UI_PORT`, `AUTH_PORT`, `CDP_PORT` and
`UI_OUT` override the defaults.

## What each suite covers

| file | checks | what it proves |
| --- | --- | --- |
| `drive.mjs` | 68 | dashboard tiles, theme toggle, history box, recall search + `<mark>` highlighting, tags, the three relay write forms (handoff/lessons/crystals), leases, audit, capture sheet, trash delete/restore, confirm dialogs — then the same page at 390×844, 320×640 and 844×390 for overflow, tap-target size, iOS-safe field sizes and the bottom-docked sheet with its scroll lock |
| `gate.mjs` | 18 | wrong key → error + shake + sad Mimi and nothing written to storage; correct key → unlock; remember-me persists across reload; a stale token reopens the gate; forget wipes it |
| `header.mjs` | 2 | the crowded auth-on header at 390 and 320: every control inside the viewport |

`reset.sh` and `reset-auth.sh` rebuild the seeded stores. **`drive.mjs` mutates
the store** (it acks the handoff, trashes a row, posts a lesson), so it needs a
fresh `reset.sh` each run — that is what `run.sh` does, and what to do by hand if
you invoke the driver directly.

## Writing a check

```js
check('label', await evaluate(`document.querySelector('#c-recent').textContent`) === '4', 'why it failed');
```

`evaluate` throws on an exception in the page, so a broken selector fails loudly
rather than silently passing. Per-viewport work goes in the loop in `drive.mjs`;
add a `check` there instead of writing a new script.

## Gotchas

- The intro title screen covers the page for ~2.4s plus an iris wipe: wait ~4s
  after every `Page.navigate`, or clicks land on the intro.
- Scrubbing between runs: each driver clears `localStorage`/`sessionStorage` for
  its origin first. Without that, a previous run's night theme or saved token
  decides the next run's outcome.
- The gate instance must be seeded (`reset-auth.sh`) or the unlocked view asserts
  a count of 0.
- Scroll-lock checks need real input: `Input.dispatchMouseEvent {type:'mouseWheel'}`
  with a **positive** `deltaY` (positive = down), and a positive control — wheel
  with no dialog open must actually move the page. `window.scrollBy` is no good
  here: programmatic scrolling moves a page whose `overflow` is `hidden`, by
  design.
