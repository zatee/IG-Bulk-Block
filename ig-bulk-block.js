// Instagram Bulk Block – browser console script (v2)
// Reads an Instagram data export (followers_*.json / following.json)
// and blocks the listed accounts, with delays to avoid action blocks.
// Progress is stored in localStorage, so re-running the script resumes where it stopped.
(() => {
  if (window.__igBulkBlock) { alert('IG Bulk Block is already running in this tab.'); return; }
  window.__igBulkBlock = true;

  // ===== Settings =====
  const CONFIG = {
    delayMinSec: 25,     // delay between blocks (min)
    delayMaxSec: 45,     // delay between blocks (max)
    batchSize: 25,       // after this many blocks ...
    batchPauseMin: 15,   // ... pause for this many minutes
    maxPerRun: 150,      // max blocks per run (run again the next day)
    maxConsecutiveErrors: 3, // stop after this many errors in a row
  };
  const STORAGE_KEY = 'igBulkBlock_v2';
  const APP_ID = '936619743392459'; // public web app ID of instagram.com

  // ===== Helpers =====
  class RateLimit extends Error {}
  let stopFlag = false, running = false;

  const rand = (a, b) => a + Math.random() * (b - a);
  const sleep = async (sec) => {
    const end = Date.now() + sec * 1000;
    while (Date.now() < end) {
      if (stopFlag) return;
      await new Promise(r => setTimeout(r, 1000));
    }
  };
  const getCookie = (n) =>
    document.cookie.split('; ').find(c => c.startsWith(n + '='))?.split('=')[1];
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const loadState = () => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || { done: [], skipped: {}, failed: {} }; }
    catch { return { done: [], skipped: {}, failed: {} }; }
  };
  const saveState = (s) => localStorage.setItem(STORAGE_KEY, JSON.stringify(s));

  const headers = () => ({
    'X-CSRFToken': getCookie('csrftoken') || '',
    'X-IG-App-ID': APP_ID,
    'X-IG-WWW-Claim': sessionStorage.getItem('www-claim-v2') || '0',
    'X-Requested-With': 'XMLHttpRequest',
  });

  const readJson = async (r) => {
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('json')) return null;
    try { return await r.json(); } catch { return null; }
  };

  const isRateLimit = (r, j) =>
    r.status === 429 || j?.spam || j?.feedback_required ||
    /wait|feedback|try again later/i.test(j?.message || '');

  // ===== Parse the JSON export =====
  const usernameFromHref = (href) =>
    (href.match(/instagram\.com\/(?:_u\/)?([A-Za-z0-9._]+)/) || [])[1] || '';

  function extractUsernames(json) {
    const out = new Set();
    const walk = (node) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node.string_list_data)) {
        for (const s of node.string_list_data) {
          const u = (s.value || node.title || usernameFromHref(s.href || '')).trim().toLowerCase();
          if (/^[a-z0-9._]{1,30}$/.test(u)) out.add(u);
        }
        return;
      }
      Object.values(node).forEach(walk);
    };
    walk(json);
    return [...out];
  }

  // ===== Resolve user ID (3 methods with fallback) =====
  const METHODS = {
    async profile_info(u) {
      const r = await fetch(`/api/v1/users/web_profile_info/?username=${encodeURIComponent(u)}`,
        { headers: headers(), credentials: 'include' });
      const j = await readJson(r);
      if (isRateLimit(r, j)) throw new RateLimit(j?.message || `HTTP ${r.status}`);
      return { id: j?.data?.user?.id, status: r.status };
    },
    async topsearch(u) {
      const r = await fetch(`/api/v1/web/search/topsearch/?context=blended&include_reel=false&query=${encodeURIComponent(u)}`,
        { headers: headers(), credentials: 'include' });
      const j = await readJson(r);
      if (isRateLimit(r, j)) throw new RateLimit(j?.message || `HTTP ${r.status}`);
      const hit = (j?.users || []).map(x => x.user || x)
        .find(x => x?.username?.toLowerCase() === u);
      return { id: hit?.pk || hit?.pk_id || hit?.id, status: r.status };
    },
    async profile_html(u) {
      const r = await fetch(`/${encodeURIComponent(u)}/`, { credentials: 'include' });
      if (r.status === 429) throw new RateLimit('HTTP 429 on profile page');
      const html = await r.text();
      const e = esc(u);
      const patterns = [
        /"profilePage_(\d+)"/,
        new RegExp(`"(?:pk|id|pk_id)":"?(\\d+)"?,"username":"${e}"`, 'i'),
        new RegExp(`"username":"${e}"[^{}]{0,300}?"(?:pk|id|pk_id)":"?(\\d+)"?`, 'i'),
        /"profile_id":"(\d+)"/,
      ];
      for (const p of patterns) {
        const m = html.match(p);
        if (m) return { id: m[1], status: r.status };
      }
      return { id: null, status: r.status };
    },
  };
  let order = ['topsearch', 'profile_html', 'profile_info'];
  let lookupWorked = false;

  async function lookupId(u) {
    const notes = [];
    let htmlStatus = null;
    for (const name of order) {
      try {
        const { id, status } = await METHODS[name](u);
        if (name === 'profile_html') htmlStatus = status;
        if (id) {
          if (order[0] !== name) {               // try the working method first from now on
            order = [name, ...order.filter(n => n !== name)];
            log(`ID lookup now uses: ${name}`, '#6cf');
          }
          lookupWorked = true;
          return { id: String(id) };
        }
        notes.push(`${name}:${status}`);
      } catch (e) {
        if (e instanceof RateLimit) throw e;
        notes.push(`${name}:${e.message}`);
      }
      await sleep(rand(1, 3));
    }
    // Only treat as "not found" if lookups have proven to work in this run
    // and the profile page itself returns 404.
    if (lookupWorked && htmlStatus === 404) return { notFound: true };
    throw new Error('Could not resolve ID (' + notes.join(', ') + ')');
  }

  // ===== Block =====
  async function blockUser(id) {
    const attempts = [
      [`/api/v1/web/friendships/${id}/block/`, ''],
      [`/web/friendships/${id}/block/`, ''],
      [`/api/v1/friendships/block/${id}/`, new URLSearchParams({ user_id: id, surface: 'profile' }).toString()],
    ];
    const notes = [];
    for (const [url, body] of attempts) {
      const r = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: { ...headers(), 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      const j = await readJson(r);
      if (isRateLimit(r, j)) throw new RateLimit(j?.feedback_message || j?.message || `HTTP ${r.status}`);
      if (r.ok && j?.status === 'ok') {
        if (attempts[0][0] !== url) attempts.unshift(attempts.splice(attempts.findIndex(a => a[0] === url), 1)[0]);
        return;
      }
      notes.push(`${url.replace(id, '{id}')} → ${r.status}${j?.message ? ' ' + j.message : ''}`);
      if (![404, 405].includes(r.status) && j) break;
    }
    throw new Error('Block failed: ' + notes.join(' | '));
  }

  // ===== UI panel =====
  const panel = document.createElement('div');
  panel.style.cssText = `position:fixed;bottom:16px;right:16px;z-index:999999;width:400px;
    background:#111;color:#eee;font:12px/1.4 -apple-system,system-ui,sans-serif;
    border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.4);padding:12px;`;
  panel.innerHTML = `
    <div style="font-weight:600;font-size:14px;margin-bottom:8px">IG Bulk Block v2</div>
    <input type="file" accept=".json,application/json" id="igbb-file" style="width:100%;margin-bottom:8px">
    <div id="igbb-info" style="margin-bottom:8px;color:#aaa">Choose a JSON file from your export.</div>
    <div style="display:flex;gap:6px;margin-bottom:8px">
      <button id="igbb-start" disabled style="flex:1;padding:6px;border:0;border-radius:6px;background:#0095f6;color:#fff;cursor:pointer">Start</button>
      <button id="igbb-stop" style="flex:1;padding:6px;border:0;border-radius:6px;background:#444;color:#fff;cursor:pointer">Stop</button>
      <button id="igbb-close" style="padding:6px 10px;border:0;border-radius:6px;background:#333;color:#fff;cursor:pointer">✕</button>
    </div>
    <div id="igbb-log" style="height:220px;overflow:auto;background:#000;border-radius:6px;padding:6px;font-family:ui-monospace,Menlo,monospace;font-size:11px"></div>`;
  document.body.appendChild(panel);

  const $ = (id) => panel.querySelector('#' + id);
  const log = (msg, color = '#ddd') => {
    const line = document.createElement('div');
    line.style.color = color;
    line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    $('igbb-log').appendChild(line);
    $('igbb-log').scrollTop = 1e9;
    console.log('[IGBB]', msg);
  };

  let usernames = [];

  $('igbb-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      usernames = extractUsernames(JSON.parse(await file.text()));
      const s = loadState();
      const open = usernames.filter(u => !s.done.includes(u) && !(u in s.skipped));
      $('igbb-info').textContent =
        `${usernames.length} accounts found · ${usernames.length - open.length} already done · ${open.length} pending`;
      $('igbb-start').disabled = open.length === 0;
      log(`File loaded: ${file.name}`);
    } catch (err) {
      $('igbb-info').textContent = 'Error reading file: ' + err.message;
    }
  });

  $('igbb-stop').onclick = () => { stopFlag = true; log('Stop requested …', '#fc6'); };
  $('igbb-close').onclick = () => {
    if (running && !confirm('Still running. Close anyway?')) return;
    stopFlag = true; panel.remove(); window.__igBulkBlock = false;
  };
  $('igbb-start').onclick = () => { if (!running) run(); };

  // ===== Main loop =====
  async function run() {
    if (!getCookie('csrftoken')) { log('No csrftoken found – are you logged in?', '#f66'); return; }
    running = true; stopFlag = false;
    $('igbb-start').disabled = true;

    const state = loadState();
    const todo = usernames.filter(u => !state.done.includes(u) && !(u in state.skipped));
    log(`Starting: ${todo.length} pending, max ${CONFIG.maxPerRun} in this run.`, '#6cf');

    let blocked = 0, errorsInRow = 0, i = 0;
    for (const u of todo) {
      i++;
      if (stopFlag) break;
      if (blocked >= CONFIG.maxPerRun) { log('Per-run limit reached. Run again tomorrow.', '#fc6'); break; }

      try {
        const user = await lookupId(u);
        if (user.notFound) {
          state.skipped[u] = 'not found'; saveState(state);
          log(`– @${u}: profile no longer exists`, '#999');
          await sleep(rand(8, 15)); continue;
        }

        await sleep(rand(2, 5));
        if (stopFlag) break;
        await blockUser(user.id);

        state.done.push(u); delete state.failed[u]; saveState(state);
        blocked++; errorsInRow = 0;
        log(`✓ @${u} blocked (${blocked} this run, ${i}/${todo.length})`, '#6f6');
      } catch (err) {
        if (err instanceof RateLimit) {
          log(`⛔ Rate limit / action block: ${err.message}. Stopped – wait 24h, then run again.`, '#f66');
          break;
        }
        errorsInRow++;
        state.failed[u] = err.message; saveState(state);
        log(`✗ @${u}: ${err.message}`, '#f66');
        if (errorsInRow >= CONFIG.maxConsecutiveErrors) {
          log(`${errorsInRow} errors in a row – stopped. Check the log lines above.`, '#f66');
          break;
        }
      }

      if (blocked > 0 && blocked % CONFIG.batchSize === 0) {
        log(`Batch pause: ${CONFIG.batchPauseMin} min …`, '#fc6');
        await sleep(CONFIG.batchPauseMin * 60);
      } else {
        await sleep(rand(CONFIG.delayMinSec, CONFIG.delayMaxSec));
      }
    }

    const s = loadState();
    log(`Finished/stopped. Done: ${s.done.length}, skipped: ${Object.keys(s.skipped).length}, failed: ${Object.keys(s.failed).length}`, '#6cf');
    running = false;
    $('igbb-start').disabled = false;
  }

  log('Ready. To reset progress: localStorage.removeItem("' + STORAGE_KEY + '")', '#888');
})();
