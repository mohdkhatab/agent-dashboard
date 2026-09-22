/**
 * agent-dashboard server
 * -------------------------------------------------
 * - 4 "agents", har ek apna Playwright browser context (page)
 * - Har context apna proxy (different country IP) use kar sakta hai
 * - Auto-scroll + auto banner-click loop har agent par
 * - Har ~2.5s live screenshot -> Socket.IO se sabhi dashboard clients ko
 * - REST endpoints: dashboard buttons ke liye (scroll / click / reload / pause)
 */
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const { chromium } = require('playwright-core');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || config.chromiumPath || '/usr/bin/chromium';

/* ---------------- HTTP + Socket setup ---------------- */
const app = express();
app.use(express.json());

// Health & Uptime endpoints (useful for Render 24/7 pings / UptimeRobot)
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: Math.floor(process.uptime()), timestamp: Date.now() }));
app.get('/ping', (req, res) => res.send('pong'));

app.use(express.static(path.join(__dirname, 'public')));
app.use('/demo', express.static(path.join(__dirname, 'demo-site')));

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 8e6 });

const agents = new Map(); // id -> agent state

const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- Helpers ---------------- */
function parseProxy(proxyStr) {
  // Support:  http://user:pass@host:port | socks5://user:pass@host:port | host:port
  const p = { server: proxyStr };
  const m = proxyStr.match(/^(\w+):\/\/([^:@/]+):([^@/]+)@(.+)$/);
  if (m) {
    p.server = `${m[1]}://${m[4]}`;
    p.username = m[2];
    p.password = m[3];
  } else if (!/:\/\//.test(proxyStr)) {
    p.server = `http://${proxyStr}`;
  }
  return p;
}

function summary(agent) {
  return {
    id: agent.cfg.id,
    name: agent.cfg.name,
    url: agent.url,
    status: agent.status,
    ip: agent.ip,
    proxyLabel: (agent.currentProxy && agent.currentProxy.label) || agent.cfg.proxyLabel || 'Local (no proxy)',
    paused: !!agent.paused,
    running: agent.running,
    shots: agent.shots,
    clicks: agent.clicks,
    loads: agent.loads || 0,
    lastAction: agent.lastAction || '',
  };
}

function pushStatus() {
  const list = [];
  for (const a of agents.values()) list.push(summary(a));
  io.emit('status', list);
}

/* ---------------- Exit IP check (via page context => uses that agent's proxy) ---------------- */
async function getExitIp(page) {
  try {
    const info = await page.evaluate(async () => {
      try {
        const r = await fetch('https://ipinfo.io/json', { signal: AbortSignal.timeout(6000) });
        if (!r.ok) throw new Error('bad');
        const j = await r.json();
        return { ip: j.ip, country: j.country, city: j.city, org: j.org };
      } catch {
        const r2 = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(6000) });
        const j2 = await r2.json();
        return { ip: j2.ip, country: null, city: null, org: null };
      }
    });
    return info;
  } catch {
    return { ip: 'unknown', country: null, city: null, org: null };
  }
}

/* ---------------- postLoad steps (SPA tabs / example clicks) ---------------- */
async function runPostLoad(page, steps, agent) {
  for (const step of steps || []) {
    try {
      if (step.type === 'wait') {
        await sleep(step.ms || 2000);
      } else if (step.type === 'clickText') {
        await page.getByText(step.text, { exact: !!step.exact }).first().click({ timeout: step.timeout || 10000 });
        agent.lastAction = `Clicked text: ${step.text}`;
        await sleep(step.afterMs || 2500);
      } else if (step.type === 'clickSelector') {
        await page.locator(step.selector).first().click({ timeout: step.timeout || 10000 });
        agent.lastAction = `Clicked selector: ${step.selector}`;
        await sleep(step.afterMs || 2500);
      }
    } catch {}
  }
}

