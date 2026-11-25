// ═══════════════════════════════════════════════════════════
//  data.vlaj.at — klima.js
//  Klimadiagramme: eigenes Topic (mode:'klima') mit Städte-Suche,
//  Diagramm nach Walter/Lieth (oder Balken), Klimatabelle, Kennzahlen.
//  Daten: klima/index.json + klima/<CC>.json
//  (erzeugt von pipeline/fetch_klima.py, Normalperiode 1991–2020)
// ═══════════════════════════════════════════════════════════

const KL_MON = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const KL_RED = '#E8453C', KL_BLUE = '#378ADD', KL_BAR = '#38BDF8', KL_DEEP = '#1D4F91';
const KL_DEFAULT = 2761369;   // Wien (GeoNames-ID)
const KL_FAV_AT = 8;          // so viele österreichische Städte unter „Favoriten“
const KL_MAX_HITS = 300;      // Suchtreffer in der Liste
const KL_KG = {
  Af: 'Tropischer Regenwald', Am: 'Tropisches Monsunklima', Aw: 'Tropische Savanne', As: 'Tropische Savanne',
  BWh: 'Heiße Wüste', BWk: 'Kalte Wüste', BSh: 'Heiße Steppe', BSk: 'Kalte Steppe',
  Csa: 'Mittelmeerklima, heißer Sommer', Csb: 'Mittelmeerklima, warmer Sommer', Csc: 'Mittelmeerklima, kühler Sommer',
  Cwa: 'Subtropisch, wintertrocken', Cwb: 'Subtropisches Hochland', Cwc: 'Subpolares Hochland',
  Cfa: 'Feucht-subtropisch', Cfb: 'Ozeanisch / gemäßigt', Cfc: 'Subpolar-ozeanisch',
  Dsa: 'Kontinental, sommertrocken', Dsb: 'Kontinental, sommertrocken', Dsc: 'Subarktisch, sommertrocken', Dsd: 'Subarktisch, sommertrocken',
  Dwa: 'Kontinental, wintertrocken', Dwb: 'Kontinental, wintertrocken', Dwc: 'Subarktisch, wintertrocken', Dwd: 'Subarktisch, extrem kalt',
  Dfa: 'Feucht-kontinental, heißer Sommer', Dfb: 'Feucht-kontinental', Dfc: 'Subarktisch (boreal)', Dfd: 'Subarktisch, extrem kalt',
  ET: 'Tundra', EF: 'Eisklima',
};

const kl = {
  active: false,
  index: null,       // klima/index.json (cities als Objekte)
  byGid: new Map(),
  cache: {},         // Ländercode → {gid: Normalwerte}
  gid: KL_DEFAULT,
  mode: 'wl',        // 'wl' = Walter/Lieth, 'bar' = Balken
  search: '',
};

// ── Helfer ────────────────────────────────────────────────
const klFmt = (v, d = 1) => v.toLocaleString('de-AT', { minimumFractionDigits: d, maximumFractionDigits: d });
const klSum = a => a.reduce((s, v) => s + v, 0);
const klAvg = a => klSum(a) / a.length;
const klCss = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const klEsc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const klNorm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
function klDms(v, pos, neg) {
  const a = Math.abs(v), d = Math.floor(a), m = Math.round((a - d) * 60);
  return `${d}°${String(m).padStart(2, '0')}′${v >= 0 ? pos : neg}`;
}
let _klNames;
function klCountry(cc) {
  try {
    _klNames = _klNames || new Intl.DisplayNames(['de'], { type: 'region' });
    return _klNames.of(cc) || cc;
  } catch(e) { return cc; }
}
const klCity = gid => kl.byGid.get(+gid);
const klLabel = c => c.admin ? `${c.name} (${c.admin})` : c.name;

