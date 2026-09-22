#!/bin/bash
# VPN Gate — FREE residential IP per country (community VPN by Tsukuba University).
# Ye ghar/office IPs hain (residential), isliye analytics/geo-DB inhe SAHI country
# me dikhate hain (datacenter/Tor proxies ki tarah 'United States' default nahi).
#
# Usage:
#   bash scripts/vpngate.sh vn      # Vietnam residential IP (default route)
#   bash scripts/vpngate.sh jp      # Japan
#   bash scripts/vpngate.sh kr      # Korea (agar server available)
#   bash scripts/vpngate.sh --stop  # tunnel band
#
# Note: ek time par EK country ka tunnel (default route). Server list har fetch
# par update hoti hai; har server free hai, kabhi-kabhi bhara/down hota hai.

set -u
COUNTRY="${1:-jp}"
STOP_PID=/tmp/vpngate.pid

stop() {
  if [ -f "$STOP_PID" ]; then
    sudo kill "$(cat $STOP_PID)" 2>/dev/null
    rm -f "$STOP_PID"
    echo "VPN tunnel stopped."
    sleep 2
  else
    echo "koi tunnel nahi tha."
  fi
}

if [ "$COUNTRY" = "--stop" ]; then stop; exit 0; fi

echo "VPN Gate list fetch kar rahe hain..."
curl -s -m 30 "https://www.vpngate.net/api/iphone/" -o /tmp/vpngate.csv || { echo "fetch FAILED"; exit 1; }

stop

python3 - "$COUNTRY" <<'PY'
import csv, base64, sys
cc = sys.argv[1].upper()
best, score = None, -1
for line in open('/tmp/vpngate.csv'):
    line = line.strip()
    if not line or line.startswith('*') or line.startswith('#'): continue
    try: r = list(csv.reader([line]))[0]
    except Exception: continue
    if len(r) < 15: continue
    if r[6].upper() == cc:
        try: s = int(r[2])
        except Exception: s = 0
        if s > score: score, best = s, r
if not best:
    print(f'"{cc}" ka koi VPN Gate server abhi list me nahi. Try: jp,kr,ru,th,vn')
    sys.exit(2)
cfg = base64.b64decode(best[14]).decode('utf-8', 'ignore')
if '<auth-user-pass>' not in cfg:
    cfg += '\n<auth-user-pass>\nvpn\nvpn\n</auth-user-pass>\n'
open(f'/tmp/vpngate-{cc.lower()}.ovpn', 'w').write(cfg)
print(f'Server: {best[1]} | {best[12][:40]} | score={score}')
PY
[ $? -ne 0 ] && exit 2

sudo openvpn --config "/tmp/vpngate-${COUNTRY,,}.ovpn" --daemon vpngate-${COUNTRY,,} --writepid "$STOP_PID"
sleep 18
echo "Exit check:"
curl -s -m 15 "http://ip-api.com/json/?fields=query,country,countryCode,proxy,hosting,org" || echo "bootstrap me time laga — 10s me dobara try karo"
echo ""
echo "✅ ab default route is country ke residential IP se hai."