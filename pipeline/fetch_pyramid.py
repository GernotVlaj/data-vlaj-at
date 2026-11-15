#!/usr/bin/env python3
"""
data.vlaj.at — Bevölkerungspyramiden
====================================
Holt die Bevölkerung nach Alter (5-Jahres-Gruppen) und Geschlecht für alle
Länder von der Weltbank (Source 40: Population estimates and projections,
1960–2050 inkl. Prognose) und schreibt:

  docs/pyramid/index.json   Länderliste + Metadaten
  docs/pyramid/<ISO3>.json  {ages, years, male[jahr][alter], female[...]}

Das Format ist quellenneutral: Altersgruppen stehen als Liste in den Daten,
das Frontend zeichnet so viele Balken, wie es Gruppen gibt. Ein späterer
Umstieg auf UN-Einzeljahre (0…100+) braucht nur ein anderes Skript.

Schlägt ein Indikator fehl, wird nichts geschrieben (Exit-Code 1).

Läuft monatlich via .github/workflows/update-pyramid.yml
Lokal: pip install requests && python pipeline/fetch_pyramid.py
"""

import json, sys, time
from datetime import datetime, timezone
from pathlib import Path

try:
    from wb import log, wb_rows
except ImportError:
    print("Bitte 'pip install requests' ausführen")
    sys.exit(1)

OUT_DIR    = Path(__file__).resolve().parent.parent / "docs" / "pyramid"
START_YEAR = 1960
END_YEAR   = 2050
YEARS      = list(range(START_YEAR, END_YEAR + 1))
LAST_ESTIMATE_YEAR = datetime.now(timezone.utc).year - 1
PAUSE      = 1.0

GROUPS = ["0004", "0509", "1014", "1519", "2024", "2529", "3034", "3539",
          "4044", "4549", "5054", "5559", "6064", "6569", "7074", "7579", "80UP"]
AGES   = [f"{int(g[:2])}–{int(g[2:])}" if g != "80UP" else "80+" for g in GROUPS]


def fetch_countries() -> list:
    rows = wb_rows("country", per_page=400)
    out = []
    for c in rows:
        if c["region"]["id"] == "NA":          # Aggregate (Welt, EU, …)
            continue
        out.append({"iso3": c["id"], "iso2": c["iso2Code"], "name": c["name"],
                    "region": c["region"]["id"]})
    return sorted(out, key=lambda c: c["iso3"])


CHUNK = 25   # Länder pro Request – große Abfragen beantwortet die API oft nicht


def fetch_indicator(code: str, iso3s: list) -> dict:
    """→ {ISO3: {year: value}}"""
    res = {}
    for i in range(0, len(iso3s), CHUNK):
        part = iso3s[i:i + CHUNK]
        rows = wb_rows(f"country/{';'.join(part)}/indicator/{code}",
                       f"&source=40&date={START_YEAR}:{END_YEAR}", per_page=3000)
        for r in rows:
            if r.get("value") is None:
                continue
            res.setdefault(r["countryiso3code"].upper(), {})[int(r["date"])] = r["value"]
    return res


def main():
    log(f"=== Pyramiden {START_YEAR}–{END_YEAR}, {len(GROUPS)} Altersgruppen ===")
    try:
        countries = fetch_countries()
        iso3s = [c["iso3"] for c in countries]
        log(f"{len(countries)} Länder")
        # data[sex][group] = {ISO3: {year: value}}
        data = {"MA": {}, "FE": {}}
        for g in GROUPS:
            for sex in ("MA", "FE"):
                code = f"SP.POP.{g}.{sex}"
                log(f"{code}")
                data[sex][g] = fetch_indicator(code, iso3s)
                time.sleep(PAUSE)
    except RuntimeError as e:
        log(f"✗ Abbruch: {e} – bestehende Dateien bleiben unverändert")
        sys.exit(1)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with_data = 0
    for c in countries:
        iso = c["iso3"]
        def series(sex):
            return [[(lambda v: int(round(v)) if v is not None else None)
                     (data[sex][g].get(iso, {}).get(y)) for g in GROUPS] for y in YEARS]
        male, female = series("MA"), series("FE")
        ref = YEARS.index(min(LAST_ESTIMATE_YEAR, END_YEAR))
        c["hasData"] = sum(v or 0 for v in male[ref] + female[ref]) > 0
        if not c["hasData"]:
            (OUT_DIR / f"{iso}.json").unlink(missing_ok=True)
            continue
        with_data += 1
        out = {"iso3": iso, "ages": AGES, "years": YEARS, "male": male, "female": female}
        (OUT_DIR / f"{iso}.json").write_text(json.dumps(out, separators=(",", ":")))

    index = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "Weltbank: Population estimates and projections (SP.POP.<Alter>.<MA|FE>)",
        "years": YEARS,
        "lastEstimateYear": LAST_ESTIMATE_YEAR,
        "ages": AGES,
        "countries": countries,
    }
    (OUT_DIR / "index.json").write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")))
    log(f"✓ {with_data} Länder mit Daten, {len(countries) - with_data} ohne → docs/pyramid/")


if __name__ == "__main__":
    main()