async function klLoadIndex() {
  if(kl.index) return kl.index;
  const r = await fetch('klima/index.json');
  if(!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  j.cities = j.cities.map(([gid, name, cc, admin, pop, capital, alt]) => {
    const country = klCountry(cc);
    return { gid, name, cc, admin, pop, capital, country, key: klNorm(`${name} ${alt} ${country} ${admin}`) };
  });
  j.cities.forEach(c => kl.byGid.set(c.gid, c));
  return (kl.index = j);
}
async function klLoadCountry(cc) {
  if(kl.cache[cc]) return kl.cache[cc];
  const r = await fetch(`klima/${cc}.json`);
  if(!r.ok) throw new Error('HTTP ' + r.status);
  return (kl.cache[cc] = await r.json());
}

// ── Modus betreten / verlassen ────────────────────────────
async function enterKlima() {
  kl.active = true;
  document.body.classList.add('kl-mode');
  if(chartInst) { chartInst.destroy(); chartInst = null; }
  setEl('stats', '');
  showOverlay('Lade Klimadaten…');
  try {
    await klLoadIndex();
    klReadHash();
    if(!klCity(kl.gid)) kl.gid = KL_DEFAULT;
    klSetModeButtons();
    klBuildList();
    await klSelect(kl.gid);
  } catch(e) {
    console.error('Klima:', e);
    showOverlay('Klimadaten konnten nicht geladen werden.');
  }
}

function exitKlima() {
  if(!kl.active) return;
  kl.active = false;
  document.body.classList.remove('kl-mode');
  if(location.hash.startsWith('#klima')) history.replaceState(null, '', location.pathname + location.search);
}

function klReadHash() {
  const m = location.hash.match(/^#klima(?:\/(\d+))?/);
  if(m?.[1]) kl.gid = +m[1];
}
function klWriteHash() { history.replaceState(null, '', `#klima/${kl.gid}`); }

// ── Sidebar ───────────────────────────────────────────────
function klRow(c) {
  return `<label class="cb-row pyr-row"><input type="radio" name="klCity" value="${c.gid}" ${c.gid === kl.gid ? 'checked' : ''}
    onchange="klSelect(${c.gid})"><span class="cb-label">${pyrFlag(c.cc)} ${klEsc(klLabel(c))}</span></label>`;
}

function klBuildList() {
  const all = kl.index.cities, term = klNorm(kl.search.trim());
  let html = '';
  if(term) {
    const hits = all.filter(c => c.key.includes(term))
      .sort((a, b) => (klNorm(b.name).startsWith(term) - klNorm(a.name).startsWith(term)) || b.pop - a.pop)
      .slice(0, KL_MAX_HITS);
    const byCc = new Map();
    hits.forEach(c => { if(!byCc.has(c.cc)) byCc.set(c.cc, []); byCc.get(c.cc).push(c); });
    for(const [cc, rows] of byCc) html += `<div class="cb-group-label">${klEsc(klCountry(cc))}</div>` + rows.map(klRow).join('');
    if(hits.length === KL_MAX_HITS) html += `<div class="pyr-empty">Weitere Treffer – Suche verfeinern</div>`;
  } else {
    const cur = klCity(kl.gid);
    const at = all.filter(c => c.cc === 'AT').sort((a, b) => b.pop - a.pop).slice(0, KL_FAV_AT);
    const favCc = new Set(REAL_CODES.filter(cc => cc !== 'AT'));
    const caps = all.filter(c => c.capital).sort((a, b) => a.name.localeCompare(b.name, 'de'));
    const favCaps = caps.filter(c => favCc.has(c.cc));
    if(cur && !at.includes(cur) && !favCaps.includes(cur)) html += `<div class="cb-group-label">Ausgewählt</div>` + klRow(cur);
    html += `<div class="cb-group-label">Favoriten</div>` + [...at, ...favCaps].map(klRow).join('');
    html += `<div class="cb-group-label">Hauptstädte</div>` + caps.filter(c => !favCc.has(c.cc) && c.cc !== 'AT').map(klRow).join('');
  }
  setEl('klList', html || `<div class="pyr-empty">Keine Stadt gefunden</div>`);
}

function klOnSearch(v) { kl.search = v; klBuildList(); $('klList').scrollTop = 0; }

function klSetMode(m) { kl.mode = m; klSetModeButtons(); klRender(); }
function klSetModeButtons() {
  $('klWlBtn')?.classList.toggle('on', kl.mode === 'wl');
  $('klBarBtn')?.classList.toggle('on', kl.mode === 'bar');
}

async function klSelect(gid) {
  const c = klCity(gid);
  if(!c) return;
  kl.gid = c.gid;
  try {
    await klLoadCountry(c.cc);
  } catch(e) {
    showOverlay('Daten für diese Stadt konnten nicht geladen werden.');
    return;
  }
  hideOverlay();
  klWriteHash();
  klRender();
}

const klData = () => { const c = klCity(kl.gid); return c && kl.cache[c.cc]?.[c.gid]; };

// ── Diagramm ──────────────────────────────────────────────
// Walter/Lieth: 10 °C ≙ 20 mm; über 100 mm Maßstab 1:10 (10 °C ≙ 200 mm)
const klP2T = p => p <= 100 ? p / 2 : 50 + (p - 100) / 20;
const klT2P = v => v <= 50 ? v * 2 : 100 + (v - 50) * 20;

function klDraw() {
  const d = klData(), cv = $('klCanvas');
  if(!d || !cv || !kl.active) return;
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  if(!W || !H) return;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);

  const bar = kl.mode === 'bar' && d.tx;
  const text2 = klCss('--text2'), text3 = klCss('--text3'), grid = klCss('--border2');
  const pt = d.p.map(klP2T);
  const lows = bar ? d.tn : d.t, highs = bar ? d.tx : d.t;
  const tLo = Math.min(0, Math.floor(Math.min(...lows) / 10) * 10);
  const tHi = Math.max(30, Math.ceil(Math.max(...highs, ...pt) / 10) * 10);
  const narrow = W < 480;
  const L = narrow ? 34 : 46, R = narrow ? 38 : 50, T = 28, B = 26;
  const pw = W - L - R, ph = H - T - B;
  const y = v => T + ph * (1 - (v - tLo) / (tHi - tLo));
  const x = i => L + pw * (i + .5) / 12;

  // Gitter und Achsen
  g.font = `${narrow ? 10 : 11}px "DM Mono", monospace`;
  g.lineWidth = 1;
  for(let v = tLo; v <= tHi; v += 10) {
    g.strokeStyle = v === 0 ? text3 : grid;
    g.beginPath(); g.moveTo(L, y(v) + .5); g.lineTo(L + pw, y(v) + .5); g.stroke();
    if(v <= 50) { g.fillStyle = KL_RED; g.textAlign = 'right'; g.fillText(v, L - 6, y(v) + 4); }
    if(v >= 0) { g.fillStyle = KL_BLUE; g.textAlign = 'left'; g.fillText(klT2P(v), L + pw + 6, y(v) + 4); }
  }
  g.font = '600 11px "DM Sans", sans-serif';
  g.fillStyle = KL_RED; g.textAlign = 'right'; g.fillText('°C', L - 6, T - 12);
  g.fillStyle = KL_BLUE; g.textAlign = 'left'; g.fillText('mm', L + pw + 6, T - 12);
  g.font = `${narrow ? 10 : 11}px "DM Sans", sans-serif`; g.fillStyle = text2; g.textAlign = 'center';
  KL_MON.forEach((m, i) => g.fillText(narrow ? m[0] : m, x(i), H - 8));
  if(tHi > 50) {
    g.setLineDash([3, 3]); g.strokeStyle = KL_BLUE; g.globalAlpha = .6;
    g.beginPath(); g.moveTo(L, y(50) + .5); g.lineTo(L + pw, y(50) + .5); g.stroke();
    g.setLineDash([]); g.globalAlpha = 1;
  }
  const line = arr => { g.beginPath(); arr.forEach((v, i) => i ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v))); };

  if(bar) {
    const bw = pw / 12 * .62;
    d.p.forEach((p, i) => { g.fillStyle = KL_BAR; g.fillRect(x(i) - bw / 2, y(pt[i]), bw, y(0) - y(pt[i])); });
    g.beginPath();
    d.tx.forEach((v, i) => i ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v)));
    for(let i = 11; i >= 0; i--) g.lineTo(x(i), y(d.tn[i]));
    g.closePath(); g.fillStyle = 'rgba(232,69,60,.22)'; g.fill();
  } else {
    // humid: blaue Schraffur, arid: rote Punkte, > 100 mm: Vollfläche
    const lerp = (a, f) => { const i = Math.min(10, Math.floor(f)); return a[i] + (a[i + 1] - a[i]) * (f - i); };
    const step = narrow ? 2.5 : 3;
    for(let px = x(0); px <= x(11) + .01; px += step) {
      const f = (px - x(0)) / (x(11) - x(0)) * 11, t = lerp(d.t, f), p = lerp(pt, f);
      if(p > t) {
        g.strokeStyle = KL_BLUE; g.globalAlpha = .75;
        g.beginPath(); g.moveTo(px, y(Math.min(p, 50))); g.lineTo(px, y(t)); g.stroke();
        if(p > 50) { g.globalAlpha = 1; g.fillStyle = KL_DEEP; g.fillRect(px - step / 2, y(p), step, y(50) - y(p)); }
      } else {
        g.fillStyle = KL_RED; g.globalAlpha = .85;
        for(let py = y(t) + 2.5; py < y(p) - .5; py += 4) g.fillRect(px - .75, py, 1.5, 1.5);
      }
      g.globalAlpha = 1;
    }
    g.strokeStyle = KL_BLUE; g.lineWidth = 2; line(pt); g.stroke();
  }
  g.strokeStyle = KL_RED; g.lineWidth = 2.5; g.lineJoin = 'round'; line(d.t); g.stroke();
  if(bar) d.t.forEach((v, i) => { g.fillStyle = KL_RED; g.beginPath(); g.arc(x(i), y(v), 3.5, 0, 7); g.fill(); });

  // Kopfzeile nach Walter/Lieth: Jahresmittel und Jahressumme
  g.font = '500 11px "DM Mono", monospace'; g.fillStyle = text2; g.textAlign = 'center';
  g.fillText(`${klFmt(klAvg(d.t))} °C  ·  ${Math.round(klSum(d.p)).toLocaleString('de-AT')} mm`, L + pw / 2, T - 12);
}

