#!/usr/bin/env python3
"""
data.vlaj.at — Klimadiagramme
=============================
Klimanormalwerte 1991–2020 (Monatsmittel der Temperatur, mittleres
Tagesmaximum/-minimum, Niederschlagssumme) für Städte weltweit.

Quellen (alle frei zugänglich):
  • WMO Climate Normals 1991–2020, von den nationalen Wetterdiensten an
    die WMO gemeldet, archiviert bei NOAA NCEI (Accession 0253808).
    Offizielle Normalwerte, ~5.000 Stationen in 140 Ländern; Datei
    „min24“ = mindestens 24 von 30 Jahren. Enthält auch Sonnenstunden
    und Niederschlagstage (≥ 1 mm).
  • NOAA NCEI Global Summary of the Month (GSOM, aus GHCN-Daily)
    – gemeinfrei (U.S. Government Work). ~1,5 GB tar.gz. Ergänzt das
    dichte Stationsnetz v. a. in den USA und Europa.
  • GeoSphere Austria Data Hub, Datensatz klima-v2-1m – CC BY 4.0.
    Ersetzt für Österreich die GHCN-Stationen (dichter, offizieller).
  • GeoNames cities15000 + deutsche Namen (alternateNamesV2) – CC BY 4.0.
    Ordnet jeder Station die nächstgelegene Stadt zu.

Rangfolge bei mehreren Stationen: GeoSphere (Österreich) > WMO > GSOM.
GSOM-Stationen im Umkreis von DUP_KM km einer WMO-Station gelten als
Duplikat und entfallen.

Qualitätskriterium (WMO-Richtlinie für Normalwerte): jeder Kalendermonat
muss in mindestens MIN_YEARS der 30 Jahre einen gültigen Wert für
Temperatur UND Niederschlag haben. GSOM verwirft Monate mit mehr als
5 Fehltagen bereits selbst.

Zuordnung: Städte nach Einwohnerzahl absteigend; jede Stadt bekommt die
beste Station im Umkreis von MAX_KM km mit höchstens MAX_DH m
Höhenunterschied (Punkte = km + Δh/10). Jede Station wird nur einmal
vergeben, damit Vororte nicht dieselben Werte doppelt zeigen.

Ausgabe:
  docs/klima/index.json   Städteliste (kompakt) + Metadaten
  docs/klima/<CC>.json    Normalwerte aller Städte eines Landes

Die Normalwerte ändern sich nur alle 10 Jahre (nächste Periode 2001–2030),
daher läuft das Skript lokal und nicht in GitHub Actions. Downloads werden
in pipeline/.cache/ zwischengespeichert.

Lokal: pip install requests && python pipeline/fetch_klima.py
"""

import csv, io, json, math, sys, tarfile, zipfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

try:
    import requests
    from wb import log
except ImportError:
    print("Bitte 'pip install requests' ausführen")
    sys.exit(1)

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / ".cache"
OUT_DIR = ROOT.parent / "docs" / "klima"
UA = {"User-Agent": "data.vlaj.at-pipeline"}

Y0, Y1 = 1991, 2020
MIN_YEARS = 24          # 80 % von 30 Jahren
MAX_KM = 30
MAX_DH = 150
DUP_KM = 3
SRC_BONUS = {"geosphere": 8, "wmo": 4, "ghcn": 0}   # km-Bonus bei der Stationswahl
WMO_BASE = "https://www.ncei.noaa.gov/data/oceans/archive/arc0216/0253808/1.1/data/0-data/data-composite-primary-parameters-min24"
WMO_ELEM = {"t": "TAVG", "tx": "TMAX", "tn": "TMIN", "p": "PRCP", "sun": "TSUN", "rd": "DP01"}