/* ---------------- Banner click (aggressive: har clickable + real input) ---------------- */
async function clickBanner(agent) {
  const page = agent.page;
  if (!page) return false;
  const cfg = agent.cfg;
  const before = page.url();
  // candidate dhundho: banner selectors + (optional) ANY button/link/clickable
  const target = await page
    .evaluate(
      ({ selectors, anyButton, skip }) => {
        const els = [];
        for (const s of selectors) els.push(...document.querySelectorAll(s));
        if (anyButton) {
          els.push(...document.querySelectorAll('button'));
          els.push(...document.querySelectorAll('a[href]'));
          els.push(...document.querySelectorAll('[role="button"]'));
          els.push(...document.querySelectorAll('[onclick]'));
        }
        const skipList = skip || [];
        const vis = els.filter((el) => {
          const href = (el.getAttribute && el.getAttribute('href')) || '';
          const cls = typeof el.className === 'string' ? el.className : '';
          const dl = el.getAttribute && el.getAttribute('download');
          if (dl) return false;
          for (const s of skipList) {
            if (s && (href === s || href.endsWith(s) || cls.includes(s))) return false;
          }
          const r = el.getBoundingClientRect();
          return r.width > 12 && r.height > 12 && r.top > -40 && r.bottom < innerHeight + 60 && r.left > -40 && r.right < innerWidth + 60;
        });
        if (!vis.length) return null;
        const el = vis[Math.floor(Math.random() * vis.length)];
        const iframe = el.querySelector && el.querySelector('iframe');
        // ad iframe/container -> andar random point (real click iframe ko bhi mile)
        const box = (iframe && iframe.getBoundingClientRect()) || el.getBoundingClientRect();
        const x = Math.max(2, box.left + Math.random() * Math.max(4, box.width));
        const y = Math.max(2, box.top + Math.random() * Math.max(4, box.height));
        return { x, y, cls: String(el.className || el.id || el.tagName).slice(0, 40), ad: !!iframe };
      },
      { selectors: cfg.clickSelectors, anyButton: !!cfg.clickAnyButton, skip: cfg.skipSelectors || [] }
    )
    .catch(() => null);

  if (!target) return false;
  try {
    // REAL mouse input click (human jaise) — iframe/ads ko bhi register hota hai
    await page.mouse.click(target.x, target.y);
  } catch {
    return false;
  }
  agent.clicks++;
  agent.lastAction = `Clicked ${target.ad ? '(ad iframe) ' : ''}${target.cls} @${Math.round(target.x)},${Math.round(target.y)}`;
  await sleep(rand(900, 1800));

  // Agar banner ka link alag origin par le gaya to wapas site par aao
  try {
    const after = page.url();
    const o1 = new URL(before).origin;
    const o2 = new URL(after).origin;
    if (o1 !== o2) {
      await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
    }
  } catch {}
  return true;
}

/* ---------------- Agent lifecycle (proxy pool + auto-reload) ---------------- */
function buildProxyPool(cfg) {
  const wrap = (p) => ({ url: p.url, label: p.label || 'proxy', fails: 0, skipUntil: 0 });
  let pool = [];
  if (cfg.proxies && cfg.proxies.length) pool = cfg.proxies.map((p) => (typeof p === 'string' ? wrap({ url: p }) : wrap(p)));
  else if (cfg.proxy) pool = [wrap({ url: cfg.proxy, label: cfg.proxyLabel })];
  // hamesha last me LOCAL fallback — proxies marti hain to clicks rukne na payen
  pool.push(null);
  return pool;
}

async function openContext(browser, cfg, proxy) {
  const ctxOpts = {
    viewport: cfg.viewport || { width: 800, height: 600 },
    locale: cfg.locale || 'en-US',
    timezoneId: cfg.timezoneId || 'Asia/Kolkata',
    // real browser UA — ad networks ko automation na lage
    userAgent:
      cfg.userAgent ||
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  };
  if (proxy && proxy.url) {
    ctxOpts.proxy = parseProxy(proxy.url);
  }
  const context = await browser.newContext(ctxOpts);
  // anti-detection: navigator.webdriver hide + chrome object
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    window.chrome = window.chrome || { runtime: {} };
  });
  const page = await context.newPage();
  return { context, page };
}

