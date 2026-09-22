/* Agent Dashboard frontend — renders 4 panels, live screenshots via Socket.IO */
(() => {
  const grid = document.getElementById('grid');
  const connChip = document.getElementById('connChip');
  const globalStats = document.getElementById('globalStats');

  const AGENT_IDS = ['home', 'chats', 'ads', 'news'];
  const sockets = new Map(); // id -> latest base64 frame
  const statuses = new Map(); // id -> status summary

  /* ---------- build panels ---------- */
  AGENT_IDS.forEach((id) => {
    const panel = document.createElement('section');
    panel.className = 'panel';
    panel.dataset.id = id;
    panel.innerHTML = `
      <div class="panel-head">
        <span class="dot starting"></span>
        <span class="panel-title">${id.toUpperCase()}</span>
        <div class="panel-meta"><span class="url">—</span></div>
      </div>
      <div class="ip-row">
        <span class="dot ok"></span>
        <span class="proxy">proxy: —</span>
        <span class="ip"></span>
        <span class="stats"></span>
      </div>
      <div class="screen">
        <span class="skeleton">waiting for live frame…</span>
        <div class="last-action" style="display:none"></div>
        <span class="frame-ts"></span>
      </div>
      <div class="controls">
        <button data-act="scroll" data-dir="up" title="Scroll up">▲ Up</button>
        <button data-act="scroll" data-dir="down" title="Scroll down">▼ Down</button>
        <button data-act="click" title="Click a banner">👆 Click Banner</button>
        <button data-act="reload" title="Reload page">↻ Reload</button>
        <span class="spacer"></span>
        <button class="pause" data-act="pause" title="Pause / resume automation">⏸ Pause</button>
      </div>
    `;
    grid.appendChild(panel);

    /* button wiring */
    panel.querySelectorAll('button[data-act]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const act = btn.dataset.act;
        const body = {};
        if (act === 'scroll') body = { dir: btn.dataset.dir, px: 420 };
        const r = await fetch(`/api/${id}/${act}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }).catch(() => null);
        if (r) {
          const j = await r.json().catch(() => ({}));
          if (j.agent && j.agent.paused) {
            btn.textContent = j.agent.paused ? '▶ Resume' : '⏸ Pause';
            btn.classList.toggle('paused', !!j.agent.paused);
          }
        }
      });
    });
  });

  /* ---------- helpers ---------- */
  const panelOf = (id) => grid.querySelector(`.panel[data-id="${id}"]`);

  function applyStatus(list) {
    list.forEach((s) => {
      statuses.set(s.id, s);
      const p = panelOf(s.id);
      if (!p) return;
      const dot = p.querySelector('.panel-head .dot');
      dot.className = 'dot ' + (s.status === 'ok' ? 'ok' : s.status.startsWith('error') ? 'error' : 'starting');
      p.querySelector('.panel-meta .url').textContent = s.url || '—';
      p.querySelector('.ip-row .proxy').textContent = 'proxy: ' + (s.proxyLabel || '—');
      if (s.ip) {
        const ipTxt = p.querySelector('.ip-row .ip');
        ipTxt.textContent = `${s.ip.ip || ''} ${s.ip.country ? '· ' + s.ip.country : ''}${s.ip.city ? ' · ' + s.ip.city : ''}`;
      }
      p.querySelector('.ip-row .stats').textContent = `⚡${s.shots} · 🖱${s.clicks} · 🔄${s.loads || 0}`;
      const la = p.querySelector('.last-action');
      if (s.lastActionShown) {} // (lastAction socket events se aata hai)
    });
  }

  function setConn(on) {
    connChip.textContent = on ? '● Live — connected' : '● Reconnecting…';
    connChip.className = 'chip conn ' + (on ? 'on' : 'off');
  }

  /* ---------- socket ---------- */
  const socket = io();
  socket.on('connect', () => setConn(true));
  socket.on('disconnect', () => setConn(false));
  socket.on('connect_error', () => setConn(false));

  socket.on('shot', (s) => {
    sockets.set(s.id, s.data);
    const p = panelOf(s.id);
    if (!p) return;
    const screen = p.querySelector('.screen');
    let img = screen.querySelector('img.shot');
    if (!img) {
      screen.querySelector('.skeleton')?.remove();
      img = document.createElement('img');
      img.className = 'shot';
      screen.appendChild(img);
    }
    img.src = 'data:image/jpeg;base64,' + s.data;
    const ts = screen.querySelector('.frame-ts');
    if (ts) ts.textContent = new Date(s.ts).toLocaleTimeString();
  });

  socket.on('status', applyStatus);

  /* ---------- periodic refresh of status ---------- */
  setInterval(async () => {
    try {
      const r = await fetch('/api/agents');
      const j = await r.json();
      if (j.ok) applyStatus(j.agents);
    } catch {}
  }, 3000);
})();