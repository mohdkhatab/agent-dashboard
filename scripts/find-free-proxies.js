#!/usr/bin/env node
/**
 * Free public proxies download + test — working exit-IP wale nikalta hai.
 * Use: node scripts/find-free-proxies.js
 */
const { ProxyAgent, fetch } = require('undici');

const SOURCES = {
  http: [
    'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
    'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
    'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=5000&country=all&ssl=all&anonymity=all',
    'https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt',
  ],
  socks5: [
    'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt',
    'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt',
  ],
};

// country-specific free lists (proxyscrape) — rotation diversity ke liye
const COUNTRIES = ['in', 'jp', 'br', 'tr', 'id', 'kr', 'th', 'vn', 'ph', 'np', 'pk', 'bd', 'us'];
for (const cc of COUNTRIES) {
  SOURCES.http.push(`https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=5000&country=${cc}&ssl=all&anonymity=all`);
  SOURCES.socks5.push(`https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=5000&country=${cc}&ssl=all&anonymity=all`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getProxies() {
  const out = new Set();
  const jobs = [];
  for (const [type, urls] of Object.entries(SOURCES)) {
    for (const u of urls) {
      jobs.push(
        fetch(u, { signal: AbortSignal.timeout(15000) })
          .then((r) => (r.ok ? r.text() : ''))
          .then((t) => {
            for (const line of t.split('\n')) {
              const l = line.trim();
              if (!l) continue;
              const str = l.includes('://') ? l : (type === 'socks5' ? 'socks5://' + l : 'http://' + l);
              out.add(str);
            }
          })
          .catch(() => {})
      );
    }
  }
  await Promise.all(jobs);
  return [...out];
}

async function testProxy(proxy) {
  const agent = new ProxyAgent({ uri: proxy, connect: { timeout: 6000 } });
  const t0 = Date.now();
  try {
    const r = await fetch('https://ipinfo.io/json', { dispatcher: agent, signal: AbortSignal.timeout(9000) });
    if (!r.ok) return null;
    const j = await r.json();
    return { proxy, ms: Date.now() - t0, ip: j.ip, country: j.country, city: j.city, org: j.org || '' };
  } catch {
    return null;
  }
}

(async () => {
  console.log('\n  Proxy lists download ho rahe hain...');
  const all = await getProxies();
  console.log(`  Total candidates: ${all.length}`);

  const results = [];
  const seen = new Set();
  const batch = 20;
  for (let i = 0; i < all.length; i += batch) {
    const chunk = all.slice(i, i + batch);
    const res = await Promise.all(chunk.map(testProxy));
    for (const x of res) {
      if (x && !seen.has(x.ip)) {
        seen.add(x.ip);
        results.push(x);
      }
    }
    if (results.length >= 30) break;
    await sleep(400);
  }

  results.sort((a, b) => a.ms - b.ms);
  console.log(`\n  ✅ Working proxies (${results.length}):\n`);
  results.forEach((x, i) => {
    console.log(`   ${String(i + 1).padStart(2)}. ${x.proxy}  | ${x.ip} | ${x.country} | ${x.city} | ${x.ms}ms`);
  });
  console.log('');
})().catch((e) => { console.error(e); process.exit(1); });