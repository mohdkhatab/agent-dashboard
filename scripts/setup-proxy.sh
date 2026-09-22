#!/usr/bin/env bash
# =====================================================================
# Sandbox Proxy Setup — Agent Dashboard ke liye
# =====================================================================
# Do tarike se use karo:
#
#   [1] EXTERNAL PROXY (recommended — "other country IP" ke liye)
#       Webshare / Bright Data / Oxylabs / Bagaimana jaisi service se
#       US/UK/Germany wagerah ka proxy IP le ke config.json me daalo:
#         "proxy": "http://username:password@HOST:PORT"
#       Phir:
#         node scripts/test-proxies.js
#       Ye har agent ka exit IP aur country dikhayega.
#
#   [2] LOCAL PROXY DAEMON (ye script)
#       Agar ye machine khud kisi dusre country ke VPS/server par hai,
#       to isko proxy banana hai. Ye 3proxy install karta hai:
#         HTTP proxy  : 0.0.0.0:3128
#         SOCKS5 proxy: 0.0.0.0:1080
#         Login       : dashboard / dashboard123
# =====================================================================
set -euo pipefail

echo "==> Agent Dashboard — Proxy Setup (3proxy)"

if [[ "${1:-}" == "external" ]]; then
  echo
  echo "EXTERNAL PROXY MODE:"
  echo "  1) Kis bhi proxy provider se dusre country ka IP le lo"
  echo "  2) config.json ke agents[].proxy me ye format me daalo:"
  echo "       http://user:pass@HOST:PORT"
  echo "       socks5://user:pass@HOST:PORT"
  echo "  3) npm run test-proxies  (har agent ka exit IP check hoga)"
  echo
  exit 0
fi

if [[ "$(id -u)" != "0" ]]; then
  echo "!! Ye script root chahiye (sudo)."
  echo "   Agar aapproot nahi ho to bas 'external' mode use karo: $0 external"
  echo "   Ya phir VPS par apne user ko sudo de do."
  exit 1
fi

echo "==> Installing 3proxy..."
if command -v apt-get >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y 3proxy || {
    echo "!! apt se 3proxy nahi mila, manual compile kar raha hoon..."
    cd /tmp
    rm -rf 3proxy && git clone --depth 1 https://github.com/3proxy/3proxy.git && cd 3proxy
    make -f Makefile.Linux
    mkdir -p /usr/local/bin
    cp bin/3proxy /usr/local/bin/
  }
else
  echo "!! apt nahi hai — manual install karo:"
  echo "   https://github.com/3proxy/3proxy"
  echo "   make -f Makefile.Linux && cp bin/3proxy /usr/local/bin/"
  exit 1
fi

echo "==> Writing config..."
mkdir -p /etc/3proxy
cat > /etc/3proxy/3proxy.cfg <<'CFG'
daemon
pidfile /var/run/3proxy.pid
log /var/log/3proxy.log
logformat "- +_L%L. %N.%p %E %U %C:%c %R:%r %O %I %h %T"
rotate 30
nscache 65536
auth strong
users dashboard:CL:dashboard123

proxy -p3128
socks -p1080
CFG

echo "==> Starting service..."
if command -v systemctl >/dev/null 2>&1; then
  cat > /etc/systemd/system/3proxy.service <<'SVC'
[Unit]
Description=3proxy
After=network.target
[Service]
ExecStart=/usr/local/bin/3proxy /etc/3proxy/3proxy.cfg
Restart=always
[Install]
WantedBy=multi-user.target
SVC
  systemctl daemon-reload
  systemctl enable --now 3proxy || true
  systemctl restart 3proxy || true
else
  /usr/local/bin/3proxy /etc/3proxy/3proxy.cfg || true
fi

echo
echo "=============================================================="
echo "  LOCAL PROXY READY"
echo "    HTTP  : http://dashboard:dashboard123@<THIS-IP>:3128"
echo "    SOCKS5: socks5://dashboard:dashboard123@<THIS-IP>:1080"
echo "  config.json me daalo, phir: node scripts/test-proxies.js"
echo "=============================================================="