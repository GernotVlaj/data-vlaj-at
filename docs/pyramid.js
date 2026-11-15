// ═══════════════════════════════════════════════════════════
//  data.vlaj.at — pyramid.js
//  Bevölkerungspyramide: eigenes Topic (mode:'pyramid') mit
//  Länder-Radioliste, Jahres-Slider, Animation und Kennzahlen.
//  Daten: pyramid/index.json + pyramid/<ISO3>.json
//  (erzeugt von pipeline/fetch_pyramid.py). Das Format ist
//  quellenneutral – Altersgruppen kommen aus den Daten.
// ═══════════════════════════════════════════════════════════

const PYR_COLORS = { male: '#378ADD', female: '#D4537E' };
const PYR_REGIONS = {
  ECS: 'Europa & Zentralasien', NAC: 'Nordamerika', LCN: 'Lateinamerika & Karibik',
  EAS: 'Ostasien & Pazifik', SAS: 'Südasien', MEA: 'Naher Osten & Nordafrika',
  SSF: 'Subsahara-Afrika',
};

const pyr = {
  active: false,
  index: null,          // pyramid/index.json
  cache: {},            // ISO3 → Länderdaten
  iso3: 'AUT',
  year: null,
  pct: false,           // Anteile statt Absolutwerte
  outline: true,        // Umriss des letzten Schätzjahres
  timer: null,
  chart: null,
  search: '',
};

// ── Helfer ────────────────────────────────────────────────
const pyrFmt = n => n.toLocaleString('de-AT');
function pyrBig(n) {
  if(n >= 1e9) return (n / 1e9).toFixed(2).replace('.', ',') + ' Mrd';
  if(n >= 1e6) return (n / 1e6).toFixed(1).replace('.', ',') + ' Mio';
  if(n >= 1e3) return Math.round(n / 1e3) + ' Tsd';
  return String(n);
}
const pyrPct = (v, d = 1) => v.toFixed(d).replace('.', ',') + ' %';

let _pyrNames;
function pyrName(c) {
  try {
    _pyrNames = _pyrNames || new Intl.DisplayNames(['de'], { type: 'region' });
    const n = /^[A-Z]{2}$/.test(c.iso2) ? _pyrNames.of(c.iso2) : null;
    if(n && n !== c.iso2) return n;
  } catch(e) {}
  return c.name;
}
function pyrFlag(iso2) {
  if(!/^[A-Z]{2}$/.test(iso2)) return '🏳️';
  return String.fromCodePoint(...[...iso2].map(ch => 0x1F1E6 + ch.charCodeAt(0) - 65));
}
// Vergleichs-/Startjahr: aktuelles Jahr (falls vorhanden), sonst letztes Schätzjahr
const pyrRefYear = () => pyr.index.refYear ?? Math.min(pyr.index.lastEstimateYear, pyr.index.years.at(-1));
const pyrCountry = iso3 => pyr.index?.countries.find(c => c.iso3 === iso3);

async function pyrLoadIndex() {
  if(pyr.index) return pyr.index;
  const r = await fetch('pyramid/index.json');
  if(!r.ok) throw new Error('HTTP ' + r.status);
  pyr.index = await r.json();
  pyr.index.countries.forEach(c => { c.label = pyrName(c); });
  return pyr.index;
}
async function pyrLoadCountry(iso3) {
  if(pyr.cache[iso3]) return pyr.cache[iso3];
  const r = await fetch(`pyramid/${iso3}.json`);
  if(!r.ok) throw new Error('HTTP ' + r.status);
  return (pyr.cache[iso3] = await r.json());
}

// ── Modus betreten / verlassen ────────────────────────────
async function enterPyramid() {
  pyr.active = true;
  pyrMatchHeight();
  document.body.classList.add('pyr-mode');
  if(chartInst) { chartInst.destroy(); chartInst = null; }
  setEl('stats', '');
  showOverlay('Lade Bevölkerungsdaten…');
  try {
    await pyrLoadIndex();
    pyrReadHash();
    const c = pyrCountry(pyr.iso3);
    if(!c || !c.hasData) pyr.iso3 = 'AUT';
    if(pyr.year == null) pyr.year = pyrRefYear();
    pyrInitControls();
    pyrBuildList();
    await pyrSelect(pyr.iso3);
    hideOverlay();
  } catch(e) {
    console.error('Pyramide:', e);
    showOverlay('Bevölkerungsdaten konnten nicht geladen werden.');
  }
}

