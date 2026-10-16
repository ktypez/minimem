// the auth-on header is the crowded one (logo + chip + token + day): check it wraps
// without hiding a control, at the two narrowest widths we care about.
const sleep = ms => new Promise(r => setTimeout(r, ms));
const CDP = +(process.env.CDP_PORT || 9222);
const BASE = process.env.UI_URL || 'http://127.0.0.1:3312/';
const OUT = (process.env.UI_OUT || '/tmp/minimem-uicheck').replace(/\/?$/, '/');
const tgt = await (await fetch(`http://127.0.0.1:${CDP}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(tgt.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pend = new Map();
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description); return r.result.value; };
const shot = async n => { const r = await send('Page.captureScreenshot', { format: 'png' }); (await import('node:fs')).writeFileSync(OUT + n + '.png', Buffer.from(r.data, 'base64')); };
await send('Runtime.enable'); await send('Page.enable');
await send('Storage.clearDataForOrigin', { origin: new URL(BASE).origin, storageTypes: 'all' });
let bad = 0;
for (const [w, h, tag] of [[390, 844, 'iphone'], [320, 640, 'small']]) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.navigate', { url: BASE });
  await sleep(4200);
  await ev(`localStorage.setItem('minimem_token','testtoken')`);
  await send('Page.navigate', { url: BASE });
  await sleep(4200);
  const s = await ev(`(()=>{const r=e=>{const b=e.getBoundingClientRect();return {r:Math.round(b.right),b:Math.round(b.bottom),h:Math.round(b.height),vis:b.width>0}};
    const items=[...document.querySelectorAll('.top .chip-st,.top .ia,.logo')];
    return {vw:innerWidth,vh:innerHeight,over:items.filter(e=>{const b=e.getBoundingClientRect();return b.width>0&&(b.right>innerWidth+0.5||b.bottom>innerHeight)}).map(e=>e.id||e.className),
      token:r(document.querySelector('#open-token')),day:r(document.querySelector('#theme')),chip:r(document.querySelector('.chip-st')),
      gate:document.querySelector('#gate').classList.contains('open'),locked:document.body.className}})()`);
  const ok = s.over.length === 0 && !s.gate && !s.locked;
  if (!ok) bad++;
  console.log((ok ? 'PASS ' : 'FAIL ') + `auth-on header @${w}: ` + JSON.stringify(s));
  await shot('26-mobile-header-auth-' + tag);
}
await send('Emulation.setTouchEmulationEnabled', { enabled: false });
await send('Emulation.clearDeviceMetricsOverride');
ws.close(); process.exit(bad ? 1 : 0);
