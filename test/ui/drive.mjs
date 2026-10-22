// Headless drive of the new minimem UI over CDP (no npm deps: node ≥22 WebSocket).
// Run `sh reset.sh` first, every time: the suite mutates the store (it acks the
// handoff, trashes a memory, posts lessons), so counts only line up on a fresh seed.
// Config comes from the environment so run.sh can drive two instances at once:
//   CDP_PORT (9222) · UI_URL (the instance under test, → BASE) · UI_OUT (artefacts)
const CDP = +(process.env.CDP_PORT || 9222);
const BASE = process.env.UI_URL || 'http://127.0.0.1:3311/';
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

const problems = [];
await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable'); await send('Network.enable');
/* fresh box: a previous run's theme + token must not decide this one's outcome */
await send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });

async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('EVAL: ' + expr.slice(0, 70) + ' → ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}
const shot = async name => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const fs = await import('node:fs');
  fs.writeFileSync(OUT + name + '.png', Buffer.from(r.data, 'base64'));
};
const check = (label, ok, extra = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra ? '  · ' + extra : '')); if (!ok) problems.push(label + ' ' + extra); };

await send('Page.navigate', { url: BASE });
await sleep(1500);
await shot('01-intro');
await sleep(3200);                       // intro auto-dismisses at 2.4s + iris wipe

/* ── dashboard ── */
check('dashboard visible', await evaluate(`!document.querySelector('#v-dash').hidden`));
check('4 memory stat tiles', await evaluate(`document.querySelectorAll('#stats-mem .stat').length`) === 4);
check('5 relay stat tiles', await evaluate(`document.querySelectorAll('#stats-relay .stat').length`) === 5);
check('hero greeted', (await evaluate(`document.querySelector('#hero-say').textContent.trim().length`)) > 10);
check('nav counts filled', await evaluate(`document.querySelector('#c-recent').textContent`) === '4', await evaluate(`document.querySelector('#c-recent').textContent`));
check('mimi mounted', await evaluate(`!!document.querySelector('#hero-mimi .mimi .m-body')`));
check('no horizontal overflow @1280', await evaluate(`document.documentElement.scrollWidth <= window.innerWidth + 1`));
await shot('02-dash-day');

/* ── theme toggle ── */
await evaluate(`document.querySelector('#theme').click()`);
await sleep(400);
check('theme switched to night', await evaluate(`document.documentElement.dataset.theme`) === 'night');
check('theme label + icon follow', await evaluate(`document.querySelector('#theme span').textContent`) === 'night');
await shot('03-dash-night');
await evaluate(`document.querySelector('#theme').click()`);
await sleep(300);

/* ── recent list + search + history ── */
await evaluate(`document.querySelector('.nav button[data-mode=recent]').click()`);
await sleep(700);
check('recent list rendered', await evaluate(`document.querySelectorAll('#cards .card').length`) === 4);
check('card actions visible on hover-capable', await evaluate(`getComputedStyle(document.querySelector('#cards .card .acts')).opacity==='1'`));
await shot('04-recent');
await evaluate(`document.querySelector('#cards .card [data-act=hist]').click()`);
await sleep(700);
check('history box opened', await evaluate(`!!document.querySelector('#cards .histbox')`));
await shot('05-history');
await evaluate(`(()=>{const q=document.querySelector('#q');q.value='thai';q.dispatchEvent(new Event('input',{bubbles:true}))})()`);
await sleep(1200);
check('search ran + highlighted', await evaluate(`document.querySelectorAll('#cards .card mark').length`) > 0);
check('search heading', (await evaluate(`document.querySelector('#h-title').textContent`)) === 'Recall');
await shot('06-recall');
await evaluate(`(()=>{const q=document.querySelector('#q');q.value='';q.dispatchEvent(new Event('input',{bubbles:true}))})()`);
await sleep(900);

/* ── tags view ── */
await evaluate(`document.querySelector('.nav button[data-mode=tags]').click()`);
await sleep(900);
check('tag bubbles rendered', await evaluate(`document.querySelectorAll('#tagfield .gem').length`) > 5,
  await evaluate(`document.querySelectorAll('#tagfield .gem').length + ' gems'`));
await shot('07-tags');

