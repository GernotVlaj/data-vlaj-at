#!/usr/bin/env python3
"""
data.vlaj.at — Bevölkerungspyramiden
====================================
Quelle: UN World Population Prospects (WPP), mittlere Variante,
Bevölkerung am 1. Jänner nach Einzelalter (0 … 100+) und Geschlecht,
1950–2100. Zwei gzip-CSV-Dateien (~130 MB) vom UN-Server.

Ausgabe:
  docs/pyramid/index.json   Länderliste, Regionen, Metadaten
  docs/pyramid/<ISO3>.json  {ages, years, male[jahr][alter], female[...]}
                            Aggregate: WLD (Welt), EUR (Europa), AFR (Afrika)

Das Format ist quellenneutral: Altersgruppen stehen als Liste in den Daten.

Die UN veröffentlicht alle zwei Jahre eine neue Revision. Das Skript
probiert die neueste bekannte Revision zuerst (siehe REVISIONS) und
fällt sonst auf die vorige zurück.

Bei Download- oder Formatfehlern wird nichts geschrieben (Exit-Code 1).

Läuft monatlich via .github/workflows/update-pyramid.yml
Lokal: pip install requests && python pipeline/fetch_pyramid.py
"""

import csv, gzip, io, json, sys
from datetime import datetime, timezone
from pathlib import Path

try:
    import requests
    from wb import log
except ImportError:
    print("Bitte 'pip install requests' ausführen")
    sys.exit(1)

BASE = "https://population.un.org/wpp/assets/Excel%20Files/1_Indicator%20(Standard)/CSV_FILES"
REVISIONS = ["2026", "2024"]          # neueste zuerst
FILE = "WPP{rev}_Population1JanuaryBySingleAgeSex_Medium_{span}.csv.gz"

END_YEAR = 2100
OUT_DIR = Path(__file__).resolve().parent.parent / "docs" / "pyramid"
UA = {"User-Agent": "data.vlaj.at-pipeline"}

# Aggregate ganz oben in der Liste: UN-LocID → (Kürzel, Name, Icon)
AGGREGATES = {900: ("WLD", "Welt", "🌐"), 908: ("EUR", "Europa", "🌍"), 903: ("AFR", "Afrika", "🌍")}
# Geografische UN-Regionen → (Kürzel, deutscher Name), in Listenreihenfolge
REGIONS = {908: ("EU", "Europa"), 905: ("NA", "Nordamerika"), 918: ("NA", "Nordamerika"),
           904: ("LA", "Lateinamerika & Karibik"), 935: ("AS", "Asien"),
           903: ("AF", "Afrika"), 909: ("OC", "Ozeanien")}


def find_files():
    """→ (Revision, letztes Schätzjahr, [URL Schätzung, URL Prognose])."""
    for rev in REVISIONS:
        # Schätzung bis zum Vorjahr der Revision, Prognose ab dem Revisionsjahr
        spans = (f"1950-{int(rev) - 1}", f"{rev}-2100")
        urls = [f"{BASE}/{FILE.format(rev=rev, span=s)}" for s in spans]
        try:
            if all(requests.head(u, timeout=60, headers=UA, allow_redirects=True).status_code == 200
                   for u in urls):
                return rev, int(rev) - 1, urls
        except requests.RequestException:
            pass
        log(f"  Revision {rev} nicht verfügbar")
    raise RuntimeError("keine WPP-Revision gefunden")


def download(url: str) -> bytes:
    last = None
    for attempt in range(4):
        try:
            r = requests.get(url, timeout=600, headers=UA)
            r.raise_for_status()
            return r.content
        except requests.RequestException as e:
            last = e
            log(f"  Download-Versuch {attempt + 1} fehlgeschlagen: {e}")
    raise RuntimeError(f"Download fehlgeschlagen: {last}")


def rows(blob: bytes):
    with gzip.open(io.BytesIO(blob), "rt", encoding="utf-8-sig", newline="") as f:
        yield from csv.DictReader(f)


