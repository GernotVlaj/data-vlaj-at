#!/usr/bin/env python3
"""
data.vlaj.at — Bevölkerungspyramiden
====================================
Lädt den Weltbank-Komplettdatensatz „Population estimates and projections“
(ein ZIP vom Weltbank-CDN, deutlich zuverlässiger als ~300 API-Anfragen) und
schreibt die Bevölkerung nach Alter (5-Jahres-Gruppen) und Geschlecht,
1960–2050 inkl. Prognose, für alle Länder:

  docs/pyramid/index.json   Länderliste + Metadaten
  docs/pyramid/<ISO3>.json  {ages, years, male[jahr][alter], female[...]}

Das Format ist quellenneutral: Altersgruppen stehen als Liste in den Daten,
das Frontend zeichnet so viele Balken, wie es Gruppen gibt. Ein späterer
Umstieg auf UN-Einzeljahre (0…100+) braucht nur ein anderes Skript.

Bei Download- oder Formatfehlern wird nichts geschrieben (Exit-Code 1).

Läuft monatlich via .github/workflows/update-pyramid.yml
Lokal: pip install requests && python pipeline/fetch_pyramid.py
"""

import csv, io, json, sys, zipfile
from datetime import datetime, timezone
from pathlib import Path

try:
    import requests
    from wb import log
except ImportError:
    print("Bitte 'pip install requests' ausführen")
    sys.exit(1)

ZIP_URL  = "https://databankfiles.worldbank.org/public/ddpext_download/Population-Estimates_CSV.zip"
DATA_CSV = "Population-EstimatesCSV.csv"
CTRY_CSV = "Population-EstimatesCountry.csv"
OUT_DIR  = Path(__file__).resolve().parent.parent / "docs" / "pyramid"

START_YEAR, END_YEAR = 1960, 2050
YEARS = list(range(START_YEAR, END_YEAR + 1))
LAST_ESTIMATE_YEAR = datetime.now(timezone.utc).year - 1

GROUPS = ["0004", "0509", "1014", "1519", "2024", "2529", "3034", "3539",
          "4044", "4549", "5054", "5559", "6064", "6569", "7074", "7579", "80UP"]
AGES   = [f"{int(g[:2])}–{int(g[2:])}" if g != "80UP" else "80+" for g in GROUPS]
CODES  = {f"SP.POP.{g}.{s}": (s, i) for i, g in enumerate(GROUPS) for s in ("MA", "FE")}

# Aggregate ganz oben in der Liste. Welt direkt von der Weltbank, Europa und
# Afrika als Summe der Länder nach UN-Abgrenzung (die WB-Regionen passen nicht:
# „Europe & Central Asia“ enthält Zentralasien, „Sub-Saharan Africa“ kein Nordafrika).
EUROPE = ["ALB","AND","AUT","BLR","BEL","BIH","BGR","CHI","HRV","CZE","DNK","EST","FRO",
          "FIN","FRA","DEU","GIB","GRC","HUN","ISL","IRL","IMN","ITA","XKX","LVA","LIE",
          "LTU","LUX","MLT","MDA","MCO","MNE","NLD","MKD","NOR","POL","PRT","ROU","RUS",
          "SMR","SRB","SVK","SVN","ESP","SWE","CHE","UKR","GBR"]
NORTH_AFRICA = ["DZA","EGY","LBY","MAR","TUN","DJI"]   # + alle Länder der Region SSF
AGGREGATES = [   # (Kürzel, Name, Icon)
    ("WLD", "Welt",   "🌐"),
    ("EUR", "Europa", "🌍"),
    ("AFR", "Afrika", "🌍"),
]

REGIONS = {   # Weltbank-Regionsname → Kürzel (wie in der WB-API)
    "Europe & Central Asia": "ECS", "North America": "NAC",
    "Latin America & Caribbean": "LCN", "East Asia & Pacific": "EAS",
    "South Asia": "SAS", "Middle East & North Africa": "MEA",
    "Middle East, North Africa, Afghanistan & Pakistan": "MEA",
    "Sub-Saharan Africa": "SSF",
}


