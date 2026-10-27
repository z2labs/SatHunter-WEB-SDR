"""Build data/sats.json for the page: SatNOGS DB satellites, transmitters and TLEs, CelesTrak
amateur TLEs, and SatNOGS Network reception statistics, in one compact file.

Usage:
  python tools/fetch_data.py [out.json]            download everything (needs internet)
  python tools/fetch_data.py --from DIR [out.json] build from files already in DIR
                                                    (transmitters.json, satellites.json,
                                                    tle_satnogs.json, tle_celestrak.txt,
                                                    network_stats.json; any may be missing)

Output (all frequencies in Hz):
  {"generated": ISO time, "sources": [...],
   "sats": [{"n": NORAD, "name": str, "hu": 0/1, "l1": TLE line 1, "l2": TLE line 2,
             "tx": [[description, mode, down_low, down_high, baud, active 0/1, good, vetted], ...]}]}

Only satellites in orbit with a TLE and at least one downlink are kept. "good" and "vetted"
(good + bad) are all-time SatNOGS Network observation counts of that transmitter.

Data: SatNOGS DB and Network (CC BY-SA 4.0, Libre Space Foundation), CelesTrak.
"""
import datetime, json, os, sys, urllib.request

SOURCES = {
    "transmitters.json": "https://db.satnogs.org/api/transmitters/?format=json",
    "satellites.json": "https://db.satnogs.org/api/satellites/?format=json",
    "tle_satnogs.json": "https://db.satnogs.org/api/tle/?format=json",
    "tle_celestrak.txt": "https://celestrak.org/NORAD/elements/gp.php?GROUP=amateur&FORMAT=tle",
    "network_stats.json": "https://network.satnogs.org/api/transmitters/?format=json",
}
DEAD = {"re-entered", "dead", "decayed", "future"}


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "SatHunter-WEB-SDR data builder"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read().decode("utf-8", "replace")


def as_list(v):
    if isinstance(v, list):
        return v
    if isinstance(v, dict) and isinstance(v.get("results"), list):
        return v["results"]
    return []


def epoch(l1):
    """TLE epoch as a sortable number (yyddd.ddd with the century resolved)."""
    try:
        yy = int(l1[18:20]); day = float(l1[20:32])
        return (2000 + yy if yy < 57 else 1900 + yy) * 1000 + day
    except ValueError:
        return 0


def build(raw):
    tles = {}

    def add(name, l1, l2):
        l1, l2 = l1.strip(), l2.strip()
        if not (l1.startswith("1 ") and l2.startswith("2 ") and len(l1) >= 64 and len(l2) >= 64):
            return
        try:
            n = int(l1[2:7])
        except ValueError:
            return
        old = tles.get(n)
        if old and epoch(old[1]) >= epoch(l1):
            return
        tles[n] = (name.strip(), l1, l2)

    if raw.get("tle_satnogs.json"):
        for o in as_list(json.loads(raw["tle_satnogs.json"])):
            name = (o.get("tle0") or "")
            add(name[2:] if name.startswith("0 ") else name, o.get("tle1") or "", o.get("tle2") or "")
    if raw.get("tle_celestrak.txt"):
        lines = [l.rstrip() for l in raw["tle_celestrak.txt"].splitlines() if l.strip()]
        i = 0
        while i + 1 < len(lines):
            if lines[i].startswith("1 ") and lines[i + 1].startswith("2 "):
                add("", lines[i], lines[i + 1]); i += 2
            elif i + 2 < len(lines) and lines[i + 1].startswith("1 ") and lines[i + 2].startswith("2 "):
                add(lines[i], lines[i + 1], lines[i + 2]); i += 3
            else:
                i += 1

    names, status, hu = {}, {}, set()
    if raw.get("satellites.json"):
        for o in as_list(json.loads(raw["satellites.json"])):
            n = o.get("norad_cat_id")
            if not n:
                continue
            if o.get("name"):
                names[n] = o["name"]
            status[n] = (o.get("status") or "").lower()
            if "HU" in [c.strip() for c in (o.get("countries") or "").split(",")]:
                hu.add(n)

    obs = {}
    if raw.get("network_stats.json"):
        for o in as_list(json.loads(raw["network_stats.json"])):
            st = o.get("stats") or {}
            good = int(st.get("good_count") or 0)
            obs[o.get("uuid")] = (good, good + int(st.get("bad_count") or 0))

    txs = {}
    for o in as_list(json.loads(raw["transmitters.json"])):
        n = o.get("norad_cat_id")
        low = o.get("downlink_drifted") or o.get("downlink_low") or 0
        if not n or not low or status.get(n, "") in DEAD:
            continue
        high = o.get("downlink_high") or 0
        if high and high < low:
            low, high = high, low
        good, vetted = obs.get(o.get("uuid"), (0, 0))
        active = 1 if (o.get("alive") and (o.get("status") or "") == "active") else 0
        txs.setdefault(n, []).append([(o.get("description") or "")[:48], o.get("mode") or "", int(low), int(high),
                                      int(o.get("baud") or 0), active, good, vetted])

    sats = []
    for n, tx in txs.items():
        if n not in tles:
            continue
        name, l1, l2 = tles[n]
        tx.sort(key=lambda t: t[2])
        sats.append({"n": n, "name": names.get(n) or name or f"NORAD {n}", "hu": 1 if n in hu else 0,
                     "l1": l1, "l2": l2, "tx": tx})
    sats.sort(key=lambda s: s["name"].lower())
    return {"generated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "sources": ["SatNOGS DB (CC BY-SA 4.0)", "SatNOGS Network", "CelesTrak"], "sats": sats}


def main():
    args = sys.argv[1:]
    src_dir = None
    if "--from" in args:
        i = args.index("--from"); src_dir = args[i + 1]; del args[i:i + 2]
    out = args[0] if args else os.path.join("data", "sats.json")
    raw = {}
    for name, url in SOURCES.items():
        try:
            if src_dir:
                p = os.path.join(src_dir, name)
                if os.path.exists(p):
                    raw[name] = open(p, encoding="utf-8").read()
            else:
                raw[name] = fetch(url)
                print(f"{name}: {len(raw[name]) / 1024:.0f} kB")
        except Exception as e:  # one missing source is fine, the transmitter list is not
            print(f"{name}: {e}")
    if not raw.get("transmitters.json"):
        sys.exit("no transmitter list")
    data = build(raw)
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(data, f, separators=(",", ":"), ensure_ascii=False)
    print(f"{out}: {len(data['sats'])} satellites, {os.path.getsize(out) / 1024:.0f} kB")


if __name__ == "__main__":
    main()