// ── Klimatabelle ──────────────────────────────────────────
function klTable(d) {
  const arid = d.t.map((t, i) => t * 2 > d.p[i]);
  const row = (lbl, col, arr, yr, dec, hl, mark, yrDec = dec) => {
    const mx = Math.max(...arr), mn = Math.min(...arr);
    return `<tr><th><span class="kl-dot" style="background:${col}"></span>${lbl}</th>${arr.map((v, i) => {
      const cls = [hl && v === mx ? 'hi' : '', hl && v === mn ? 'lo' : '', mark && arid[i] ? 'arid' : ''].filter(Boolean).join(' ');
      return `<td${cls ? ` class="${cls}"` : ''}>${klFmt(v, dec)}</td>`;
    }).join('')}<td class="yr">${klFmt(yr, yrDec)}</td></tr>`;
  };
  const pDec = d.p.some(v => v < 10 && v % 1) ? 1 : 0;
  return `<thead><tr><th></th>${KL_MON.map(m => `<th>${m}</th>`).join('')}<th class="yr">Jahr</th></tr></thead><tbody>
    ${d.tx ? row('Ø Tagesmaximum (°C)', 'rgba(232,69,60,.45)', d.tx, klAvg(d.tx), 1) : ''}
    ${row('Monatsmittel (°C)', KL_RED, d.t, klAvg(d.t), 1, true)}
    ${d.tn ? row('Ø Tagesminimum (°C)', 'rgba(232,69,60,.45)', d.tn, klAvg(d.tn), 1) : ''}
    ${row('Niederschlag (mm)', KL_BAR, d.p, klSum(d.p), pDec, true, true, 0)}
    ${d.rd ? row('Niederschlagstage (≥ 1 mm)', 'rgba(56,189,248,.45)', d.rd, klSum(d.rd), 1, false, false, 0) : ''}
    ${d.sun ? row('Sonnenstunden', '#F5C842', d.sun, klSum(d.sun), 0, true) : ''}
  </tbody>`;
}