def download() -> zipfile.ZipFile:
    last = None
    for attempt in range(4):
        try:
            r = requests.get(ZIP_URL, timeout=300,
                             headers={"User-Agent": "data.vlaj.at-pipeline"})
            r.raise_for_status()
            return zipfile.ZipFile(io.BytesIO(r.content))
        except (requests.RequestException, zipfile.BadZipFile) as e:
            last = e
            log(f"  Download-Versuch {attempt + 1} fehlgeschlagen: {e}")
    raise RuntimeError(f"Download fehlgeschlagen: {last}")


def read_csv(zf: zipfile.ZipFile, name: str):
    with zf.open(name) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))


def num(v):
    try:
        return int(round(float(v)))
    except (TypeError, ValueError):
        return None


def main():
    log(f"=== Pyramiden {START_YEAR}–{END_YEAR}, {len(GROUPS)} Altersgruppen ===")
    try:
        log("Lade Weltbank-Datensatz…")
        zf = download()
        countries = []
        for c in read_csv(zf, CTRY_CSV):
            region = REGIONS.get(c.get("Region", "").strip())
            if not region:                       # Aggregate haben keine Region
                continue
            countries.append({"iso3": c["Country Code"], "iso2": c.get("2-alpha code", "").strip(),
                              "name": c.get("Short Name") or c.get("Table Name"), "region": region})
        if len(countries) < 150:
            raise RuntimeError(f"nur {len(countries)} Länder in der Länderliste – Format geändert?")
        known = {c["iso3"] for c in countries}

        # data[iso3]["MA"|"FE"][jahr_idx][gruppe] = Wert
        data = {}
        found = set()
        for row in read_csv(zf, DATA_CSV):
            code = row.get("Indicator Code")
            if code not in CODES or row.get("Country Code") not in known | {"WLD"}:
                continue
            sex, gi = CODES[code]
            found.add(code)
            d = data.setdefault(row["Country Code"],
                                {s: [[None] * len(GROUPS) for _ in YEARS] for s in ("MA", "FE")})
            for yi, y in enumerate(YEARS):
                d[sex][yi][gi] = num(row.get(str(y)))
        missing = set(CODES) - found
        if missing:
            raise RuntimeError(f"Indikatoren fehlen im Datensatz: {sorted(missing)[:5]}")
    except (RuntimeError, KeyError) as e:
        log(f"✗ Abbruch: {e} – bestehende Dateien bleiben unverändert")
        sys.exit(1)

    # Europa / Afrika summieren
    members = {
        "EUR": [i for i in EUROPE if i in known],
        "AFR": [c["iso3"] for c in countries if c["region"] == "SSF"] + [i for i in NORTH_AFRICA if i in known],
    }
    for agg, isos in members.items():
        rows = [data[i] for i in isos if i in data]
        data[agg] = {s: [[sum(r[s][yi][gi] or 0 for r in rows) for gi in range(len(GROUPS))]
                         for yi in range(len(YEARS))] for s in ("MA", "FE")}
        log(f"{agg}: Summe aus {len(rows)} Ländern")
    for iso, name, icon in AGGREGATES:
        countries.append({"iso3": iso, "iso2": "", "name": name, "region": "AGG", "icon": icon,
                          "members": len(members.get(iso, [])) or None})

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    ref = YEARS.index(min(LAST_ESTIMATE_YEAR, END_YEAR))
    with_data = 0
    for c in countries:
        d = data.get(c["iso3"])
        c["hasData"] = bool(d) and sum(v or 0 for v in d["MA"][ref] + d["FE"][ref]) > 0
        path = OUT_DIR / f"{c['iso3']}.json"
        if not c["hasData"]:
            path.unlink(missing_ok=True)
            continue
        with_data += 1
        out = {"iso3": c["iso3"], "ages": AGES, "years": YEARS, "male": d["MA"], "female": d["FE"]}
        path.write_text(json.dumps(out, separators=(",", ":")))

    index = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "Weltbank: Population estimates and projections (SP.POP.<Alter>.MA/FE)",
        "years": YEARS,
        "lastEstimateYear": LAST_ESTIMATE_YEAR,
        "ages": AGES,
        "countries": countries,   # Aggregate zuletzt angehängt, Reihenfolge = AGGREGATES
    }
    (OUT_DIR / "index.json").write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")))
    log(f"✓ {with_data} Länder mit Daten, {len(countries) - with_data} ohne → docs/pyramid/")


if __name__ == "__main__":
    main()
