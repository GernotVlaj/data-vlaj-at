// ═══════════════════════════════════════════════════════════
//  data.vlaj.at — app.js
//  Lädt data.json (wöchentlich von pipeline.php generiert)
//  Kein direkter API-Call, kein Fallback-Code, kein Cache
// ═══════════════════════════════════════════════════════════

// ── State ─────────────────────────────────────────────────
const appState = {
  topic:    'debt',
  visible:  new Set(['AT']),
  db:       null,   // komplette data.json
  years:    [],
  yearFrom: 1990,
  yearTo:   2024,
};
let chartInst = null;

// ── Konstanten aus data.js ────────────────────────────────
const ALL_ITEMS  = GROUPS.flatMap(g => g.items);
const REAL_CODES = ALL_ITEMS.filter(c => !c.agg).map(c => c.code);
const TOPICS     = TOPIC_GROUPS.flatMap(g => g.topics);
const EU27W = {DE:.22,FR:.17,IT:.14,ES:.10,AT:.028,GR:.015,SE:.065,CZ:.016,BE:.035,HR:.008};
const EZW   = {DE:.30,FR:.23,IT:.19,ES:.15,AT:.038,GR:.021,BE:.046,HR:.011};
const GROUP_DOTS = ['#F4723B','#378ADD','#EF9F27','#639922','#1D9E75','#7F77DD','#D4537E'];

// ── Helpers ───────────────────────────────────────────────
const R = (v, d=1) => v == null || isNaN(v) ? null : parseFloat(v.toFixed(d));
function $(id) { return document.getElementById(id); }
function setEl(id, html) { const e = $(id); if(e) e.innerHTML = html; }
function setNavStatus(msg) { const e = $('dataAge'); if(e) e.textContent = msg; }
function hideOverlay() { const o = $('overlay'); if(o) o.style.display = 'none'; }
function showOverlay(msg) { const o = $('overlay'); if(o) o.style.display = 'flex'; const m = $('overlayMsg'); if(m) m.textContent = msg || ''; }

// ── Daten aus data.json lesen ─────────────────────────────
function getArr(code, topic) {
  if(!appState.db) return appState.years.map(() => null);
  const arr = appState.db.countries?.[code]?.[topic];
  if(!arr) return appState.years.map(() => null);
  // data.json speichert als Objekt {year: value} oder Array
  if(Array.isArray(arr)) return arr;
  return appState.years.map(y => arr[y] ?? null);
}

// EU27 / EZ gewichteter Durchschnitt berechnen
function computeAgg(W, topic) {
  const codes = Object.keys(W).filter(c => REAL_CODES.includes(c));
  return appState.years.map((_, yi) => {
    let sum = 0, tot = 0;
    codes.forEach(c => {
      const v = getArr(c, topic)[yi];
      if(v != null) { sum += v * W[c]; tot += W[c]; }
    });
    return tot > 0 ? R(sum / tot, 3) : null;
  });
}

function getData(code) {
  if(code === 'EU27') return computeAgg(EU27W, appState.topic);
  if(code === 'EZ')   return computeAgg(EZW,   appState.topic);
  return getArr(code, appState.topic);
}

// ── Wert formatieren ──────────────────────────────────────
function fmtVal(v, t) {
  if(v == null) return '–';
  if(t.id === 'hdi')  return v.toFixed(3);
  if(t.euroFmt) return v.toLocaleString('de-AT') + ' Mrd€';
  if(t.euroPc)  return v.toLocaleString('de-AT') + '€';
  if(t.popFmt) {
    if(v >= 1e9) return (v/1e9).toFixed(2) + ' Mrd';
    if(v >= 1e6) return (v/1e6).toFixed(1) + ' Mio';
    return v.toLocaleString('de-AT');
  }
  return v.toFixed(t.dec ?? 1) + (t.unit || '');
}