function exitPyramid() {
  if(!pyr.active) return;
  pyr.active = false;
  pyrStop();
  if(pyr.chart) { pyr.chart.destroy(); pyr.chart = null; }
  document.body.classList.remove('pyr-mode');
  if(location.hash.startsWith('#pyramid')) history.replaceState(null, '', location.pathname + location.search);
}

// Radio-Liste so hoch wie die normale Checkbox-Liste (nur Desktop;
// mobil gilt die kompakte Höhe aus dem CSS)
function pyrMatchHeight() {
  const list = $('pyrList'), cb = $('cbList'), bulk = document.querySelector('.bulk-btns');
  if(!list || !cb || !window.matchMedia?.('(min-width: 768px)').matches) { if(list) list.style.maxHeight = ''; return; }
  const h = cb.offsetHeight + (bulk?.offsetHeight || 0) - 46;   // 46 ≈ Suchfeld + Abstand
  if(h > 200) list.style.maxHeight = h + 'px';
}

// ── URL-Hash: #pyramid/AUT/2050 ───────────────────────────
function pyrReadHash() {
  const m = location.hash.match(/^#pyramid(?:\/([A-Z]{3}))?(?:\/(\d{4}))?/);
  if(!m) return;
  if(m[1]) pyr.iso3 = m[1];
  if(m[2]) pyr.year = +m[2];
}
function pyrWriteHash() {
  history.replaceState(null, '', `#pyramid/${pyr.iso3}/${pyr.year}`);
}

// ── Sidebar: Radio-Liste ──────────────────────────────────
function pyrRow(c) {
  const dis = !c.hasData;
  return `<label class="cb-row pyr-row${dis ? ' disabled' : ''}" ${dis ? 'title="Keine Daten verfügbar"' : ''}>
    <input type="radio" name="pyrCountry" value="${c.iso3}" ${c.iso3 === pyr.iso3 ? 'checked' : ''} ${dis ? 'disabled' : ''}
      onchange="pyrSelect('${c.iso3}')">
    <span class="cb-label">${c.icon || pyrFlag(c.iso2)} ${c.label}</span></label>`;
}

function pyrBuildList() {
  const term = pyr.search.trim().toLowerCase();
  const match = c => !term || c.label.toLowerCase().includes(term) || c.iso3.toLowerCase() === term;
  // Aggregate (Welt, Europa, Afrika) ganz oben, in Pipeline-Reihenfolge
  const aggs = pyr.index.countries.filter(c => c.region === 'AGG' && match(c));
  const all = pyr.index.countries
    .filter(c => c.region !== 'AGG' && match(c))
    .sort((a, b) => a.label.localeCompare(b.label, 'de'));
  let html = aggs.length ? `<div class="cb-group-label">Aggregate</div>` + aggs.map(pyrRow).join('') : '';
  if(!term) {
    const fav = new Set(REAL_CODES);
    const favs = all.filter(c => fav.has(c.iso2));
    if(favs.length) html += `<div class="cb-group-label">Favoriten</div>` + favs.map(pyrRow).join('');
  }
  const regions = pyr.index.regions?.map(r => [r.id, r.name]) || Object.entries(PYR_REGIONS);
  for(const [rid, rname] of regions) {
    const rows = all.filter(c => c.region === rid);
    if(rows.length) html += `<div class="cb-group-label">${rname}</div>` + rows.map(pyrRow).join('');
  }
  setEl('pyrList', html || `<div class="pyr-empty">Kein Land gefunden</div>`);
}

function pyrOnSearch(v) { pyr.search = v; pyrBuildList(); }

// ── Steuerung ─────────────────────────────────────────────
function pyrInitControls() {
  const yrs = pyr.index.years, s = $('pyrSlider');
  s.min = yrs[0]; s.max = yrs.at(-1); s.value = pyr.year;
  $('pyrMin').textContent = yrs[0];
  $('pyrMax').textContent = yrs.at(-1);
  $('pyrPctBtn').classList.toggle('on', pyr.pct);
  $('pyrAbsBtn').classList.toggle('on', !pyr.pct);
  $('pyrOutline').checked = pyr.outline;
  $('pyrOutlineYear').textContent = pyrRefYear();
  // Prognose-Bereich im Slider markieren
  const est = pyr.index.lastEstimateYear;
  const p = (est - yrs[0]) / (yrs.at(-1) - yrs[0]) * 100;
  $('pyrTrack').style.setProperty('--est', p + '%');
}

function pyrOnSlider(v) { pyrStop(); pyrSetYear(+v); }

function pyrSetYear(y) {
  pyr.year = y;
  $('pyrSlider').value = y;
  pyrRender();
}

function pyrSetPct(on) {
  pyr.pct = on;
  $('pyrPctBtn').classList.toggle('on', on);
  $('pyrAbsBtn').classList.toggle('on', !on);
  if(pyr.chart) { pyr.chart.destroy(); pyr.chart = null; }   // Achsen neu skalieren
  pyrRender();
}

function pyrSetOutline(on) { pyr.outline = on; pyrRender(); }

function pyrTogglePlay() { pyr.timer ? pyrStop() : pyrPlay(); }
function pyrPlay() {
  const yrs = pyr.index.years;
  if(pyr.year >= yrs.at(-1)) pyrSetYear(yrs[0]);
  $('pyrPlay').innerHTML = '<i class="ti ti-player-pause-filled" aria-hidden="true"></i>';
  $('pyrPlay').setAttribute('aria-label', 'Pause');
  pyr.timer = setInterval(() => {
    if(pyr.year >= yrs.at(-1)) return pyrStop();
    pyrSetYear(pyr.year + 1);
  }, 180);
}
function pyrStop() {
  if(pyr.timer) clearInterval(pyr.timer);
  pyr.timer = null;
  const b = $('pyrPlay');
  if(b) { b.innerHTML = '<i class="ti ti-player-play-filled" aria-hidden="true"></i>'; b.setAttribute('aria-label', 'Abspielen'); }
}

async function pyrSelect(iso3) {
  const c = pyrCountry(iso3);
  if(!c || !c.hasData) return;
  pyr.iso3 = iso3;
  try {
    await pyrLoadCountry(iso3);
  } catch(e) {
    showOverlay('Daten für dieses Land konnten nicht geladen werden.');
    return;
  }
  hideOverlay();
  if(pyr.chart) { pyr.chart.destroy(); pyr.chart = null; }   // neue Achsenskala
  pyrRender();
}

// ── Berechnungen ──────────────────────────────────────────
function pyrYearData(d, year) {
  const i = d.years.indexOf(year);
  if(i < 0) return null;
  const m = d.male[i].map(v => v || 0), f = d.female[i].map(v => v || 0);
  const total = m.reduce((a, b) => a + b, 0) + f.reduce((a, b) => a + b, 0);
  return { m, f, total };
}

// Untere Altersgrenze und Breite je Gruppe aus dem Label ("20–24", "80+", "5")
function pyrBounds(ages) {
  return ages.map(a => {
    const n = a.match(/\d+/g).map(Number);
    return n.length > 1 ? [n[0], n[1] - n[0] + 1] : [n[0], a.includes('+') ? (ages.length > 25 ? 5 : 15) : 1];
  });
}

function pyrStatsFor(d, yd) {
  const b = pyrBounds(d.ages);
  let young = 0, work = 0, old = 0, men = 0, o80 = 0, ageSum = 0;
  const tot = d.ages.map((_, i) => yd.m[i] + yd.f[i]);
  tot.forEach((v, i) => {
    const [lo, w] = b[i], hi = lo + w - 1;
    if(hi <= 14) young += v; else if(lo >= 65) old += v; else work += v;
    if(lo >= 80) o80 += v;
    ageSum += v * (lo + w / 2);          // Gruppenmitte (Einzeljahr: x,5)
  });
  yd.m.forEach(v => men += v);
  // Medianalter: lineare Interpolation in der Gruppe, die die Hälfte überschreitet
  let cum = 0, median = null;
  for(let i = 0; i < tot.length; i++) {
    if(cum + tot[i] >= yd.total / 2) {
      median = b[i][0] + (yd.total / 2 - cum) / (tot[i] || 1) * b[i][1];
      break;
    }
    cum += tot[i];
  }
  return {
    young: young / yd.total * 100, work: work / yd.total * 100, old: old / yd.total * 100,
    dep: (young + old) / (work || 1) * 100, men: men / yd.total * 100, median,
    oldDep: old / (work || 1) * 100, o80: o80 / yd.total * 100, mean: ageSum / yd.total,
    babies: b[0][1] === 1 ? tot[0] : null,  // nur bei Einzeljahren
  };
}

// Achsen-Maximum über alle Jahre, damit die Animation vergleichbar bleibt
function pyrAxisMax(d) {
  let mx = 0;
  d.years.forEach((y, i) => {
    const yd = pyrYearData(d, y);
    if(!yd.total) return;
    const vals = [...yd.m, ...yd.f].map(v => pyr.pct ? v / yd.total * 100 : v);
    mx = Math.max(mx, ...vals);
  });
  return mx * 1.05;
}

// ── Rendern ───────────────────────────────────────────────
function pyrRender() {
  if(!pyr.active || !pyr.index) return;
  const d = pyr.cache[pyr.iso3], c = pyrCountry(pyr.iso3);
  if(!d || !c) return;
  const yd = pyrYearData(d, pyr.year);
  if(!yd) return;
  const est = pyr.index.lastEstimateYear;
  const prog = pyr.year > est;
  const refY = pyrRefYear();
  const ref = pyr.outline && pyr.year !== refY ? pyrYearData(d, refY) : null;
  const val = (v, t) => pyr.pct ? (t ? v / t * 100 : 0) : v;

  // Kopfzeile
  $('chartTitle').textContent = `Bevölkerungspyramide · ${c.label}`;
  $('chartSubtitle').textContent = `${pyr.year} · ${pyrBig(yd.total)} Einwohner${c.members ? ` · Summe aus ${c.members} Ländern` : ''}${prog ? ' · Prognose' : ''}`;
  $('pyrYear').textContent = pyr.year;
  $('pyrBadge').hidden = !prog;
  pyrWriteHash();

  // Altersgruppen oben = alt → Daten umdrehen
  const labels = [...d.ages].reverse();
  const rev = a => [...a].reverse();
  const alpha = prog ? 'AA' : 'EE';
  const datasets = [
    { label: 'Männer', data: rev(yd.m.map(v => -val(v, yd.total))), raw: rev(yd.m),
      backgroundColor: PYR_COLORS.male + alpha, borderWidth: 0, order: 2 },
    { label: 'Frauen', data: rev(yd.f.map(v => val(v, yd.total))), raw: rev(yd.f),
      backgroundColor: PYR_COLORS.female + alpha, borderWidth: 0, order: 2 },
  ];
  if(ref) {
    const outlineCol = getComputedStyle(document.documentElement).getPropertyValue('--text2').trim() || '#666';
    datasets.push(
      { label: `Männer ${refY}`, data: rev(ref.m.map(v => -val(v, ref.total))), raw: rev(ref.m), isRef: true,
        backgroundColor: 'transparent', borderColor: outlineCol, borderWidth: { left: 1.5, right: 0, top: 0, bottom: 0 }, borderSkipped: false, order: 1 },
      { label: `Frauen ${refY}`, data: rev(ref.f.map(v => val(v, ref.total))), raw: rev(ref.f), isRef: true,
        backgroundColor: 'transparent', borderColor: outlineCol, borderWidth: { left: 0, right: 1.5, top: 0, bottom: 0 }, borderSkipped: false, order: 1 });
  }

  if(pyr.chart) {
    pyr.chart.data.labels = labels;
    pyr.chart.data.datasets = datasets;
    pyr.chart.update('none');
  } else {
    const mx = pyrAxisMax(d);
    pyr.chart = new Chart($('chart'), {
      type: 'bar',
      data: { labels, datasets },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
        datasets: { bar: { grouped: false, categoryPercentage: 1, barPercentage: d.ages.length > 25 ? 1 : .92 } },
        interaction: { mode: 'index', axis: 'y', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(20,20,20,.92)', titleColor: '#fff', bodyColor: '#ccc',
            cornerRadius: 10, padding: 12,
            titleFont: { size: 13, weight: '600', family: 'DM Sans' }, bodyFont: { size: 12, family: 'DM Sans' },
            filter: item => !item.dataset.isRef,
            callbacks: {
              title: items => `Alter ${items[0].label}${/^\d+$/.test(items[0].label) ? (items[0].label === '1' ? ' Jahr' : ' Jahre') : ''} · ${pyr.year}`,
              label: item => {
                const yd2 = pyrYearData(pyr.cache[pyr.iso3], pyr.year);
                const n = item.dataset.raw[item.dataIndex];
                return ` ${item.dataset.label}: ${pyrFmt(n)} (${pyrPct(n / yd2.total * 100, 2)})`;
              },
            },
          },
        },
        scales: {
          x: {
            min: -mx, max: mx,
            grid: { color: 'rgba(128,128,128,.08)' },
            ticks: { color: '#9A9A9A', font: { size: 11, family: 'DM Mono' }, maxTicksLimit: 9,
              callback: v => pyr.pct ? pyrPct(Math.abs(v), Math.abs(v) < 1 && v !== 0 ? 1 : 0) : pyrBig(Math.abs(v)) },
          },
          y: {
            grid: { display: false },
            // bei feinen Altersstufen (z. B. später Einzeljahre) automatisch ausdünnen
            ticks: { color: '#9A9A9A', font: { size: 10, family: 'DM Mono' }, autoSkip: false,
              callback(v) {
                const l = this.getLabelForValue(v);
                return d.ages.length <= 25 || l.includes('+') || parseInt(l) % 10 === 0 ? l : '';
              } },
          },
        },
      },
    });
  }
  pyrRenderStats(d, yd, c);
}