URLS = {
    "gsom/gsom-latest.tar.gz": "https://www.ncei.noaa.gov/data/global-summary-of-the-month/archive/gsom-latest.tar.gz",
    "geo/ghcnd-stations.txt": "https://www.ncei.noaa.gov/pub/data/ghcn/daily/ghcnd-stations.txt",
    "geo/cities15000.zip": "https://download.geonames.org/export/dump/cities15000.zip",
    "geo/alternateNamesV2.zip": "https://download.geonames.org/export/dump/alternateNamesV2.zip",
    "geo/countryInfo.txt": "https://download.geonames.org/export/dump/countryInfo.txt",
    "geo/admin1CodesASCII.txt": "https://download.geonames.org/export/dump/admin1CodesASCII.txt",
    **{f"wmo/wmo_normals_9120_{e}_min24.csv": f"{WMO_BASE}/wmo_normals_9120_{e}_min24.csv" for e in WMO_ELEM.values()},
}
NAME_FIX = {1816670: "Peking"}   # GeoNames markiert „Beijing“ als bevorzugten deutschen Namen
GS_API = "https://dataset.api.hub.geosphere.at/v1/station/historical/klima-v2-1m"


def cached(rel: str) -> Path:
    p = CACHE / rel
    if not p.exists():
        p.parent.mkdir(parents=True, exist_ok=True)
        log(f"Lade {URLS[rel]}…")
        tmp = p.with_suffix(p.suffix + ".part")
        with requests.get(URLS[rel], stream=True, timeout=600, headers=UA) as r:
            r.raise_for_status()
            with open(tmp, "wb") as f:
                for chunk in r.iter_content(1 << 20):
                    f.write(chunk)
        tmp.rename(p)
    return p


# ── Normalwerte ───────────────────────────────────────────
def normals(t, tx, tn, p):
    """Eingabe je Größe: {monat(0–11): [werte]}. → dict oder None."""
    def mean(d, m):
        v = d.get(m, [])
        return sum(v) / len(v) if len(v) >= MIN_YEARS else None
    P = [mean(p, m) for m in range(12)]
    if None in P:
        return None
    TX = [mean(tx, m) for m in range(12)]
    TN = [mean(tn, m) for m in range(12)]
    T = [mean(t, m) for m in range(12)]
    if None in T:                               # Ersatz: (Tmax + Tmin) / 2
        if None in TX or None in TN:
            return None
        T = [(a + b) / 2 for a, b in zip(TX, TN)]
    tsrc = t if None not in [mean(t, m) for m in range(12)] else tx
    years = min(min(len(p.get(m, [])), len(tsrc.get(m, []))) for m in range(12))
    r1 = lambda a: [round(v, 1) for v in a] if None not in a else None
    out = {"t": r1(T), "p": [round(v) if v >= 10 else round(v, 1) for v in P], "y": years}
    if r1(TX) and r1(TN):
        out["tx"], out["tn"] = r1(TX), r1(TN)
    return out


def koeppen(T, P, lat):
    """Köppen-Geiger nach Peel et al. (2007)."""
    MAT, MAP = sum(T) / 12, sum(P)
    Thot, Tcold = max(T), min(T)
    summer = [3, 4, 5, 6, 7, 8] if lat >= 0 else [9, 10, 11, 0, 1, 2]   # Apr–Sep bzw. Okt–Mär
    winter = [m for m in range(12) if m not in summer]
    Ps, Pw = [P[m] for m in summer], [P[m] for m in winter]
    if sum(Pw) >= 0.7 * MAP:
        Pth = 2 * MAT
    elif sum(Ps) >= 0.7 * MAP:
        Pth = 2 * MAT + 28
    else:
        Pth = 2 * MAT + 14
    if Thot < 10:
        return "ET" if Thot > 0 else "EF"
    if MAP < 10 * Pth:
        return ("BW" if MAP < 5 * Pth else "BS") + ("h" if MAT >= 18 else "k")
    if Tcold >= 18:
        Pdry = min(P)
        if Pdry >= 60:
            return "Af"
        return "Am" if Pdry >= 100 - MAP / 25 else "Aw"
    if min(Ps) < 40 and min(Ps) < max(Pw) / 3:
        s = "s"
    elif min(Pw) < max(Ps) / 10:
        s = "w"
    else:
        s = "f"
    warm = sum(1 for v in T if v >= 10)
    if Thot >= 22:
        t = "a"
    elif warm >= 4:
        t = "b"
    elif Tcold < -38:
        t = "d"
    else:
        t = "c"
    return ("C" if Tcold > 0 else "D") + s + t