// ── Slider ────────────────────────────────────────────────
function onRangeInput() {
  const sf = $('sliderFrom'), st = $('sliderTo');
  let from = parseInt(sf.value), to = parseInt(st.value);
  if(from > to - 2) {
    if(document.activeElement === sf) { from = to - 2; sf.value = from; }
    else                              { to = from + 2; st.value = to; }
  }
  appState.yearFrom = from;
  appState.yearTo   = to;
  $('yearFrom').textContent = from;
  $('yearTo').textContent   = to;
  const pct = y => (y - appState.years[0]) / (appState.years.at(-1) - appState.years[0]) * 100;
  const fill = $('rangeFill');
  if(fill) { fill.style.left = pct(from) + '%'; fill.style.width = (pct(to) - pct(from)) + '%'; }
  renderChart();
  renderStats();
}

function initSlider() {
  const first = appState.years[0], last = appState.years.at(-1);
  const sf = $('sliderFrom'), st = $('sliderTo');
  if(sf) { sf.min = first; sf.max = last; sf.value = first; }
  if(st) { st.min = first; st.max = last; st.value = last; }
  appState.yearFrom = first;
  appState.yearTo   = last;
  $('yearFrom').textContent = first;
  $('yearTo').textContent   = last;
  const fill = $('rangeFill');
  if(fill) { fill.style.left = '0%'; fill.style.width = '100%'; }
}

// ── Status ────────────────────────────────────────────────
function updateStatus() {
  if(!appState.db) { setNavStatus('Keine Daten'); return; }
  const gen = new Date(appState.db.generated);
  const age = Math.floor((Date.now() - gen) / 86400000);
  setNavStatus(age === 0 ? '✓ Heute aktualisiert' : `Stand: ${gen.toLocaleDateString('de-AT')}`);
}

// ── Render Chart ──────────────────────────────────────────
function renderChart() {
  const t = TOPICS.find(x => x.id === appState.topic);
  if(!t || !appState.db) return;
  if(chartInst) { chartInst.destroy(); chartInst = null; }

  const { yearFrom, yearTo } = appState;
  const vis = ALL_ITEMS.filter(c => appState.visible.has(c.code));

  const datasets = vis.map(c => {
    const col = COLORS[c.code] || '#888';
    const pts = appState.years
      .map((y, i) => ({ x: y, y: getData(c.code)[i] }))
      .filter(p => p.x >= yearFrom && p.x <= yearTo);
    return {
      label: `${c.flag} ${c.name}`,
      data: pts, borderColor: col, backgroundColor: col + '22',
      borderWidth: c.agg ? 2.5 : 1.5,
      borderDash: c.agg && c.code === 'EZ' ? [6,3] : [],
      pointRadius: 2, pointHoverRadius: 6, tension: .3, fill: false, spanGaps: true,
      pointHoverBorderColor: '#fff', pointHoverBackgroundColor: col,
    };
  });

  chartInst = new Chart($('chart'), {
    type: 'line', data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'nearest', intersect: true },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(20,20,20,.92)', titleColor: '#fff', bodyColor: '#ccc',
          borderColor: 'rgba(255,255,255,.1)', borderWidth: 1, cornerRadius: 10, padding: 12,
          callbacks: {
            title: ctx => `${ctx[0].dataset.label} · ${ctx[0].parsed.x}`,
            label: ctx => ` ${fmtVal(ctx.parsed.y, t)}`,
            labelColor: ctx => ({ backgroundColor: ctx.dataset.borderColor, borderColor: ctx.dataset.borderColor, borderRadius: 3 }),
          },
          titleFont: { size: 13, weight: '600', family: 'DM Sans' },
          bodyFont: { size: 13, family: 'DM Sans' },
          displayColors: true, boxWidth: 10, boxHeight: 10,
        },
      },
      scales: {
        x: {
          type: 'linear', min: yearFrom, max: yearTo,
          grid: { color: 'rgba(128,128,128,.08)' },
          ticks: { color: '#9A9A9A', font: { size: 11, family: 'DM Mono' },
            stepSize: yearTo - yearFrom > 15 ? 5 : 1, callback: v => v },
        },
        y: {
          grid: { color: 'rgba(128,128,128,.08)' },
          ticks: { color: '#9A9A9A', font: { size: 11, family: 'DM Mono' }, callback: v => {
            const n = parseFloat(v.toPrecision(10));
            if(t.id === 'hdi')   return n.toFixed(2);
            if(t.euroFmt) return n >= 1000 ? (n/1000).toFixed(0) + 'k' : n;
            if(t.euroPc)  return n >= 1000 ? (n/1000).toFixed(0) + 'k€' : n + '€';
            return n + (t.unit || '');
          }},
          title: { display: true, text: t.yLbl, color: '#9A9A9A', font: { size: 11, family: 'DM Sans' } },
        },
      },
    },
  });
}