// ── Darstellung ───────────────────────────────────────────
function klRender() {
  const c = klCity(kl.gid), d = klData();
  if(!c || !d) return;
  const t = TOPICS.find(x => x.id === 'klima');
  $('chartTitle').textContent = `Klimadiagramm ${c.name}`;
  $('chartSubtitle').innerHTML = `${pyrFlag(c.cc)} ${klEsc(c.admin ? c.admin + ', ' : '')}${klEsc(c.country)}
    · ${klDms(d.lat, 'N', 'S')} ${klDms(d.lon, 'E', 'W')}
    · <span class="kl-kg" title="Köppen-Geiger-Klimazone">${d.kg}</span> ${klEsc(KL_KG[d.kg] || '')}`;
  $('klBarBtn').disabled = !d.tx;
  $('klLegend').innerHTML = kl.mode === 'bar' && d.tx
    ? `<span><i style="background:${KL_RED};height:3px"></i>Monatsmittel</span>
       <span><i style="background:rgba(232,69,60,.25)"></i>Ø Tagesminimum – Ø Tagesmaximum</span>
       <span><i style="background:${KL_BAR}"></i>Niederschlag</span>`
    : `<span><i style="background:${KL_RED};height:3px"></i>Temperatur</span>
       <span><i style="background:${KL_BLUE};height:3px"></i>Niederschlag</span>
       <span><i style="background:repeating-linear-gradient(90deg,${KL_BLUE} 0 1px,transparent 1px 3px)"></i>humid</span>
       <span><i style="background:radial-gradient(${KL_RED} 35%,transparent 40%) 0 0/4px 4px"></i>arid</span>
       <span><i style="background:${KL_DEEP}"></i>über 100 mm (Maßstab 1:10)</span>`;
  $('klTable').innerHTML = klTable(d);
  const src = {
    geosphere: `GeoSphere Austria, Station ${klEsc(d.st)} (ID ${d.sid.replace('GS', '')}) · CC BY 4.0`,
    wmo: `WMO Climate Normals 1991–2020, Station ${klEsc(d.st)} (WMO ${d.wmo}) · über NOAA NCEI`,
    ghcn: `NOAA NCEI GHCN-Daily / GSOM, Station ${klEsc(d.st)} (${d.sid}) · gemeinfrei`,
  }[d.src] + (d.tcalc ? ' · Monatsmittel aus Ø Max und Ø Min berechnet' : '');
  $('klStation').innerHTML = `<i class="ti ti-building-broadcast-tower" aria-hidden="true"></i>
    Station <b>${klEsc(d.st)}</b> · ${d.h.toLocaleString('de-AT')} m · ${klFmt(d.d)} km vom Stadtzentrum ·
    ${d.y ? `${d.y} von 30 Jahren je Monat` : 'mind. 24 von 30 Jahren je Monat'}`;
  setEl('sourcesBox', `<div class="sources-box-header">Datenquelle</div>
    <div style="font-size:12px;color:var(--text2);font-family:'DM Mono',monospace">${src}</div>
    <div style="font-size:11px;color:var(--text3);margin-top:6px">${t.source}</div>`);
  klDraw();
  klRenderStats(d);
  // Liste: Auswahl sichtbar halten
  const inp = document.querySelector(`#klList input[value="${c.gid}"]`);
  if(inp) inp.checked = true; else if(!kl.search) klBuildList();
}