def plausible(s):
    """Verwirft Stationen mit unmöglichen Werten (Fehlwert-Codes, vertauschte Spalten, Einheitenfehler)."""
    if not all(-60 <= v <= 40 for v in s["t"]) or not all(0 <= v <= 2500 for v in s["p"]):
        return False
    if "tx" in s:
        if not all(-55 <= a <= 50 and -70 <= b <= 35 and a >= b for a, b in zip(s["tx"], s["tn"])):
            return False
        if any(abs(t - (a + b) / 2) > 3 for t, a, b in zip(s["t"], s["tx"], s["tn"])):
            return False
    if "sun" in s and not all(0 <= v <= 450 for v in s["sun"]):
        del s["sun"]
    if "rd" in s and not all(0 <= v <= 31 for v in s["rd"]):
        del s["rd"]
    return True


# ── Quelle 0: WMO-Normalwerte 1991–2020 ───────────────────
def wmo_name(s):
    import re
    s = s.strip().replace("_", " ")
    s = re.sub(r"(?<=[a-zäöüé])(?=[A-Z])", " ", s)      # „HongKongObservatory“ → „Hong Kong Observatory“
    return nice_name(" ".join(s.split()))


def wmo_normals():
    """→ {schlüssel: station}. Zeilen werden von hinten gelesen (Stationsnamen enthalten teils Kommas)."""
    elems = {}
    for k, e in WMO_ELEM.items():
        with open(cached(f"wmo/wmo_normals_9120_{e}_min24.csv"), encoding="utf-8", errors="replace") as f:
            rows = list(csv.reader(f))[1:]
        for r in rows:
            if len(r) < 22:
                continue
            try:
                vals = [float(v) for v in r[-13:-1]]
                lat, lon, h = float(r[4]), float(r[5]), float(r[6])
            except ValueError:
                continue
            if any(v <= -90 for v in vals):           # Fehlwert-Code −99,9
                continue
            key = f"WMO{r[2].strip()}@{lat:.2f},{lon:.2f}"
            st = elems.setdefault(key, {"lat": lat, "lon": lon, "h": h, "name": wmo_name(",".join(r[8:-13])),
                                        "wmo": r[2].strip().lstrip("0")})
            st[k] = vals
    out = {}
    for key, s in elems.items():
        if "p" not in s:
            continue
        if "t" not in s:
            if "tx" not in s or "tn" not in s:
                continue
            s["t"] = [(a + b) / 2 for a, b in zip(s["tx"], s["tn"])]
            s["tcalc"] = 1                          # Mittel aus Tmax und Tmin
        r1 = lambda a: [round(v, 1) for v in a]
        rec = {"lat": s["lat"], "lon": s["lon"], "h": s["h"], "name": s["name"], "src": "wmo", "y": None,
               "t": r1(s["t"]), "p": [round(v) if v >= 10 else round(v, 1) for v in s["p"]], "wmo": s["wmo"]}
        if "tx" in s and "tn" in s:
            rec["tx"], rec["tn"] = r1(s["tx"]), r1(s["tn"])
        if "sun" in s:
            rec["sun"] = [round(v) for v in s["sun"]]
        if "rd" in s:
            rec["rd"] = r1(s["rd"])
        if s.get("tcalc"):
            rec["tcalc"] = 1
        out[key] = rec
    log(f"  WMO: {len(out)} Stationen mit Temperatur und Niederschlag")
    return out


# ── Quelle 1: NOAA GSOM ───────────────────────────────────
def ghcn_stations(fips2iso):
    st = {}
    for line in open(cached("geo/ghcnd-stations.txt"), encoding="utf-8", errors="replace"):
        sid = line[0:11]
        try:
            st[sid] = {"lat": float(line[12:20]), "lon": float(line[21:30]),
                       "h": float(line[31:37]), "name": line[41:71].strip(),
                       "cc": fips2iso.get(sid[:2], "")}
        except ValueError:
            pass
    return st


def fnum(s):
    try:
        return float(s) if s not in ("", None) else None
    except ValueError:
        return None