// ── Render Stats ──────────────────────────────────────────
function renderStats() {
  const t = TOPICS.find(x => x.id === appState.topic);
  if(!t || !appState.db) return;
  const { yearFrom, yearTo } = appState;
  const trendPos = ['hdi','lifeexp','renewables','forestarea','exports','gdppc','pop',
    'taxrev','educexp','healthexp','fertility','gdpAbs','productivity','rdexp','patents',
    'tertiary','pisaread','pisamath','pisasci'];

  const html = ALL_ITEMS.filter(c => appState.visible.has(c.code)).map(c => {
    const col = COLORS[c.code] || '#888';
    const all = getData(c.code);
    const d = appState.years
      .map((y, i) => y >= yearFrom && y <= yearTo ? all[i] : null)
      .filter(v => v != null);
    if(!d.length) return `<div class="stat" style="border-top-color:${col}">
      <div class="stat-flag">${c.flag}</div><div class="stat-lbl">${c.name}</div><div class="stat-val">–</div></div>`;

    const latest = d[d.length-1], first = d[0];
    const mn = Math.min(...d), mx = Math.max(...d);
    const tr = R(latest - first, t.dec ?? 1);
    const up = trendPos.includes(t.id) ? tr > 0 : tr < 0;

    return `<div class="stat" style="border-top-color:${col}">
      <div class="stat-flag">${c.flag}</div>
      <div class="stat-lbl">${c.name}</div>
      <div class="stat-val">${fmtVal(latest, t)}</div>
      <div class="stat-sub">Spanne ${fmtVal(R(mn, t.dec??1), t)} – ${fmtVal(R(mx, t.dec??1), t)}</div>
      <div class="stat-trend" style="color:${up?'#4CAF6E':'#E8453C'}">${tr>0?'↑':'↓'} ${fmtVal(Math.abs(tr), t)} seit ${yearFrom}</div>
      <div class="stat-src">⬡ ${t.source}</div>
    </div>`;
  }).join('') || `<div class="stat"><div class="stat-lbl">Kein Land gewählt</div></div>`;

  setEl('stats', html);
}

// ── Render Explainer ──────────────────────────────────────
function renderExplainer() {
  const t = TOPICS.find(x => x.id === appState.topic);
  if(!t) return;
  const icons = {
    debt:'📊',debtAbs:'💰',deficit:'📉',taxrev:'🏛',interest:'💸',
    gdp:'📈',gdpAbs:'🏭',infl:'🔥',unemp:'👷',gdppc:'💵',
    productivity:'⚙️',realwage:'💼',poverty:'🏚',netmigration:'✈️',gini:'⚖️',
    hdi:'🌍',lifeexp:'❤️',healthexp:'🏥',educexp:'🎓',pop:'👥',
    popgrowth:'📊',fertility:'👶',aged:'🧓',medage:'📅',co2:'🌫',
    renewables:'⚡',nuclear:'⚛️',energyimport:'🔌',water:'💧',plastic:'🗑',
    forestarea:'🌲',exports:'📦',imports:'🚢',cab:'🔄',fdi:'🏦',
    physicians:'🩺',hospitalbed:'🛏',obesity:'⚖️',alcohol:'🍺',tobacco:'🚬',
    beer:'🍺',rdexp:'🔬',patents:'💡',tertiary:'🎓',
    pisaread:'📖',pisamath:'📐',pisasci:'🧪',
  };
  setEl('explainer', `
    <div class="explainer-icon">${icons[t.id] || '📊'}</div>
    <div class="explainer-body-wrap">
      <div class="explainer-title">${t.title}</div>
      <div class="explainer-body">${t.body}</div>
    </div>`);
  setEl('sourcesBox', `
    <div class="sources-box-header">Datenquelle</div>
    <div style="font-size:12px;color:var(--text2);font-family:'DM Mono',monospace">${t.source}</div>`);
}

