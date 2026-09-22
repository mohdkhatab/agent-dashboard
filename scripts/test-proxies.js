#!/usr/bin/env node
/**
 * Har configured proxy ka exit IP + country check karo.
 * Use: npm run test-proxies
 */
const fs = require('fs');
const path = require('path');
const { ProxyAgent, fetch } = require('undici');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));

(async () => {
  console.log('\n  Proxy Test — har agent ka exit IP check:\n');
  let allOk = true;
  for (const a of config.agents) {
    if (!a.proxy) {
      console.log(`  [${a.id}] local (no proxy)  ${a.name}`);
      continue;
    }
    const agent = new ProxyAgent(a.proxy);
    try {
      const r = await fetch('https://ipinfo.io/json', { dispatcher: agent, signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const ok = j.country ? '✓' : '~';
      console.log(`  [${a.id}] ${ok} IP ${j.ip || '?'} | ${j.country || '?'} | ${j.city || ''} | ${j.org || ''}`);
    } catch (e) {
      allOk = false;
      console.log(`  [${a.id}] ✗ FAIL: ${e.message}`);
    }
  }
  console.log(allOk ? '\n  Sab proxies kaam kar rahe hain ✅\n' : '\n  Kuch proxies fail — proxy string check karo ❌\n');
  process.exit(allOk ? 0 : 1);
})();