def gsom_normals():
    """Ergebnis wird je tar-Datei und Kriterium zwischengespeichert (Lesen dauert Minuten)."""
    tar = cached("gsom/gsom-latest.tar.gz")
    memo = CACHE / f"gsom_normals_{int(tar.stat().st_mtime)}_{MIN_YEARS}.json"
    if memo.exists():
        return json.loads(memo.read_text())
    res = _gsom_read(tar)
    memo.write_text(json.dumps(res))
    return res


def _gsom_read(tar):
    res = {}
    n = 0
    with tarfile.open(tar, "r|gz") as tf:
        for m in tf:
            if not m.isfile() or not m.name.endswith(".csv"):
                continue
            n += 1
            if n % 10000 == 0:
                log(f"  {n} Stationsdateien gelesen, {len(res)} erfüllen das Kriterium")
            raw = tf.extractfile(m).read().decode("utf-8", "replace")
            if '"PRCP"' not in raw[:3000] or ('"TAVG"' not in raw[:3000] and '"TMAX"' not in raw[:3000]):
                continue
            d = {k: defaultdict(list) for k in ("t", "tx", "tn", "p")}
            sid = None
            for r in csv.DictReader(io.StringIO(raw)):
                date = r.get("DATE", "")
                if len(date) < 7 or not (str(Y0) <= date[:4] <= str(Y1)):
                    continue
                sid = r["STATION"]
                mo = int(date[5:7]) - 1
                for k, col in (("t", "TAVG"), ("tx", "TMAX"), ("tn", "TMIN"), ("p", "PRCP")):
                    v = fnum(r.get(col))
                    if v is not None:
                        d[k][mo].append(v)
            if sid:
                nm = normals(d["t"], d["tx"], d["tn"], d["p"])
                if nm:
                    res[sid] = nm
    log(f"  GSOM: {n} Stationen gelesen, {len(res)} mit vollständigen Normalwerten")
    return res


# ── Quelle 2: GeoSphere Austria ───────────────────────────
def geosphere_normals():
    meta = requests.get(GS_API + "/metadata", timeout=120, headers=UA).json()
    cand = [s for s in meta["stations"] if s["valid_from"][:4] <= str(Y0 + 6) and s["valid_to"][:4] >= str(Y1 - 6)]
    log(f"  GeoSphere: {len(cand)} Stationen mit möglicher Abdeckung")
    params = "tl_mittel,tlmax_mittel,tlmin_mittel,rr"
    data, todo = {}, [s["id"] for s in cand]
    while todo:
        batch, todo = todo[:40], todo[40:]
        for _ in range(len(batch) + 1):
            if not batch:
                break
            r = requests.get(GS_API, timeout=300, headers=UA, params={
                "parameters": params, "start": f"{Y0}-01-01", "end": f"{Y1}-12-31",
                "station_ids": ",".join(map(str, batch)), "output_format": "geojson"})
            if r.status_code == 200:
                break
            msg = r.json().get("detail", "") if r.headers.get("content-type", "").startswith("application/json") else r.text
            bad = [b for b in batch if f"'{b}'" in str(msg)]
            if not bad:
                raise RuntimeError(f"GeoSphere: HTTP {r.status_code} {str(msg)[:200]}")
            batch = [b for b in batch if b not in bad]
        else:
            continue
        if not batch:
            continue
        j = r.json()
        months = [int(ts[5:7]) - 1 for ts in j["timestamps"]]
        for f in j["features"]:
            sid = int(f["properties"]["station"])
            pr = f["properties"]["parameters"]
            d = {}
            for k, col in (("t", "tl_mittel"), ("tx", "tlmax_mittel"), ("tn", "tlmin_mittel"), ("p", "rr")):
                dd = defaultdict(list)
                for mo, v in zip(months, pr.get(col, {}).get("data", [])):
                    if v is not None:
                        dd[mo].append(v)
                d[k] = dd
            nm = normals(d["t"], d["tx"], d["tn"], d["p"])
            if nm:
                data[sid] = nm
    stations = {s["id"]: s for s in meta["stations"]}
    out = {}
    for sid, nm in data.items():
        s = stations[sid]
        out[f"GS{sid}"] = {**nm, "lat": s["lat"], "lon": s["lon"], "h": s["altitude"], "name": s["name"],
                          "cc": "AT", "src": "geosphere"}
    log(f"  GeoSphere: {len(out)} Stationen mit vollständigen Normalwerten")
    return out


