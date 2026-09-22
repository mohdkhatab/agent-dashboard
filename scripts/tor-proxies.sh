#!/bin/bash
# Tor multi-country exit proxies — har country ka apna SOCKS5 proxy.
# Webtozip jaisi sites ke liye free "datacenter" proxies ka country detection
# galat hota hai (sab US dikhta hai). Tor exit nodes REAL servers hain, isliye
# geolocation sahi country dikhata hai.
#
# Usage:
#   sudo apt-get install -y tor          # pehli baar
#   bash scripts/tor-proxies.sh          # 13 countries start karo
#   node scripts/test-proxies.js         # exit IP / country check
#
# Har instance: socks5://127.0.0.1:19050 (us) ... 19062 (tw)
# StrictNodes 1 = exit country guaranteed. MaxCircuitDirtiness 60 = har ~1 min naya IP.
# Cloudflare blocked exits: fr, nl, ca (403) — unhe config me mat daalo.

COUNTRIES="us de fr gb nl jp ca sg au hk th kr tw"
PORT=19050
pkill -x tor 2>/dev/null
sleep 2
rm -rf /tmp/tor-data/* 2>/dev/null

for cc in $COUNTRIES; do
  mkdir -p /tmp/tor-data/$cc
  cat > /tmp/tor-setup/torrc-$cc <<CFG
SocksPort $PORT
DataDirectory /tmp/tor-data/$cc
ExitNodes {$cc}
StrictNodes 1
MaxCircuitDirtiness 60
NewCircuitPeriod 60
GeoIPFile /usr/share/tor/geoip
GeoIPv6File /usr/share/tor/geoip6
Log notice file /tmp/tor-$cc.log
CFG
  (tor -f /tmp/tor-setup/torrc-$cc --runasdaemon 0 >/tmp/tor-$cc.stdout 2>&1 &)
  echo "tor-$cc -> socks5://127.0.0.1:$PORT"
  PORT=$((PORT+1))
done
echo ""
echo "Done: $((PORT-19050)) country exits. ~60s bootstrap ke baad use karo."
echo "Port map: 19050 us | 19051 de | 19052 fr | 19053 gb | 19054 nl | 19055 jp | 19056 ca |"
echo "          19057 sg | 19058 au | 19059 hk | 19060 th | 19061 kr | 19062 tw"