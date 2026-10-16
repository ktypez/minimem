// Gate (auth on) path: wrong key → error, right key → unlock, remember-me → persist.
// Config comes from the environment so run.sh can drive two instances at once:
// Auth-on instance: the gate only exists when AUTH_ENABLED=1 and a token is set.
const CDP = +(process.env.CDP_PORT || 9222);
const BASE = process.env.UI_URL || 'http://127.0.0.1:3312/';
const OUT = (process.env.UI_OUT || '/tmp/minimem-uicheck').replace(/\/?$/, '/');
const ORIGIN = new URL(BASE).origin;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ver = await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json();
const tgt = await (await fetch(`http://127.0.0.1:${CDP}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(tgt.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pend = new Map(); const events = [];
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  else events.push(m);
});
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('EVAL ' + expr.slice(0, 60) + ': ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
};
const shot = async n => { const r = await send('Page.captureScreenshot', { format: 'png' }); (await import('node:fs')).writeFileSync(OUT + n + '.png', Buffer.from(r.data, 'base64')); };
const problems = [];
const check = (l, ok, x = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + l + (x ? '  · ' + x : '')); if (!ok) problems.push(l + ' ' + x); };

await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
await send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
await send('Page.navigate', { url: BASE });
await sleep(4200);                                     // intro must not cover the gate click
check('gate is open when auth is on', await evaluate(`document.querySelector('#gate').classList.contains('open')`));
check('dashboard still hidden behind the gate', await evaluate(`document.querySelector('#v-dash').hidden`));
await shot('20-gate');

await evaluate(`document.querySelector('#gate-tok').value='wrong-key'`);
await evaluate(`document.querySelector('#gate-form').requestSubmit()`);
await sleep(1500);
check('wrong key shows an error', await evaluate(`document.querySelector('#gate-err').classList.contains('show')`));
check('gate stays open', await evaluate(`document.querySelector('#gate').classList.contains('open')`));
check('mimi looks sad about it', await evaluate(`document.querySelector('#gate-mimi .mimi').dataset.mood`) === 'sad');
check('shake fired', await evaluate(`document.querySelector('#gate').classList.contains('shake')`));
await shot('21-gate-error');
check('nothing leaked into storage', await evaluate(`!sessionStorage.getItem('minimem_token') && !localStorage.getItem('minimem_token')`));

await evaluate(`document.querySelector('#gate-tok').value='testtoken'`);
await evaluate(`document.querySelector('#gate-keep').checked=true;document.querySelector('#gate-keep').dispatchEvent(new Event('change'))`);
await evaluate(`document.querySelector('#gate-form').requestSubmit()`);
await sleep(2200);
check('correct key closes the gate', !(await evaluate(`document.querySelector('#gate').classList.contains('open')`)));
check('dashboard rendered after unlock', !(await evaluate(`document.querySelector('#v-dash').hidden`)));
check('remember-me wrote localStorage', !!(await evaluate(`localStorage.getItem('minimem_token')`)));
check('sessionStorage left alone', !(await evaluate(`sessionStorage.getItem('minimem_token')`)));
check('live count loaded behind auth', (await evaluate(`document.querySelector('#c-recent').textContent`)) === '2', await evaluate(`document.querySelector('#c-recent').textContent`));
await shot('22-unlocked');

await send('Page.navigate', { url: BASE });
await sleep(1500);
check('token survives a reload', !(await evaluate(`document.querySelector('#gate').classList.contains('open')`)));

// expired/rotated token: a 401 from any call must reopen the gate
await evaluate(`localStorage.setItem('minimem_token','stale-token')`);
await send('Page.navigate', { url: BASE });
await sleep(1600);
check('stale token reopens the gate', await evaluate(`document.querySelector('#gate').classList.contains('open')`));
check('token field cleared for a fresh entry', (await evaluate(`document.querySelector('#gate-tok').value`)) === '');
check('forget button offered (token on disk)', await evaluate(`!document.querySelector('#gate-forget').hidden`));

await evaluate(`document.querySelector('#gate-forget').click()`);
await sleep(400);
check('forget wipes both stores', await evaluate(`!localStorage.getItem('minimem_token') && !sessionStorage.getItem('minimem_token')`));
await shot('23-gate-forget');

/* a rejected request is supposed to log a 401 — that is the flow under test,
   so only an unplanned error counts as a failure here */
const errs = events.filter(e => e.method === 'Runtime.exceptionThrown'
  || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error' && e.params.entry.source !== 'network'));
check('no unexpected JS errors during the gate flow', errs.length === 0, errs.map(e => JSON.stringify(e.params).slice(0, 140)).join(' | '));
console.log('\n' + (problems.length ? 'PROBLEMS:\n - ' + problems.join('\n - ') : 'ALL GATE CHECKS PASSED'));
ws.close(); process.exit(problems.length ? 1 : 0);
