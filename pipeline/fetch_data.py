#!/usr/bin/env python3
"""
data.vlaj.at — Datenpipeline
============================
Holt alle Indikatoren von der Weltbank-API, füllt Lücken mit statischen
Fallback-Daten (pipeline/fallbacks.json), berechnet abgeleitete Werte
(EUR-Umrechnung, Schulden absolut) und schreibt docs/data.json.

Robustheit:
  * Jeder Request wird bei Fehlern mehrfach mit Backoff wiederholt.
  * Schlägt ein Indikator trotzdem fehl, bleiben die Werte aus dem
    letzten erfolgreichen Lauf (bestehende docs/data.json) erhalten.
  * Kommt gar nichts von der API, wird nichts geschrieben (Exit-Code 1).

Läuft wöchentlich via .github/workflows/update-data.yml
Lokal: pip install requests && python pipeline/fetch_data.py
"""

import json, sys, time
from datetime import datetime, timezone
from pathlib import Path

try:
    import requests
except ImportError:
    print("Bitte 'pip install requests' ausführen")
    sys.exit(1)

# ── Konfiguration ─────────────────────────────────────────
ROOT          = Path(__file__).resolve().parent.parent
OUTPUT_FILE   = ROOT / "docs" / "data.json"
FALLBACK_FILE = Path(__file__).resolve().parent / "fallbacks.json"

START_YEAR = 1990
END_YEAR   = datetime.now(timezone.utc).year - 1   # letztes abgeschlossenes Jahr
YEARS      = list(range(START_YEAR, END_YEAR + 1))

WB_TIMEOUT = 30                # Sekunden pro Request
WB_PAUSE   = 1.0               # Pause zwischen Indikatoren
WB_RETRIES = 5                 # Versuche pro Request
WB_BACKOFF = [5, 15, 30, 60]   # Wartezeit vor Versuch 2, 3, 4, 5

# ── Länder ────────────────────────────────────────────────
ISO2_TO_3 = {
    "AT":"AUT","DE":"DEU","FR":"FRA","IT":"ITA","ES":"ESP","GR":"GRC",
    "GB":"GBR","SE":"SWE","CH":"CHE","CZ":"CZE","BE":"BEL","HR":"HRV",
    "US":"USA","JP":"JPN","CN":"CHN","IN":"IND","BR":"BRA","CA":"CAN",
    "MX":"MEX","NG":"NGA","ZA":"ZAF","ID":"IDN","SA":"SAU","ET":"ETH",
    "BD":"BGD","PK":"PAK","RU":"RUS","TR":"TUR",
}
COUNTRIES = list(ISO2_TO_3)

# ── Weltbank-Indikatoren: topic → (WB-Code, Nachkommastellen) ──
# Topics mit Suffix _usd sind Zwischenwerte für die EUR-Umrechnung.
WB_INDICATORS = {
    "debt":         ("GC.DOD.TOTL.GD.ZS",    1),
    "deficit":      ("GC.NLD.TOTL.GD.ZS",    1),
    "taxrev":       ("GC.TAX.TOTL.GD.ZS",    1),
    "interest":     ("GC.XPN.INTP.ZS",       1),
    "gdp":          ("NY.GDP.MKTP.KD.ZG",    1),
    "infl":         ("FP.CPI.TOTL.ZG",       1),
    "unemp":        ("SL.UEM.TOTL.ZS",       1),
    "gdppc_usd":    ("NY.GDP.PCAP.CD",       2),
    "gdpAbs_usd":   ("NY.GDP.MKTP.CD",       0),
    "productivity": ("SL.GDP.PCAP.EM.KD",    0),
    "poverty":      ("SI.POV.NAHC",          1),
    "netmigration": ("SM.POP.NETM",          0),
    "physicians":   ("SH.MED.PHYS.ZS",       2),
    "hospitalbed":  ("SH.MED.BEDS.ZS",       1),
    "obesity":      ("SH.STA.OWGH.ZS",       1),
    "alcohol":      ("SH.ALC.PCAP.LI",       1),
    "tobacco":      ("SH.PRV.SMOK",          1),
    "gini":         ("SI.POV.GINI",          1),
    "lifeexp":      ("SP.DYN.LE00.IN",       1),
    "healthexp":    ("SH.XPD.CHEX.GD.ZS",    1),
    "educexp":      ("SE.XPD.TOTL.GD.ZS",    1),
    "pop":          ("SP.POP.TOTL",          0),
    "popgrowth":    ("SP.POP.GROW",          2),
    "fertility":    ("SP.DYN.TFRT.IN",       2),
    "aged":         ("SP.POP.65UP.TO.ZS",    1),
    "medage":       ("SP.POP.DPND",          1),
    "rdexp":        ("GB.XPD.RSDV.GD.ZS",    2),
    "tertiary":     ("SE.TER.ENRR",          1),
    "co2":          ("EN.GHG.CO2.PC.CE.AR5", 1),
    "renewables":   ("EG.FEC.RNEW.ZS",       1),
    "nuclear":      ("EG.ELC.NUCL.ZS",       1),
    "energyimport": ("EG.IMP.CONS.ZS",       1),
    "water":        ("ER.H2O.FWTL.ZS",       1),
    "forestarea":   ("AG.LND.FRST.ZS",       1),
    "exports":      ("NE.EXP.GNFS.ZS",       1),
    "imports":      ("NE.IMP.GNFS.ZS",       1),
    "cab":          ("BN.CAB.XOKA.GD.ZS",    1),
    "fdi":          ("BX.KLT.DINV.WD.GD.ZS", 1),
}
# Euro-Raum: offizieller Wechselkurs EUR je USD (Jahresdurchschnitt)
WB_EURUSD = ("EMU", "PA.NUS.FCRF")