def main():
    try:
        rev, last_est, urls = find_files()
        log(f"=== Pyramiden aus UN WPP {rev} (Schätzung bis {last_est}) ===")
        locs = {}      # LocID → {iso3, iso2, name, type, parent}
        data = {}      # LocID → {"m": {jahr: {alter: n}}, "f": {...}}
        ages = {}      # AgeGrpStart → Label ("0" … "100+")
        years = set()
        for url in urls:
            log(f"Lade {url.rsplit('/', 1)[1]}…")
            blob = download(url)
            log(f"  {len(blob) // 1_000_000} MB, verarbeite…")
            for r in rows(blob):
                lid = int(r["LocID"])
                if lid not in locs:
                    locs[lid] = {"iso3": r["ISO3_code"], "iso2": r["ISO2_code"], "name": r["Location"],
                                 "type": r["LocTypeName"], "parent": int(r["ParentID"] or 0)}
                if r["LocTypeName"] != "Country/Area" and lid not in AGGREGATES:
                    continue
                y, a = int(r["Time"]), int(r["AgeGrpStart"])
                if y > END_YEAR:                    # Datei enthält auch den 1.1.2101
                    continue
                ages[a] = r["AgeGrp"]
                years.add(y)
                d = data.setdefault(lid, {"m": {}, "f": {}})
                for sex, col in (("m", "PopMale"), ("f", "PopFemale")):
                    d[sex].setdefault(y, {})[a] = int(round(float(r[col] or 0) * 1000))  # Werte in Tausend
            del blob
    except (RuntimeError, KeyError, ValueError, OSError) as e:
        log(f"✗ Abbruch: {e} – bestehende Dateien bleiben unverändert")
        sys.exit(1)

    years = sorted(years)
    age_keys = sorted(ages)
    labels = [ages[a] for a in age_keys]
    lid_by_iso = {l["iso3"]: lid for lid, l in locs.items() if l["type"] == "Country/Area" and l["iso3"]}
    if len(lid_by_iso) < 200 or len(age_keys) < 90 or years[0] > 1950 or years[-1] < 2100:
        log(f"✗ Unerwartetes Format: {len(lid_by_iso)} Länder, {len(age_keys)} Altersstufen, "
            f"{years[0]}–{years[-1]} – nichts geschrieben")
        sys.exit(1)

    def region_of(lid):
        for _ in range(6):                  # Land → Subregion → Region
            if lid in REGIONS or not lid:
                break
            lid = locs.get(lid, {}).get("parent", 0)
        return REGIONS.get(lid, ("XX",))[0]

    def series(lid, sex):
        d = data[lid][sex]
        return [[d.get(y, {}).get(a) for a in age_keys] for y in years]

    entries = [(lid, iso, "", name, "AGG", icon) for lid, (iso, name, icon) in AGGREGATES.items()]
    entries += [(lid, iso, locs[lid]["iso2"], locs[lid]["name"], region_of(lid), None)
                for iso, lid in sorted(lid_by_iso.items())]

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_list, written = [], set()
    for lid, iso3, iso2, name, region, icon in entries:
        male = series(lid, "m") if lid in data else None
        female = series(lid, "f") if lid in data else None
        has = bool(male) and sum(v or 0 for v in male[-1] + female[-1]) > 0
        e = {"iso3": iso3, "iso2": iso2, "name": name, "region": region, "hasData": has}
        if icon:
            e["icon"] = icon
        out_list.append(e)
        if has:
            out = {"iso3": iso3, "ages": labels, "years": years, "male": male, "female": female}
            (OUT_DIR / f"{iso3}.json").write_text(json.dumps(out, separators=(",", ":")))
            written.add(f"{iso3}.json")

    # Dateien von Ländern, die es nicht mehr gibt (z. B. alte WB-Kürzel), entfernen
    for p in OUT_DIR.glob("*.json"):
        if p.name != "index.json" and p.name not in written:
            p.unlink()

    index = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": f"UN World Population Prospects {rev}, mittlere Variante",
        "years": years,
        "lastEstimateYear": last_est,
        "refYear": min(datetime.now(timezone.utc).year, years[-1]),
        "ages": labels,
        "regions": [{"id": k, "name": n} for k, n in dict(REGIONS.values()).items()],
        "countries": out_list,
    }
    (OUT_DIR / "index.json").write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")))
    log(f"✓ {len(written)} Dateien geschrieben, "
        f"{sum(1 for e in out_list if not e['hasData'])} ohne Daten, "
        f"{sum(1 for e in out_list if e['region'] == 'XX')} ohne Region")


if __name__ == "__main__":
    main()