/* ── relay: handoff read + ack + write ── */
await evaluate(`document.querySelector('.nav button[data-mode=relay]').click()`);
await sleep(800);
check('relay pane shown', await evaluate(`!document.querySelector('#v-relay').hidden`));
check('search row hidden in relay', await evaluate(`getComputedStyle(document.querySelector('.searchrow')).display`) === 'none');
await evaluate(`document.querySelector('#ho-agent').value='crush'`);
await evaluate(`document.querySelector('#ho-load').click()`);
await sleep(900);
check('handoff listed for crush', await evaluate(`document.querySelectorAll('#ho-list .rcard').length`) === 1);
check('ack button present', await evaluate(`!!document.querySelector('#ho-list [data-ack]')`));
await evaluate(`document.querySelector('#ho-list [data-ack]').click()`);
await sleep(1000);
check('handoff acked', await evaluate(`fetch('/handoff?agent=crush&all=1').then(r=>r.json()).then(j=>!!j.items[0].acked_at)`));
check('acked row leaves the unacked list', await evaluate(`document.querySelector('#ho-list .rnone') !== null`));

await evaluate(`document.querySelector('#rp-handoff details.newbox').open=true`);
await sleep(300);
await evaluate(`(()=>{document.querySelector('#ho-from').value='opencode';document.querySelector('#ho-to').value='pig';
  document.querySelector('#ho-topic').value='ui redesign';document.querySelector('#ho-body').value='รีสตาร์ท service หลังเปลี่ยน index.html';})()`);
await shot('08-relay-handoff-form');
await evaluate(`document.querySelector('#ho-send').click()`);
await sleep(1200);
const pig = await (await fetch(BASE + 'handoff?agent=pig')).json();
check('handoff created via form', pig.items.length === 1 && pig.items[0].topic === 'ui redesign', JSON.stringify(pig.items[0] || {}).slice(0, 90));
check('toast confirms it', await evaluate(`document.querySelector('#toast').classList.contains('show')`));
check('agent filter kept for the reader', await evaluate(`document.querySelector('#ho-agent').value`) === 'crush');

/* ── relay: leases ── */
await evaluate(`document.querySelector('.rtab[data-r=leases]').click()`);
await sleep(900);
check('lease listed', (await evaluate(`document.querySelectorAll('#ls-list .rcard').length`)) >= 1);
await evaluate(`document.querySelector('#ls-name').value='tmp-lock';document.querySelector('#ls-holder').value='opencode'`);
await evaluate(`document.querySelector('#ls-load').click()`);
await sleep(1100);
check('lease acquired via form', (await evaluate(`document.querySelectorAll('#ls-list .rcard').length`)) >= 2);
await evaluate(`document.querySelector('#ls-list [data-rel]').click()`);
await sleep(400);
check('release asks to confirm', await evaluate(`document.querySelector('#cfrim').classList.contains('open')`));
await evaluate(`document.querySelector('#cf-ok').click()`);
await sleep(1100);
check('lease released', (await evaluate(`document.querySelectorAll('#ls-list .rcard').length`)) === 1);

/* ── relay: lessons + crystals write ── */
await evaluate(`document.querySelector('.rtab[data-r=lessons]').click()`);
await sleep(800);
await evaluate(`document.querySelector('#rp-lessons details.newbox').open=true`);
await evaluate(`document.querySelector('#ln-new').value='never ship a .newbox without a keyboard-Enter path';document.querySelector('#ln-new-scope').value='minimem'`);
await evaluate(`document.querySelector('#ln-save').click()`);
await sleep(1200);
const lessons = await (await fetch(BASE + 'lessons?limit=10')).json();
check('lesson created via form', lessons.items.some(x => x.scope === 'minimem' && /keyboard-Enter/.test(x.text)), lessons.items.length + ' lessons');
check('lesson list refreshed', (await evaluate(`document.querySelectorAll('#ln-list .rcard').length`)) >= 2);
await shot('09-relay-lessons');

await evaluate(`document.querySelector('.rtab[data-r=crystals]').click()`);
await sleep(800);
await evaluate(`document.querySelector('#rp-crystals details.newbox').open=true`);
await evaluate(`document.querySelector('#cr-new').value='guild hall: sticker UI + mascot + relay writes';document.querySelector('#cr-sources').value='1,2'`);
await evaluate(`document.querySelector('#cr-save').click()`);
await sleep(1200);
const crys = await (await fetch(BASE + 'crystals?limit=10')).json();
check('crystal created via form', crys.items.some(x => /guild hall/.test(x.text)), crys.items.length + ' crystals');
check('crystal source links render', (await evaluate(`document.querySelectorAll('#cr-list .refs a').length`)) >= 2);
await shot('10-relay-crystals');