function klRenderStats(d) {
  const iw = d.t.indexOf(Math.max(...d.t)), ik = d.t.indexOf(Math.min(...d.t));
  const iN = d.p.indexOf(Math.max(...d.p)), iT = d.p.indexOf(Math.min(...d.p));
  const arid = d.t.filter((t, i) => t * 2 > d.p[i]).length;
  const frost = d.tn ? d.tn.filter(v => v < 0).length : null;
  const tile = (lbl, val, sub, col) => `<div class="stat" style="border-top-color:${col}">
    <div class="stat-lbl">${lbl}</div><div class="stat-val">${val}</div>
    ${sub ? `<div class="stat-sub">${sub}</div>` : ''}</div>`;
  setEl('stats', [
    tile('Jahresmitteltemperatur', klFmt(klAvg(d.t)) + ' °C', '1991–2020', KL_RED),
    tile('Jahresniederschlag', Math.round(klSum(d.p)).toLocaleString('de-AT') + ' mm', 'Summe der Monatsmittel', KL_BAR),
    tile('Wärmster Monat', klFmt(d.t[iw]) + ' °C', KL_MON[iw] + (d.tx ? ` · Ø Max ${klFmt(d.tx[iw])} °C` : ''), '#F4723B'),
    tile('Kältester Monat', klFmt(d.t[ik]) + ' °C', KL_MON[ik] + (d.tn ? ` · Ø Min ${klFmt(d.tn[ik])} °C` : ''), '#378ADD'),
    tile('Jahresschwankung', klFmt(d.t[iw] - d.t[ik]) + ' K', 'wärmster – kältester Monat', '#7F77DD'),
    tile('Nassester Monat', klFmt(d.p[iN], 0) + ' mm', KL_MON[iN] + ` · trockenster: ${KL_MON[iT]} (${klFmt(d.p[iT], 0)} mm)`, '#1D9E75'),
    tile('Aride Monate', `${arid} von 12`, 'Temperatur × 2 > Niederschlag', '#EF9F27'),
    frost != null
      ? tile('Monate mit Ø Min unter 0 °C', `${frost} von 12`, 'Frostgefahr regelmäßig', '#5B6B7A')
      : tile('Klimazone', d.kg, KL_KG[d.kg] || '', '#5B6B7A'),
  ].join(''));
}

window.addEventListener('resize', () => { if(kl.active) klDraw(); });