# ── Hilfsfunktionen ───────────────────────────────────────
def log(msg):
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def wb_get(url: str):
    """GET mit Retries. Gibt die geparste JSON-Antwort zurück oder wirft."""
    last = None
    for attempt in range(WB_RETRIES):
        if attempt:
            wait = WB_BACKOFF[min(attempt - 1, len(WB_BACKOFF) - 1)]
            log(f"    Versuch {attempt + 1}/{WB_RETRIES} in {wait}s ({last})")
            time.sleep(wait)
        try:
            r = requests.get(url, timeout=WB_TIMEOUT,
                             headers={"User-Agent": "data.vlaj.at-pipeline"})
            if r.status_code >= 500 or r.status_code == 429:
                last = f"HTTP {r.status_code}"
                continue
            r.raise_for_status()
            return r.json()
        except (requests.RequestException, ValueError) as e:
            last = type(e).__name__
    raise RuntimeError(last or "unbekannter Fehler")


def fetch_wb(indicator: str, iso3_codes: list) -> dict:
    """Ein Indikator für alle Länder → {ISO3: {year: value}}. Wirft bei Fehler."""
    url = (f"https://api.worldbank.org/v2/country/{';'.join(iso3_codes)}"
           f"/indicator/{indicator}?format=json&per_page=5000"
           f"&date={START_YEAR}:{END_YEAR}")
    data = wb_get(url)
    if not isinstance(data, list) or not data:
        raise RuntimeError("unerwartete Antwort")
    if "message" in data[0]:          # API-Fehlermeldung, z. B. Indikator archiviert
        raise RuntimeError(str(data[0]["message"])[:120])
    if data[0].get("pages", 1) > 1:
        raise RuntimeError("Antwort hat mehrere Seiten – per_page erhöhen")
    result = {}
    for row in (data[1] if len(data) > 1 else None) or []:
        if row.get("value") is None:
            continue
        iso3 = (row.get("countryiso3code") or row.get("country", {}).get("id", "")).upper()
        try:
            year = int(row["date"])
        except (KeyError, ValueError):
            continue
        result.setdefault(iso3, {})[year] = float(row["value"])
    return result


def load_previous() -> dict:
    """Werte aus der letzten data.json als {cc: {topic: {year: val}}}."""
    if not OUTPUT_FILE.exists():
        return {}
    try:
        old = json.loads(OUTPUT_FILE.read_text())
        years = old["years"]
        return {cc: {t: dict(zip(years, arr)) for t, arr in topics.items()}
                for cc, topics in old["countries"].items()}
    except Exception as e:
        log(f"⚠ Alte data.json nicht lesbar ({e}) – starte ohne")
        return {}


def rnd(v, dec):
    if v is None:
        return None
    return int(round(v)) if dec == 0 else round(v, dec)