await evaluate(`document.querySelector('.rtab[data-r=audit]').click()`);
await sleep(800);
check('audit rows render', (await evaluate(`document.querySelectorAll('#au-list .rcard').length`)) > 3);
await shot('11-relay-audit');

/* ── add + extract modal ── */
await evaluate(`document.querySelector('.nav button[data-mode=add]').click()`);
await sleep(500);
check('capture sheet opens', await evaluate(`document.querySelector('#scrim').classList.contains('open')`));
await evaluate(`document.querySelector('#add-tags').value='uitest, thai'`);
await evaluate(`document.querySelector('#add-text').value='เช็กว่าการ์ดใหม่ที่เพิ่งจดผ่านหน้าเว็บขึ้นในลิสต์จริง'`);
await shot('12-add-sheet');
await evaluate(`document.querySelector('#add-save').click()`);
await sleep(1500);
check('memory stored from sheet', await evaluate(`document.querySelector('#toast').textContent.includes('#5')`));
check('sheet closed after save', !(await evaluate(`document.querySelector('#scrim').classList.contains('open')`)));

/* ── trash: soft delete + restore ── */
await evaluate(`document.querySelector('.nav button[data-mode=trash]').click()`);
await sleep(800);
check('trash empty state', (await evaluate(`document.querySelector('#cards .empty')?.textContent||''`)).length > 0);
await evaluate(`document.querySelector('.nav button[data-mode=recent]').click()`);
await sleep(800);
await evaluate(`document.querySelector('#cards .card [data-act=del]').click()`);
await sleep(400);
check('delete asks to confirm', await evaluate(`document.querySelector('#cfrim').classList.contains('open')`));
await shot('13-confirm-delete');
await evaluate(`document.querySelector('#cf-ok').click()`);
await sleep(1400);
check('memory moved to trash', (await evaluate(`document.querySelector('#c-trash').textContent`)) === '1');
await evaluate(`document.querySelector('.nav button[data-mode=trash]').click()`);
await sleep(900);
check('trash lists the memory', (await evaluate(`document.querySelectorAll('#cards .card').length`)) === 1);
check('trash card offers purge + restore', await evaluate(`!!document.querySelector('#cards [data-act=purge]')&&!!document.querySelector('#cards [data-act=restore]')`));
await evaluate(`document.querySelector('#cards [data-act=restore]').click()`);
await sleep(1300);
check('restored from trash', (await evaluate(`document.querySelector('#c-trash').textContent`)) === '0');

