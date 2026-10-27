"""Writes raw/*.json in the SatNOGS formats for the tests (made-up satellites, valid TLE layout)."""
import json, os
here = os.path.dirname(os.path.abspath(__file__))
def cks(l):
    s = sum(int(c) if c.isdigit() else (1 if c == '-' else 0) for c in l[:68]); return l[:68] + str(s % 10)
def tle(n, epoch, inc, raan, ecc, argp, ma, mm):
    l1 = f"1 {n:05d}U 24001A   {epoch:014.8f}  .00010000  00000-0  15000-3 0  999"
    l2 = f"2 {n:05d} {inc:8.4f} {raan:8.4f} {ecc:07d} {argp:8.4f} {ma:8.4f} {mm:11.8f}{12345:5d}"
    return cks(l1.ljust(68)), cks(l2.ljust(68))
iss = ("1 25544U 98067A   26282.95044904  .00006711  00000-0  13074-3 0  9998",
       "2 25544  51.6315  92.1575 0006672 244.0714 115.9587 15.48795780589546")
s1 = tle(90001, 26282.50000000, 97.6, 10.0, 12000, 90.0, 270.0, 15.20)
s2 = tle(90002, 26282.50000000, 97.4, 200.0, 9000, 45.0, 10.0, 14.95)
os.makedirs(os.path.join(here, "raw"), exist_ok=True)
w = lambda name, obj: json.dump(obj, open(os.path.join(here, "raw", name), "w"))
w("tle_satnogs.json", [{"tle0": "0 ISS (ZARYA)", "tle1": iss[0], "tle2": iss[1]},
                       {"tle0": "0 SBANDSAT-1", "tle1": s1[0], "tle2": s1[1]},
                       {"tle0": "0 HUNSAT", "tle1": s2[0], "tle2": s2[1]}])
w("satellites.json", [{"name": "ISS", "norad_cat_id": 25544, "status": "alive", "countries": "RU,US"},
                      {"name": "SBANDSAT-1", "norad_cat_id": 90001, "status": "alive", "countries": "DE"},
                      {"name": "HUNSAT", "norad_cat_id": 90002, "status": "alive", "countries": "HU"}])
w("transmitters.json", [
  {"uuid": "a", "description": "APRS", "alive": True, "status": "active", "downlink_low": 145825000, "mode": "AFSK", "baud": 1200, "norad_cat_id": 25544},
  {"uuid": "b", "description": "S-band telemetry", "alive": True, "status": "active", "downlink_low": 2245000000, "mode": "GMSK", "baud": 9600, "norad_cat_id": 90001},
  {"uuid": "c", "description": "13 cm beacon", "alive": True, "status": "active", "downlink_low": 2401500000, "mode": "CW", "norad_cat_id": 90002},
  {"uuid": "d", "description": "UHF", "alive": True, "status": "active", "downlink_low": 437100000, "mode": "FM", "norad_cat_id": 90002}])
w("network_stats.json", [{"uuid": "a", "stats": {"good_count": 5000, "bad_count": 1000}},
                         {"uuid": "b", "stats": {"good_count": 300, "bad_count": 30}}])