function pyrRenderStats(d, yd, c) {
  const s = pyrStatsFor(d, yd);
  const prev = pyrYearData(d, pyr.year - 1), ref = pyrRefYear(), refD = pyrYearData(d, ref);
  const chg = o => (yd.total / (o.total || 1) - 1) * 100;
  const sign = (v, abs) => (v > 0 ? '+' : v < 0 ? '−' : '±') +
    (abs ? pyrFmt(Math.abs(Math.round(v))) : Math.abs(v).toFixed(Math.abs(v) < 10 ? 2 : 1).replace('.', ',') + ' %');
  const tile = (lbl, val, sub, col) => `<div class="stat" style="border-top-color:${col}">
    <div class="stat-lbl">${lbl}</div><div class="stat-val">${val}</div>
    ${sub ? `<div class="stat-sub">${sub}</div>` : ''}</div>`;
  setEl('stats', [
    tile('Bevölkerung', pyrBig(yd.total), `${pyrFmt(yd.total)} · ${pyr.year}`, '#F4723B'),
    tile('Medianalter', s.median != null ? s.median.toFixed(1).replace('.', ',') + ' J' : '–', d.ages.length > 25 ? 'Hälfte jünger, Hälfte älter' : 'aus 5-Jahres-Gruppen geschätzt', '#7F77DD'),
    tile('Kinder 0–14', pyrPct(s.young), 'Anteil an Bevölkerung', '#639922'),
    tile('Erwerbsalter 15–64', pyrPct(s.work), 'Anteil an Bevölkerung', '#1D9E75'),
    tile('65 und älter', pyrPct(s.old), 'Anteil an Bevölkerung', '#EF9F27'),
    tile('Abhängigkeitsquote', s.dep.toFixed(0) + ' %', '(0–14 + 65+) je 100 im Erwerbsalter', '#E8453C'),
    tile('Männer / Frauen', `${s.men.toFixed(1).replace('.', ',')} / ${(100 - s.men).toFixed(1).replace('.', ',')}`, 'Anteil in %', PYR_COLORS.male),
    tile('Veränderung zum Vorjahr', prev ? sign(chg(prev)) : '–', prev ? `${sign(yd.total - prev.total, true)} Personen` : 'kein Vorjahr', '#378ADD'),
    pyr.year < ref && refD
      ? tile(`Veränderung bis ${ref}`, sign((refD.total / (yd.total || 1) - 1) * 100), `${pyrBig(yd.total)} → ${pyrBig(refD.total)}`, '#5B6B7A')
      : tile(`Veränderung seit ${ref}`, refD && ref !== pyr.year ? sign(chg(refD)) : '–', refD && ref !== pyr.year ? `${pyrBig(refD.total)} → ${pyrBig(yd.total)}` : 'ist das Vergleichsjahr', '#5B6B7A'),
    tile('Durchschnittsalter', s.mean.toFixed(1).replace('.', ',') + ' J', 'arithmetisches Mittel', '#9B59B6'),
    tile('Altenquotient', s.oldDep.toFixed(0) + ' %', '65+ je 100 im Erwerbsalter', '#D85A30'),
    tile('Hochbetagte 80+', pyrPct(s.o80), `${pyrBig(Math.round(s.o80 / 100 * yd.total))} Personen`, '#B5651D'),
    tile('Unter 1 Jahr', s.babies != null ? pyrBig(s.babies) : '–', 'Jahrgang ≈ Geburten', '#E91E8C'),
  ].join(''));
}