# ── Städte ────────────────────────────────────────────────
def load_cities():
    cities = []
    with zipfile.ZipFile(cached("geo/cities15000.zip")) as z:
        for line in io.TextIOWrapper(z.open("cities15000.txt"), encoding="utf-8"):
            f = line.rstrip("\n").split("\t")
            if f[7] in ("PPLX", "PPLH", "PPLQ", "PPLW"):   # Stadtteile, historische/verlassene Orte
                continue
            dem = f[16] if f[16] not in ("", "-9999") else f[15]
            cities.append({"gid": int(f[0]), "name": f[1], "ascii": f[2], "lat": float(f[4]), "lon": float(f[5]),
                           "fcode": f[7], "cc": f[8], "adm": f[10], "pop": int(f[14] or 0),
                           "h": float(dem) if dem not in ("", "-9999") else None})
    gids = {c["gid"] for c in cities}
    de = {}
    log("  Deutsche Namen aus alternateNamesV2…")
    with zipfile.ZipFile(cached("geo/alternateNamesV2.zip")) as z:
        for line in io.TextIOWrapper(z.open("alternateNamesV2.txt"), encoding="utf-8"):
            f = line.split("\t")
            if f[2] != "de" or int(f[1]) not in gids:
                continue
            gid = int(f[1])
            hist = len(f) > 7 and (f[6] == "1" or f[7] == "1")      # umgangssprachlich / historisch
            if hist:
                continue
            pref = f[4] == "1"
            if gid not in de or (pref and not de[gid][1]):
                de[gid] = (f[3], pref)
    for c in cities:
        if c["gid"] in de:
            c["de"] = de[c["gid"]][0]
        c["de"] = NAME_FIX.get(c["gid"], c.get("de", c["name"]))
    adm = {}
    for line in open(cached("geo/admin1CodesASCII.txt"), encoding="utf-8"):
        f = line.rstrip("\n").split("\t")
        adm[f[0]] = f[1]
    for c in cities:
        c["admName"] = adm.get(f"{c['cc']}.{c['adm']}", "")
    return cities


def fips_map():
    m = {}
    for line in open(cached("geo/countryInfo.txt"), encoding="utf-8"):
        if line.startswith("#"):
            continue
        f = line.split("\t")
        if len(f) > 3 and f[3]:
            m[f[3]] = f[0]
    return m


def km(a_lat, a_lon, b_lat, b_lon):
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dl = math.radians(b_lon - a_lon)
    x = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 12742 * math.asin(min(1, math.sqrt(x)))


def nice_name(s):
    """GHCN-Namen sind GROSS geschrieben: 'WIEN HOHE WARTE' → 'Wien Hohe Warte'."""
    if s.upper() != s:
        return s
    small = {"AP": "AP", "INTL": "Intl.", "AFB": "AFB", "WSO": "WSO", "WSFO": "WSFO", "NWS": "NWS", "AWOS": "AWOS"}
    return " ".join(small.get(w, w.capitalize()) for w in s.split())


def match(cities, stations):
    grid = defaultdict(list)
    for sid, s in stations.items():
        grid[(int(s["lat"] * 4), int(s["lon"] * 4))].append(sid)
    used, out = set(), []
    for c in sorted(cities, key=lambda c: -c["pop"]):
        gi, gj = int(c["lat"] * 4), int(c["lon"] * 4)
        best = None
        for di in (-1, 0, 1):
            for dj in (-2, -1, 0, 1, 2):
                for sid in grid.get((gi + di, gj + dj), ()):
                    if sid in used and c["fcode"] != "PPLC":
                        continue
                    s = stations[sid]
                    d = km(c["lat"], c["lon"], s["lat"], s["lon"])
                    if d > MAX_KM:
                        continue
                    dh = abs(s["h"] - c["h"]) if c["h"] is not None and s["h"] > -999 else 0
                    if dh > MAX_DH:
                        continue
                    score = d + dh / 10 - SRC_BONUS[s["src"]]
                    if best is None or score < best[0]:
                        best = (score, sid, d)
        if best:
            used.add(best[1])
            out.append((c, best[1], best[2]))
    return out