# ── Hauptprogramm ─────────────────────────────────────────
def main():
    fb = json.loads(FALLBACK_FILE.read_text())
    fb_start = fb["startYear"]
    prev = load_previous()
    iso3_list = list(ISO2_TO_3.values())

    def fb_val(topic, cc, year):
        arr = fb["topics"].get(topic, {}).get(cc)
        i = year - fb_start
        return arr[i] if arr and 0 <= i < len(arr) else None

    log(f"=== Pipeline {START_YEAR}–{END_YEAR}: {len(COUNTRIES)} Länder, "
        f"{len(WB_INDICATORS)} Indikatoren ===")

    data = {cc: {} for cc in COUNTRIES}     # {cc: {topic: {year: val}}}
    src  = {}                               # {topic: {cc: 'api'|'prev'|'fallback'|'calc'|'none'}}
    ok, failed = [], []

    # ── 1. Weltbank ──────────────────────────────────────
    for topic, (code, dec) in WB_INDICATORS.items():
        log(f"{code} → {topic}")
        try:
            raw = fetch_wb(code, iso3_list)
            ok.append(topic)
        except Exception as e:
            log(f"  ✗ {e} – behalte alte Werte/Fallback")
            raw = None
            failed.append(topic)
        src[topic] = {}
        for cc in COUNTRIES:
            api = (raw or {}).get(ISO2_TO_3[cc], {})
            old = prev.get(cc, {}).get(topic, {})
            vals, used = {}, set()
            for y in YEARS:
                if api.get(y) is not None:
                    vals[y] = rnd(api[y], dec); used.add("api")
                elif raw is None and old.get(y) is not None:
                    vals[y] = old[y]; used.add("prev")
                elif fb_val(topic, cc, y) is not None:
                    vals[y] = fb_val(topic, cc, y); used.add("fallback")
                else:
                    vals[y] = None
            data[cc][topic] = vals
            src[topic][cc] = ("api" if "api" in used else "prev" if "prev" in used
                              else "fallback" if "fallback" in used else "none")
        time.sleep(WB_PAUSE)

    log(f"Weltbank: {len(ok)} OK, {len(failed)} fehlgeschlagen"
        + (f" ({', '.join(failed)})" if failed else ""))
    if not ok:
        log("✗ Keine einzige API-Antwort – data.json bleibt unverändert")
        sys.exit(1)

    # ── 2. Nur statische Daten (keine WB-Quelle) ─────────
    for topic in fb["topics"]:
        if topic in WB_INDICATORS:
            continue
        src[topic] = {}
        for cc in COUNTRIES:
            data[cc][topic] = {y: fb_val(topic, cc, y) for y in YEARS}
            has = any(v is not None for v in data[cc][topic].values())
            src[topic][cc] = "fallback" if has else "none"

    # ── 3. Wechselkurs EUR/USD ───────────────────────────
    eurusd = {fb_start + i: v for i, v in enumerate(fb["eurusd"])}
    try:
        raw = fetch_wb(WB_EURUSD[1], [WB_EURUSD[0]])
        for y, eur_per_usd in raw.get(WB_EURUSD[0], {}).items():
            if y >= 1999 and eur_per_usd:          # Euro erst ab 1999
                eurusd[y] = round(1 / eur_per_usd, 4)
        log("EUR/USD: Weltbank-Kurse übernommen")
    except Exception as e:
        log(f"  ⚠ EUR/USD von der Weltbank nicht verfügbar ({e}) – nutze Tabelle")
    last_rate = eurusd[max(eurusd)]
    rate = lambda y: eurusd.get(y, last_rate)

    # ── 4. Abgeleitete Werte ─────────────────────────────
    for t in ("gdppc", "gdpAbs", "debtAbs"):
        src[t] = {}
    for cc in COUNTRIES:
        d = data[cc]
        usd_pc, usd_abs = d.pop("gdppc_usd"), d.pop("gdpAbs_usd")
        d["gdppc"]  = {y: rnd(usd_pc[y] / rate(y), 0) if usd_pc[y] else None for y in YEARS}
        d["gdpAbs"] = {y: rnd(usd_abs[y] / rate(y) / 1e9, 0) if usd_abs[y] else None for y in YEARS}
        d["debtAbs"] = {y: rnd(d["debt"][y] / 100 * d["gdpAbs"][y], 0)
                        if d["debt"][y] is not None and d["gdpAbs"][y] else None for y in YEARS}
        src["gdppc"][cc]   = src["gdppc_usd"][cc]
        src["gdpAbs"][cc]  = src["gdpAbs_usd"][cc]
        src["debtAbs"][cc] = "calc"
        # Fehlte die USD-Quelle in diesem Lauf, alte EUR-Werte behalten
        for t in ("gdppc", "gdpAbs", "debtAbs"):
            old = prev.get(cc, {}).get(t, {})
            for y in YEARS:
                if d[t][y] is None and old.get(y) is not None:
                    d[t][y] = old[y]
                    if src[t][cc] == "none":
                        src[t][cc] = "prev"
    src.pop("gdppc_usd"); src.pop("gdpAbs_usd")

    # ── 5. Ausgabe ───────────────────────────────────────
    output = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "years":     YEARS,
        "countries": {cc: {t: [vals[y] for y in YEARS] for t, vals in sorted(topics.items())}
                      for cc, topics in data.items()},
        "sources":   src,
        "failed":    failed,
    }
    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = OUTPUT_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")))
    tmp.replace(OUTPUT_FILE)
    log(f"✓ docs/data.json geschrieben ({OUTPUT_FILE.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