async function finishLoad(agent, context, page, old, current) {
  await page.goto(agent.cfg.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  agent.url = page.url();
  await runPostLoad(page, agent.cfg.postLoad, agent);
  agent.ip = await getExitIp(page);
  agent.loads = (agent.loads || 0) + 1;
  agent.status = 'ok';
  agent.lastAction = `Reload #${agent.loads} — ${(current && current.label) || 'Local'}`;
  if (current) current.fails = 0; // ye proxy theek hai
  pushStatus();
  if (old) old.close().catch(() => {});
}

async function loadAgentPage(browser, agent, proxy) {
  if (agent.loading) return false;
  agent.loading = true;
  const old = agent.context;
  const poolLen = agent.pool.length;
  const proxyCount = Math.max(0, poolLen - 1); // last entry = local fallback
  let current = proxy || agent.nextProxy();
  const maxProxyTries = Math.min(proxyCount, 5);
  let attempts = 0;
  while (attempts < maxProxyTries && current != null) {
    attempts++;
    try {
      const { context, page } = await openContext(browser, agent.cfg, current);
      agent.context = context;
      agent.page = page;
      agent.currentProxy = current;
      agent.status = 'loading…';
      pushStatus();
      await finishLoad(agent, context, page, old, current);
      agent.loading = false;
      return true;
    } catch (e) {
      // fail counts + cooldown (3 fails = 5 min skip)
      if (current) {
        current.fails = (current.fails || 0) + 1;
        if (current.fails >= 3) {
          current.skipUntil = Date.now() + 5 * 60 * 1000;
          current.fails = 0;
        }
      }
      // fail hua context band, purana zinda rakho
      const cur = agent.context;
      if (cur && cur !== old) cur.close().catch(() => {});
      agent.context = old;
      agent.page = old ? old.pages()[0] || null : null;
      current = agent.nextProxy(); // dead proxy skip -> agla try
      await sleep(500);
    }
  }
  // LOCAL FALLBACK — proxies sab fail ho gayi to clicks rukne na payen
  try {
    const { context, page } = await openContext(browser, agent.cfg, null);
    agent.context = context;
    agent.page = page;
    agent.currentProxy = null;
    agent.status = 'loading…';
    pushStatus();
    await finishLoad(agent, context, page, old, null);
    agent.loading = false;
    return true;
  } catch (e2) {
    agent.status = 'error: ' + String(e2.message).slice(0, 100);
    const cur = agent.context;
    if (cur && cur !== old) cur.close().catch(() => {});
    agent.context = old;
    agent.page = old ? old.pages()[0] || null : null;
    agent.loading = false;
    pushStatus();
    return false;
  }
}

async function startAgent(browser, cfg) {
  const pool = buildProxyPool(cfg);
  const agent = {
    cfg,
    pool,
    pIdx: rand(0, pool.length - 1),
    currentProxy: null,
    context: null,
    page: null,
    url: cfg.url,
    status: 'starting',
    ip: null,
    paused: false,
    running: true,
    loading: false,
    shots: 0,
    clicks: 0,
    loads: 0,
    lastClickAt: 0,
    lastAction: '',
    lastShot: null,
  };
  const nextProxy = () => {
    const now = Date.now();
    for (let i = 0; i < pool.length; i++) {
      agent.pIdx = (agent.pIdx + 1) % pool.length;
      const p = pool[agent.pIdx];
      if (!p || p.skipUntil <= now) return p; // cooled-down proxies skip
    }
    return pool[0]; // sab cooldown me -> pehla try
  };
  agent.nextProxy = nextProxy;

  agents.set(cfg.id, agent);
  pushStatus();

  // pehla load abhi
  loadAgentPage(browser, agent, nextProxy());

  // har reloadIntervalMs (default 15s) -> naya context = naya proxy = naya IP/country
  const reloadMs = cfg.reloadIntervalMs || 15000;
  const reloadTimer = setInterval(() => {
    if (!agent.running || agent.paused || agent.loading) return;
    loadAgentPage(browser, agent, agent.nextProxy());
  }, reloadMs);
  agent.reloadTimer = reloadTimer;

  // Live screenshot loop (only capture when clients are connected or for initial frame)
  const shotTimer = setInterval(async () => {
    if (!agent.running || agent.paused || !agent.page) return;
    if (io.engine && io.engine.clientsCount === 0 && agent.shots > 0) return;
    try {
      const buf = await agent.page.screenshot({ type: 'jpeg', quality: 50 });
      agent.lastShot = buf.toString('base64');
      agent.shots++;
      io.emit('shot', { id: cfg.id, data: agent.lastShot, ts: Date.now() });
    } catch {}
  }, config.screenshotIntervalMs || 3500);
  agent.shotTimer = shotTimer;

  // Automation loop (scroll + click) — smooth
  automationLoop(agent);
}

async function automationLoop(agent) {
  const cfg = agent.cfg;
  while (agent.running) {
    if (agent.paused || agent.status !== 'ok' || agent.loading || !agent.page) {
      await sleep(800);
      continue;
    }
    try {
      if (cfg.autoScroll && Math.random() < 0.85) {
        const delta = rand(250, 950) * (Math.random() < 0.8 ? 1 : -1);
        // smooth scroll — rAF-style, choppy nahi
        await agent.page.evaluate(
          (d) =>
            new Promise((res) => {
              const start = window.scrollY;
              const target = Math.max(0, start + d);
              const dur = 600;
              const t0 = performance.now();
              const step = (t) => {
                const p = Math.min(1, (t - t0) / dur);
                const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; // easeInOutQuad
                window.scrollTo(0, start + (target - start) * e);
                if (p < 1) requestAnimationFrame(step);
                else res();
              };
              requestAnimationFrame(step);
            }),
          delta
        );
        agent.lastAction = `Scrolled ${delta > 0 ? 'down' : 'up'} (${Math.abs(delta)}px)`;
        pushStatus();
        await sleep(rand(600, 1600));
      }
      if (cfg.autoClick) {
        // frequency gate — jitna fast chahiye utna fast clicks
        const now = Date.now();
        const freq = cfg.clickFrequencyMs || 2500;
        if (!agent.lastClickAt || now - agent.lastClickAt >= freq) {
          const did = await clickBanner(agent);
          if (did) {
            agent.lastClickAt = Date.now();
            pushStatus();
          }
          await sleep(rand(700, 1500));
        }
      }
      await sleep(rand(300, 900));
    } catch (e) {
      // page navigation in progress ya context swap ho gaya -> ignore
      await sleep(1000);
    }
  }
  clearInterval(agent.shotTimer);
  clearInterval(agent.reloadTimer);
  try { if (agent.context) await agent.context.close(); } catch {}
}

/* ---------------- REST API (dashboard buttons) ---------------- */
app.get('/api/agents', (_req, res) => {
  const list = [];
  for (const a of agents.values()) list.push(summary(a));
  res.json({ ok: true, agents: list });
});

app.post('/api/:id/:action', async (req, res) => {
  const a = agents.get(req.params.id);
  if (!a) return res.status(404).json({ ok: false, error: 'agent not found' });
  const { action } = req.params;
  const { dir, px } = req.body || {};
  try {
    switch (action) {
      case 'scroll': {
        const d = (dir === 'up' ? -1 : 1) * (px || 400);
        await a.page.evaluate((delta) => window.scrollBy({ top: delta, behavior: 'smooth' }), d);
        a.lastAction = `Manual scroll ${dir === 'up' ? 'up' : 'down'} (${Math.abs(d)}px)`;
        break;
      }
      case 'click': {
        const did = await clickBanner(a);
        if (!did) return res.json({ ok: false, message: 'koi visible banner nahi mila' });
        break;
      }
      case 'reload': {
        // manual reload = naya proxy + naya IP/country bhi
        await loadAgentPage(BROWSER_REF, a, a.nextProxy());
        a.lastAction = 'Manual reload (naya IP/country)';
        break;
      }
      case 'pause': {
        a.paused = !a.paused;
        a.lastAction = a.paused ? 'Paused (auto stopped)' : 'Resumed (auto chalu)';
        break;
      }
      case 'screenshot': {
        const buf = await a.page.screenshot({ type: 'jpeg', quality: 70 });
        return res.json({ ok: true, data: buf.toString('base64') });
      }
      default:
        return res.status(400).json({ ok: false, error: 'unknown action' });
    }
    pushStatus();
    res.json({ ok: true, agent: summary(a) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ---------------- Socket.IO ---------------- */
io.on('connection', (socket) => {
  // naye client ko turant last frames do
  for (const a of agents.values()) {
    if (a.lastShot) socket.emit('shot', { id: a.cfg.id, data: a.lastShot, ts: Date.now() });
  }
  pushStatus();
});

/* ---------------- Boot ---------------- */
let BROWSER_REF = null;

async function main() {
  const browser = await chromium.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-timer-throttling',
      '--disable-blink-features=AutomationControlled', // ad networks ko headless na dikhe
    ],
  });
  BROWSER_REF = browser;

  for (const ac of config.agents) startAgent(browser, ac);

  // In Render, PORT is provided (typically 10000); in AI Studio local sandbox, default to 3000
  const port = process.env.RENDER
    ? (process.env.PORT || 10000)
    : (process.env.PORT && process.env.PORT !== '8080' ? Number(process.env.PORT) : 3000);

  server.listen(port, '0.0.0.0', () => {
    console.log(`\n  ✅ Agent Dashboard: http://0.0.0.0:${port}`);
    console.log(`  💻 Chromium: ${CHROMIUM_PATH}\n`);
  });
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});

async function shutdown() {
  console.log('\nShutting down...');
  for (const a of agents.values()) {
    a.running = false;
    try { await a.context?.close(); } catch {}
  }
  try { io.close(); } catch {}
  try { server.close(); } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);