def main():
    try:
        log("=== Klimanormalwerte 1991–2020 ===")
        fips = fips_map()
        meta = ghcn_stations(fips)
        log("GeoSphere Austria…")
        stations = geosphere_normals()
        log("WMO-Normalwerte…")
        wmo = wmo_normals()
        near = lambda s, pool: any(km(s["lat"], s["lon"], o["lat"], o["lon"]) < DUP_KM
                                   for o in pool if abs(o["lat"] - s["lat"]) < 0.1)
        gs = list(stations.values())
        for k, s in wmo.items():
            if not near(s, gs):                     # Österreich: GeoSphere hat Vorrang
                stations[k] = s
        wl = list(wmo.values())
        log("NOAA GSOM (dauert einige Minuten)…")
        dup = 0
        for sid, nm in gsom_normals().items():
            s = meta.get(sid)
            if not s or s["cc"] == "AT":            # Österreich kommt von GeoSphere
                continue
            s = {**nm, **s, "src": "ghcn"}
            if near(s, wl):
                dup += 1
                continue
            stations[sid] = s
        log(f"  GSOM: {dup} Duplikate von WMO-Stationen verworfen")
        bad = [k for k, s in stations.items() if not plausible(s)]
        for k in bad:
            del stations[k]
        log(f"{len(stations)} Stationen insgesamt ({len(bad)} unplausible verworfen)")
        log("Städte…")
        cities = load_cities()
        pairs = match(cities, stations)
    except (RuntimeError, KeyError, ValueError, OSError, requests.RequestException) as e:
        log(f"✗ Abbruch: {e} – bestehende Dateien bleiben unverändert")
        sys.exit(1)

    if len(pairs) < 1000:
        log(f"✗ Nur {len(pairs)} Städte – nichts geschrieben")
        sys.exit(1)

    # Gleichnamige Städte eines Landes bekommen das Bundesland dazu
    names = defaultdict(int)
    for c, _, _ in pairs:
        names[(c["cc"], c.get("de", c["name"]))] += 1

    index, per_cc = [], defaultdict(dict)
    for c, sid, d in sorted(pairs, key=lambda x: (x[0]["cc"], -x[0]["pop"])):
        s = stations[sid]
        nm = c.get("de", c["name"])
        alt = sorted({x for x in (c["name"], c["ascii"]) if x and x != nm})
        index.append([c["gid"], nm, c["cc"], c["admName"] if names[(c["cc"], nm)] > 1 else "",
                      c["pop"], 1 if c["fcode"] == "PPLC" else 0, " ".join(alt)])
        rec = {"lat": round(c["lat"], 3), "lon": round(c["lon"], 3),
               "st": nice_name(s["name"]), "sid": sid, "src": s["src"],
               "slat": round(s["lat"], 3), "slon": round(s["lon"], 3), "h": round(s["h"]),
               "d": round(d, 1), "y": s["y"], "t": s["t"], "p": s["p"],
               "kg": koeppen(s["t"], s["p"], s["lat"])}
        for k in ("tx", "tn", "sun", "rd", "tcalc", "wmo"):
            if k in s:
                rec[k] = s[k]
        per_cc[c["cc"]][str(c["gid"])] = rec

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for f in OUT_DIR.glob("*.json"):
        f.unlink()
    for cc, recs in per_cc.items():
        (OUT_DIR / f"{cc}.json").write_text(json.dumps(recs, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    meta_out = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "period": [Y0, Y1], "minYears": MIN_YEARS, "maxKm": MAX_KM, "maxDh": MAX_DH,
        "fields": ["gid", "name", "cc", "admin", "pop", "capital", "alt"],
        "cities": index,
    }
    (OUT_DIR / "index.json").write_text(json.dumps(meta_out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    src = defaultdict(int)
    for c, sid, _ in pairs:
        src[stations[sid]["src"]] += 1
    log(f"✓ {len(pairs)} Städte in {len(per_cc)} Ländern geschrieben ({dict(src)})")


if __name__ == "__main__":
    main()