/* ── mobile: adaptive layout ── */
for (const [w, h, tag] of [[390, 844, 'iphone'], [320, 640, 'small'], [844, 390, 'landscape']]) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await evaluate(`document.querySelector('.nav button[data-mode=dashboard]').click()`);
  await sleep(900);
  const ov = await evaluate(`document.documentElement.scrollWidth - window.innerWidth`);
  check(`no h-overflow @${w}x${h} (${tag})`, ov <= 1, 'overflow ' + ov + 'px');
  if (tag === 'iphone') {
    await shot('14-mobile-dash');
    check('placeholder shortened on phones', (await evaluate(`document.querySelector('#q').placeholder`)) === 'recall: ไทย & English');
    check('status text kept for screen readers', (await evaluate(`document.querySelector('.chip-st span:last-child').textContent.length`)) > 3
      && (await evaluate(`document.querySelector('.chip-st span:last-child').getBoundingClientRect().width`)) < 3);
    /* every header control must be inside the viewport — an overflowed button
       is an invisible button, and the header is the only way to the token gate */
    const off = await evaluate(`[...document.querySelectorAll('.top .ia,.top .chip-st,.logo')]
      .filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&(r.right>innerWidth+0.5||r.left<-0.5||r.bottom>innerHeight)}).map(e=>e.id||e.className)`);
    check('no header control overflows the phone width', off.length === 0, JSON.stringify(off));
    /* the control cluster must not clip its own children: an overflowed button
       is an invisible button. (the header is one row on a phone) */
    check('the header controls are not clipped by the cluster', await evaluate(`(()=>{
      const c=document.querySelector('.top-r').getBoundingClientRect();
      return [...document.querySelectorAll('.top-r > *')].every(e=>{const b=e.getBoundingClientRect();
        return b.width===0 || (b.right<=c.right+0.5 && b.left>=c.left-0.5 && b.bottom<=c.bottom+0.5)});})()`));
    check('the header is one row on a phone', await evaluate(`(()=>{
      const l=document.querySelector('.logo').getBoundingClientRect();
      const t=document.querySelector('.top-r').getBoundingClientRect();
      const cl=l.top+l.height/2, ct=t.top+t.height/2;
      return Math.abs(cl-ct)<2 && t.right<=innerWidth+0.5;})()`));
    check('graph paper painted by the fixed world layer (no iOS fixed-bg jank)', await evaluate(`getComputedStyle(document.querySelector('.world')).backgroundImage`).then(v => /linear-gradient/.test(v)));
    /* the ticker moves by transform, not by re-laying out the strip every frame */
    check('ticker scrolls by transform', await evaluate(`(()=>{const cs=getComputedStyle(document.querySelector('.ticker .track'));
      return cs.animationName!=='none' && parseFloat(cs.animationDuration)>0})()`));
    check('inputs are ≥16px (no iOS focus zoom)', await evaluate(`[...document.querySelectorAll('#ls-name,#ls-holder,#add-tags,#tag-q,#ln-new,#cr-sources,#ho-from')]
      .every(e=>parseFloat(getComputedStyle(e).fontSize)>=16)`),
      await evaluate(`[...document.querySelectorAll('#ls-name,#add-tags,#tag-q')].map(e=>getComputedStyle(e).fontSize).join(',')`));
    /* measure the targets where they are actually visible */
    await evaluate(`document.querySelector('.nav button[data-mode=recent]').click()`);
    await sleep(900);
    const taps = await evaluate(`(()=>{const h=s=>{const a=[...document.querySelectorAll(s)].map(e=>e.getBoundingClientRect().height).filter(v=>v>0);
      return a.length?Math.round(Math.min(...a)):null};
      return {headerButton:h('.top .ia'),navPill:h('.nav button'),cardTag:h('#cards .tags .chip'),cardAction:h('#cards .acts .ia'),headClear:h('.head .sub')}})()`);
    check('tap targets ≥44px on touch', Object.entries(taps).filter(([k]) => k !== 'headClear').every(([, v]) => v === null ? true : v >= 44), JSON.stringify(taps));
    await evaluate(`document.querySelector('.nav button[data-mode=tags]').click()`);
    await sleep(900);
    check('gem floor raised on touch', (await evaluate(`(()=>{const g=[...document.querySelectorAll('#tagfield .gem')].map(e=>e.getBoundingClientRect().height);
      return g.length?Math.round(Math.min(...g)):99})()`)) >= 44,
      await evaluate(`String(Math.round(Math.min(...[...document.querySelectorAll('#tagfield .gem')].map(e=>e.getBoundingClientRect().height))))`));
    await shot('25-mobile-tags');
  }
  if (tag === 'small') await shot('15-mobile-320-dash');
  await evaluate(`document.querySelector('.nav button[data-mode=relay]').click()`);
  await sleep(900);
  await evaluate(`document.querySelector('#rp-handoff details.newbox').open=true`);
  await sleep(300);
  const ov2 = await evaluate(`document.documentElement.scrollWidth - window.innerWidth`);
  check(`relay fits @${w} (${tag})`, ov2 <= 1, 'overflow ' + ov2 + 'px');
  if (tag === 'iphone') await shot('16-mobile-relay');
  if (tag === 'landscape') await shot('17-landscape-relay');
  if (tag === 'iphone') {
    /* wheel input, not scrollBy: programmatic scrolling ignores the lock by design */
    const wheel = async (y, delta, n = 3) => {
      for (let i = 0; i < n; i++) { await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 195, y, deltaX: 0, deltaY: delta }); await sleep(120); }
      await sleep(350);
      return evaluate(`scrollY`);
    };
    /* the sheet slides in with a bounce, so geometry is only final once it lands */
    const settle = async () => {
      await evaluate(`Promise.all(document.getAnimations()
        .filter(a=>{const t=a.effect&&a.effect.getTiming();return !t||t.iterations!==Infinity})
        .map(a=>a.finished.catch(()=>{})))`);
      await sleep(150);
    };
    await evaluate(`scrollTo(0,0)`);
    const controlScroll = await wheel(600, 300);
    check('page scrolls normally when no dialog is open', controlScroll > 50, 'wheel moved to ' + controlScroll);
    await evaluate(`scrollTo(0,0)`);
    /* the dialog should be a bottom sheet, and the page behind it must hold still */
    await evaluate(`document.querySelector('.nav button[data-mode=add]').click()`);
    await sleep(600);
    await settle();
    const sheet = await evaluate(`(()=>{const r=document.querySelector('#scrim .sheet').getBoundingClientRect();
      return {bottom:Math.round(r.bottom),vh:innerHeight,w:Math.round(r.width),vw:innerWidth,radius:getComputedStyle(document.querySelector('#scrim .sheet')).borderTopLeftRadius}})()`);
    check('sheet docks to the bottom edge', Math.abs(sheet.bottom - sheet.vh) <= 2, JSON.stringify(sheet));
    check('sheet spans the full width', sheet.w === sheet.vw, JSON.stringify(sheet));
    check('sheet has a grab bar', await evaluate(`getComputedStyle(document.querySelector('#scrim .sheet>header'),'::before').width`) !== 'auto');
    check('page is scroll-locked behind the sheet', await evaluate(`document.body.classList.contains('lock')`));
    const held = await wheel(300, 300);
    check('background cannot scroll while open', held < 5, 'wheel moved the page behind the sheet to ' + held);
    check('the page is locked at the html root', await evaluate(`getComputedStyle(document.documentElement).overflow`) === 'hidden'
      && await evaluate(`document.documentElement.classList.contains('lock')`));
    await shot('24-mobile-sheet');
    /* the sheet itself must still scroll, or the lock would freeze the UI */
    await evaluate(`document.querySelector('.tabs button[data-pane=extract]').click()`);
    await sleep(300);
    await evaluate(`document.querySelector('#ex-text').style.minHeight='1200px'`);
    await sleep(300);
    const paneBefore = await evaluate(`document.querySelector('#scrim .pane.active').scrollTop`);
    await wheel(300, 300, 4);
    const paneAfter = await evaluate(`document.querySelector('#scrim .pane.active').scrollTop`);
    check('the sheet pane still scrolls under the lock', paneAfter > paneBefore, paneBefore + ' → ' + paneAfter);
    check('page stayed put while the pane scrolled', (await evaluate(`scrollY`)) < 5);
    await evaluate(`document.querySelector('.tabs button[data-pane=add]').click()`);
    await evaluate(`document.querySelector('#sheet-close').click()`);
    await sleep(400);
    check('lock released when the sheet closes', !(await evaluate(`document.body.classList.contains('lock')`)));
  }
  await evaluate(`document.querySelector('.nav button[data-mode=recent]').click()`);
  await sleep(800);
  if (tag === 'iphone') await shot('18-mobile-recent');
}
await send('Emulation.setTouchEmulationEnabled', { enabled: false });
await send('Emulation.clearDeviceMetricsOverride');
await evaluate(`document.querySelector('.nav button[data-mode=dashboard]').click()`);
await sleep(700);
await shot('19-dash-final');

/* ── console hygiene ── */
const errs = events.filter(e =>
  (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') ||
  e.method === 'Runtime.exceptionThrown');
const netFail = events.filter(e => e.method === 'Network.loadingFailed' && !/fonts\.g|preconnect/.test(e.params.errorText || '')); // fonts may be offline in the sandbox
check('no JS errors / exceptions', errs.length === 0, errs.map(e => JSON.stringify(e.params).slice(0, 160)).join(' | '));
console.log('network failures:', netFail.length, netFail.slice(0, 3).map(e => e.params.errorText + ' ' + (e.params.blockedReason || '')).join(', '));

console.log('\n' + (problems.length ? 'PROBLEMS:\n - ' + problems.join('\n - ') : 'ALL CHECKS PASSED'));
ws.close(); process.exit(problems.length ? 1 : 0);