// ── Navigation ────────────────────────────────────────────
function buildTabs() {
  const activeGroupIdx = TOPIC_GROUPS.findIndex(g => g.topics.some(t => t.id === appState.topic));
  const activeGroup = TOPIC_GROUPS[Math.max(0, activeGroupIdx)];

  $('groupTabsInner').innerHTML = TOPIC_GROUPS.map((g, i) =>
    `<button class="group-tab${g.group === activeGroup.group ? ' on' : ''}" onclick="setGroup(${i})">
      <span class="group-tab-dot" style="background:${GROUP_DOTS[i % GROUP_DOTS.length]}"></span>${g.group}
    </button>`
  ).join('');

  $('groupOverflowMenu').innerHTML = TOPIC_GROUPS.map((g, i) =>
    `<div class="group-overflow-item${g.group === activeGroup.group ? ' on' : ''}" onclick="setGroup(${i});closeOverflowMenu()">
      <span style="width:7px;height:7px;border-radius:50%;background:${GROUP_DOTS[i%GROUP_DOTS.length]};display:inline-block;flex-shrink:0"></span>${g.group}
    </div>`
  ).join('');
  $('groupOverflowLabel').textContent = activeGroup.group;

  $('indicatorPillsBar').innerHTML = activeGroup.topics.map(t =>
    `<button class="ind-pill${t.id === appState.topic ? ' on' : ''}" onclick="setTopic('${t.id}')">${t.label}</button>`
  ).join('');
}

function buildCbList() {
  setEl('cbList', GROUPS.map(g =>
    `<div class="cb-group-label">${g.label}</div>${g.items.map(c => {
      const col = COLORS[c.code] || '#888';
      const chk = appState.visible.has(c.code) ? 'checked' : '';
      const badge = c.agg ? `<span class="agg-badge">∑</span>` : '';
      return `<label class="cb-row"><input type="checkbox" ${chk} onchange="toggle('${c.code}')">
        <span class="cb-dot" style="background:${col}"></span>
        <span class="cb-label">${c.flag} ${c.name}${badge}</span></label>`;
    }).join('')}`
  ).join(''));
}

function toggle(code) {
  appState.visible.has(code) ? appState.visible.delete(code) : appState.visible.add(code);
  renderChart(); renderStats(); 
}

function setAll(v) {
  if(v) ALL_ITEMS.forEach(c => appState.visible.add(c.code));
  else  appState.visible.clear();
  buildCbList(); renderChart(); renderStats();
}

function setGroup(idx) {
  const g = TOPIC_GROUPS[idx];
  if(!g || !g.topics.length) return;
  setTopic(g.topics[0].id);
}

function setTopic(id) {
  appState.topic = id;
  buildTabs();
  const t = TOPICS.find(x => x.id === id);
  const el = $('chartTitle');
  if(el) el.textContent = t.title.split('(')[0].trim();
  renderChart(); renderStats(); renderExplainer();
}

function toggleOverflowMenu() {
  $('groupOverflowMenu')?.classList.toggle('open');
  document.addEventListener('mousedown', overflowOutside);
}
function closeOverflowMenu() { $('groupOverflowMenu')?.classList.remove('open'); }
function overflowOutside(e) {
  if(!$('groupOverflowWrap')?.contains(e.target)) {
    closeOverflowMenu();
    document.removeEventListener('mousedown', overflowOutside);
  }
}

