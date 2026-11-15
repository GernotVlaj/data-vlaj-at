"""
Gemeinsame Helfer für die Weltbank-API (fetch_data.py, fetch_pyramid.py).
"""

import time
from datetime import datetime

import requests

WB_BASE    = "https://api.worldbank.org/v2"
WB_TIMEOUT = 60                # Sekunden pro Request
WB_RETRIES = 5                 # Versuche pro Request
WB_BACKOFF = [5, 15, 30, 60]   # Wartezeit vor Versuch 2, 3, 4, 5


def log(msg):
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def wb_get(url: str):
    """GET mit Retries. Gibt die geparste JSON-Antwort zurück oder wirft RuntimeError."""
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


def wb_rows(path: str, params: str = "", per_page: int = 10000) -> list:
    """Alle Datenzeilen eines WB-Endpunkts, über alle Seiten. Wirft bei Fehler."""
    rows, page = [], 1
    while True:
        url = f"{WB_BASE}/{path}?format=json&per_page={per_page}&page={page}{params}"
        data = wb_get(url)
        if not isinstance(data, list) or not data:
            raise RuntimeError("unerwartete Antwort")
        if "message" in data[0]:      # API-Fehlermeldung, z. B. Indikator archiviert
            raise RuntimeError(str(data[0]["message"])[:120])
        rows.extend((data[1] if len(data) > 1 else None) or [])
        if page >= int(data[0].get("pages") or 1):
            return rows
        page += 1