// ── Nav Search ────────────────────────────────────────────
function onNavSearch(q) {
  const clr = $('navSearchClear');
  if(clr) clr.style.display = q ? 'block' : 'none';
  renderNavDD(q); openNavDD();
}
function openNavDD() {
  renderNavDD($('navSearch')?.value || '');
  $('navDD')?.classList.add('open');
  document.addEventListener('mousedown', navDDOutside);
}
function closeNavDD() {
  $('navDD')?.classList.remove('open');
  document.removeEventListener('mousedown', navDDOutside);
}
function navDDOutside(e) {
  const wrap = document.querySelector('.nav-search-wrap');
  if(!wrap?.contains(e.target) && !$('navDD')?.contains(e.target)) closeNavDD();
}
function clearNavSearch() {
  const inp = $('navSearch');
  if(inp) inp.value = '';
  $('navSearchClear') && ($('navSearchClear').style.display = 'none');
  renderNavDD(''); inp?.focus();
}
function navHl(text, term) {
  if(!term) return text;
  return text.replace(new RegExp('(' + term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + ')','gi'),
    '<strong style="color:var(--text);font-weight:500">$1</strong>');
}
function renderNavDD(q) {
  const el = $('navDDContent'); if(!el) return;
  const term = q.trim().toLowerCase();
  if(!term) {
    el.innerHTML = `
      <div class="nav-dd-group">Zuletzt</div>
      ${TOPICS.slice(0,4).map(t => `<div class="nav-dd-item${t.id===appState.topic?' active':''}" onclick="setTopic('${t.id}');closeNavDD();clearNavSearch()">${t.label}<span class="nav-dd-desc">${TOPIC_GROUPS.find(g=>g.topics.some(x=>x.id===t.id))?.group||''}</span></div>`).join('')}
      <div class="nav-dd-sep"></div>
      <div class="nav-dd-group">Alle Gruppen</div>
      ${TOPIC_GROUPS.map((g,i) => `<div class="nav-dd-item" onclick="setGroup(${i});closeNavDD();clearNavSearch()"><span style="width:7px;height:7px;border-radius:50%;background:${GROUP_DOTS[i%GROUP_DOTS.length]};display:inline-block;flex-shrink:0"></span>${g.group}<span class="nav-dd-desc">${g.topics.length} Indikatoren</span></div>`).join('')}`;
    return;
  }
  const res = TOPICS.filter(t => t.label.toLowerCase().includes(term) || t.id.toLowerCase().includes(term));
  if(!res.length) { el.innerHTML = `<div class="nav-dd-item" style="color:var(--text3);cursor:default">Kein Ergebnis für "${q}"</div>`; return; }
  const byG = {};
  res.forEach(t => { const g = TOPIC_GROUPS.find(g=>g.topics.some(x=>x.id===t.id))?.group||''; (byG[g]=byG[g]||[]).push(t); });
  el.innerHTML = Object.entries(byG).map(([g,ts],i) =>
    `${i>0?'<div class="nav-dd-sep"></div>':''}<div class="nav-dd-group">${g}</div>${ts.map(t=>`<div class="nav-dd-item${t.id===appState.topic?' active':''}" onclick="setTopic('${t.id}');closeNavDD();clearNavSearch()">${navHl(t.label,term)}<span class="nav-dd-desc">${t.unit||''}</span></div>`).join('')}`
  ).join('');
}

// ── Theme ─────────────────────────────────────────────────
function applyTheme(dark) {
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  const icon = $('themeIcon'), label = $('themeLabel');
  if(icon)  icon.textContent  = dark ? '☀️' : '🌙';
  if(label) label.textContent = dark ? 'Light' : 'Dark';
  try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch(e) {}
}
function toggleTheme() {
  applyTheme(document.documentElement.getAttribute('data-theme') !== 'dark');
}

// ── Init ──────────────────────────────────────────────────
async function init() {
  // Theme
  let saved; try { saved = localStorage.getItem('theme'); } catch(e) {}
  applyTheme(saved ? saved === 'dark' : window.matchMedia?.('(prefers-color-scheme: dark)').matches);

  buildTabs();
  buildCbList();
  showOverlay('Lade Daten…');

  try {
    const res = await fetch('data.json');
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const db = await res.json();

    appState.db       = db;
    appState.years    = db.years;
    appState.yearFrom = db.years[0];
    appState.yearTo   = db.years.at(-1);

    hideOverlay();
    initSlider();
    setTopic('debt');
    updateStatus();

  } catch(err) {
    $('overlayMsg').textContent = 'Fehler beim Laden der Daten.';
    console.error('data.json load error:', err);
  }
}

init();
