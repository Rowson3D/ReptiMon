(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const fmt = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '--');

  // State
  let dataHistory = [];
  let lastValues = { temperature: null, humidity: null, comfort: null };
  let statsCounter = 0;
  let footer, setStatus;
  let footerHostEl, footerIPEl, footerUpdatedEl;
  let footerTempEl, footerHumEl, footerWifiEl, footerRssiEl, footerCamEl;
  let currentCleanup = null; // cleanup for current component
  // History persistence config
  const HISTORY_KEY = 'momo-history-v1';
  const HISTORY_MAX_POINTS = 1800; // ~ many hours depending on sample rate
  const HISTORY_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours cap
  // Shared sparkline window shown under top cards (minutes)
  const SPARK_WINDOW_MIN = 30;
  let lastPersist = 0;
  function loadPersistedHistory(){
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (!raw) return;
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return;
      const now = Date.now();
      // Filter only recent and valid points
      const cleaned = arr.filter(p => p && Number.isFinite(p.temperature) && Number.isFinite(p.humidity) && typeof p.timestamp === 'number' && (now - p.timestamp) <= HISTORY_MAX_AGE_MS);
      if (cleaned.length){
        dataHistory = cleaned.slice(-HISTORY_MAX_POINTS);
        window.__momo_history = dataHistory;
        // Provide last value for quick UI render before first live packet
        const last = dataHistory[dataHistory.length - 1];
        if (last){ window.__momo_last = last; }
      }
    } catch(e){ /* ignore */ }
  }
  function persistHistory(force=false){
    const now = Date.now();
    if (!force && (now - lastPersist) < 5000) return; // throttle every 5s
    try {
      const slim = dataHistory.slice(-HISTORY_MAX_POINTS).map(p => ({
        // Only keep needed fields to minimize storage size
        timestamp:p.timestamp,
        temperature:p.temperature,
        humidity:p.humidity,
        dewPoint:p.dewPoint,
        heatIndex:p.heatIndex,
        vpd:p.vpd,
        units:p.units
      }));
      localStorage.setItem(HISTORY_KEY, JSON.stringify(slim));
      lastPersist = now;
    } catch(e){ /* storage full or denied */ }
  }
  // Save on tab close / hide for extra safety
  window.addEventListener('beforeunload', () => persistHistory(true));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') persistHistory(true); });

  // App entry
  async function loadPartial(id, url) {
    const host = document.getElementById(id);
    if (!host) return null;
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) throw new Error('failed');
      host.innerHTML = await r.text();
      return host;
    } catch (e) {
      console.warn('Partial load failed', id, url, e);
      host.innerHTML = '';
      return null;
    }
  }

  // Ensure header/footer are fixed and content is padded correctly
  function applyFixedBars() {
    try {
      const top = document.querySelector('.topbar');
      const foot = document.querySelector('.footer');
      const rootStyle = document.documentElement.style;
      let th = 0, fh = 0;
      if (top) {
        const rect = top.getBoundingClientRect();
        th = Math.ceil((rect && rect.height) || top.offsetHeight || 0);
        top.style.position = 'fixed';
        top.style.top = '0';
        top.style.left = '0';
        top.style.right = '0';
        top.style.zIndex = '100';
      }
      if (foot) {
        const rect = foot.getBoundingClientRect();
        fh = Math.ceil((rect && rect.height) || foot.offsetHeight || 0);
        foot.style.position = 'fixed';
        foot.style.left = '0';
        foot.style.right = '0';
        foot.style.bottom = '0';
        foot.style.zIndex = '100';
      }
      if (th) rootStyle.setProperty('--topbar-h', th + 'px');
      if (fh) rootStyle.setProperty('--footer-h', fh + 'px');
    } catch (e) {
      // noop
    }
  }

  async function initApp() {
    // 1. Load header/footer partials
    await loadPartial('header', '/partials/header.html');
    await loadPartial('footer', '/partials/footer.html');
    applyFixedBars();
    // Populate header/footer network info immediately and on an interval
    try { await updateFooterNet(); } catch (e) {}
    setInterval(updateFooterNet, 5000);
    // Load any persisted history before components mount so charts can show instantly
    loadPersistedHistory();
    window.addEventListener('resize', applyFixedBars);
    window.addEventListener('orientationchange', applyFixedBars);

    // 2. Cache footer elements & status setter
    footer = $('#footerStatus');
    footerHostEl = $('#footerHost');
    footerIPEl = $('#footerIP');
    footerUpdatedEl = $('#footerUpdated');
    setStatus = (t) => (footer ? (footer.textContent = t) : console.log('Status:', t));

    // 3. Tabs activation
    function activateTab(btn) {
      $$('.side-item').forEach((b) => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
      loadComponent(btn.dataset.component || btn.dataset.panel);
    }
    const sideItems = $$('.side-item');
    sideItems.forEach((btn, idx) => {
      btn.setAttribute('tabindex', idx === 0 ? '0' : '-1');
      btn.addEventListener('click', () => activateTab(btn));
      btn.addEventListener('keydown', (e) => {
        const currentIndex = sideItems.indexOf(btn);
        if (e.key === 'ArrowDown') { e.preventDefault(); const next = sideItems[Math.min(sideItems.length - 1, currentIndex + 1)]; next?.focus(); sideItems.forEach(b=>b.setAttribute('tabindex','-1')); next?.setAttribute('tabindex','0'); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); const prev = sideItems[Math.max(0, currentIndex - 1)]; prev?.focus(); sideItems.forEach(b=>b.setAttribute('tabindex','-1')); prev?.setAttribute('tabindex','0'); }
        else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); activateTab(btn); }
      });
    });
    const firstTab = $('.side-item'); if (firstTab) activateTab(firstTab);

    // 4. Burger (sidebar collapse)
    const burger = $('#burger');
    const sidebar = $('#sidebar');
    const savedCollapsed = localStorage.getItem('sidebar-collapsed');
    if (savedCollapsed === 'true') sidebar?.classList.add('collapsed');
    else if (window.matchMedia('(max-width: 980px)').matches) sidebar?.classList.add('collapsed');
    // Reflect initial collapsed state on body for padding-left adjustment
    if (sidebar?.classList.contains('collapsed')) document.body.classList.add('sidebar-collapsed');
    burger?.setAttribute('aria-pressed', sidebar?.classList.contains('collapsed') ? 'true' : 'false');
    sidebar?.setAttribute('aria-expanded', sidebar?.classList.contains('collapsed') ? 'false' : 'true');
    burger?.addEventListener('click', () => {
      sidebar?.classList.toggle('collapsed');
      const isCollapsed = sidebar?.classList.contains('collapsed');
      document.body.classList.toggle('sidebar-collapsed', isCollapsed);
      localStorage.setItem('sidebar-collapsed', isCollapsed ? 'true' : 'false');
      burger?.setAttribute('aria-pressed', isCollapsed ? 'true' : 'false');
      sidebar?.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
    });

    // 5. Live data websocket + fallback polling
    function connectWS() {
      try {
        const socket = new WebSocket(`ws://${location.host}/ws`);
        const badge = $('#connBadge');
        socket.onopen = () => { setStatus('Live data connected'); if (badge){ badge.textContent='Live'; badge.classList.remove('muted'); } };
        socket.onclose = () => { setStatus('Live data disconnected'); if (badge){ badge.textContent='Idle'; badge.classList.add('muted'); } };
        socket.onmessage = (e) => {
          try {
            const pkt = JSON.parse(e.data);
            window.__momo_last = pkt;
            if (document.hidden) return; // avoid catch-up bursts while hidden
            render(pkt);
          } catch (err) {}
        };
      } catch (e) {}
    }
    connectWS();
    setStatus('Initializing...');
    setInterval(async () => {
      if (document.hidden) return; // pause polling when hidden to avoid queued callbacks
      try { const r = await fetch('/api/data'); const d = await r.json(); render(d); } catch(e) {}
    }, 5000);
    // If we restored history, trigger a synthetic event so charts / sparks render immediately
    if (dataHistory.length) {
      try { window.dispatchEvent(new Event('momo-data')); } catch(e) {}
    }

  // 6. Header quick actions
  document.getElementById('hdr-scan')?.addEventListener('click', async ()=>{ try { await fetch('/api/wifi/scan/start'); } catch(e){} });
  document.getElementById('hdr-reconnect')?.addEventListener('click', async ()=>{ try { await fetch('/api/wifi/reconnect', { method:'POST' }); } catch(e){} });
  document.getElementById('hdr-cmd')?.addEventListener('click', ()=>{ const m = document.getElementById('cmdModal'); if (m) { m.style.display='flex'; setTimeout(()=>document.getElementById('cmd-close')?.focus(),0); } });

  // 7. Command palette wiring
    const cmdModal = $('#cmdModal');
    if (cmdModal) {
      const openCmd = () => { cmdModal.style.display='flex'; setTimeout(()=>$('#cmd-close')?.focus(),0); };
      const closeCmd = () => { cmdModal.style.display='none'; };
      document.addEventListener('keydown', (e) => {
        const key = (e.key||'').toLowerCase();
        if (e.ctrlKey && key === 'k'){ e.preventDefault(); openCmd(); }
        if (key === 'escape' && cmdModal.style.display==='flex'){ e.preventDefault(); closeCmd(); }
      });
      cmdModal.addEventListener('click', (e)=>{ if (e.target===cmdModal) closeCmd(); });
      $('#cmd-close')?.addEventListener('click', closeCmd);
      $('#cmd-reboot')?.addEventListener('click', async ()=>{ closeCmd(); try { setStatus('Rebooting...'); await fetch('/api/system/reboot',{method:'POST'}); } catch(e){} });
      $('#cmd-settings')?.addEventListener('click', ()=>{ closeCmd(); $('.side-item[data-panel="settings"]')?.click(); });
      $('#cmd-scan')?.addEventListener('click', async ()=>{ closeCmd(); $('.side-item[data-panel="network"]')?.click(); const scanBtn=$('#scan'); if (scanBtn) scanBtn.click(); else { try { await fetch('/api/wifi/scan/start'); } catch(e){} } });
    }
  }

  // Component loader
  async function loadComponent(name) {
    const view = document.getElementById('view');
    if (!view) return;
    try {
      const r = await fetch(`/components/${name}.html`, { cache: 'no-store' });
      if (!r.ok) throw new Error('failed');
      const html = await r.text();
      try {
        currentCleanup && currentCleanup();
      } catch (e) {}
      currentCleanup = null;
      view.innerHTML = html;
      if (name === 'dashboard') currentCleanup = initDashboardBindings() || null;
      if (name === 'camera') currentCleanup = initCameraBindings() || null;
      if (name === 'network') currentCleanup = initNetworkBindings() || null;
      if (name === 'settings') currentCleanup = initSettingsBindings() || null;
      if (name === 'system') currentCleanup = initSystemBindings() || null;
      // Immediately render last known data into newly loaded component
      try { if (window.__momo_last) render(window.__momo_last); } catch (e) {}
      // Re-apply fixed bar measurements (not strictly needed here, but safe)
      applyFixedBars();
    } catch (e) {
      console.warn('Component load failed', name, e);
      view.innerHTML = `<div class="panel-card">Failed to load component: ${name}</div>`;
    }
  }

  // Render incoming data across UI
  function render(d) {
    const now = Date.now();
    dataHistory.push({ ...d, timestamp: now });
    window.__momo_last = d;
    window.__momo_history = dataHistory;
    if (dataHistory.length > 240) dataHistory.shift();
  // Persist periodically
  persistHistory();

    // Dashboard values
    const unitsEl = $('#units');
    if (unitsEl) unitsEl.textContent = d.units || 'C';
    const tempValueEl = $('#tempValue');
    if (tempValueEl) tempValueEl.textContent = fmt(d.temperature, 1);
    const humValueEl = $('#humValue');
    if (humValueEl) humValueEl.textContent = fmt(d.humidity, 1);
    const dewValueEl = $('#dewValue');
    if (dewValueEl)
      dewValueEl.textContent = Number.isFinite(d.dewPoint)
        ? `${d.dewPoint.toFixed(1)}°${d.units === 'F' ? 'F' : 'C'}`
        : '--';
    const heatValueEl = $('#heatValue');
    if (heatValueEl)
      heatValueEl.textContent = Number.isFinite(d.heatIndex)
        ? `${d.heatIndex.toFixed(1)}°${d.units === 'F' ? 'F' : 'C'}`
        : '--';
    const vpdValueEl = $('#vpdValue');
    if (vpdValueEl) vpdValueEl.textContent = Number.isFinite(d.vpd) ? d.vpd.toFixed(2) + ' kPa' : '--';
    const absHumValueEl = $('#absHumValue');
    if (absHumValueEl)
      absHumValueEl.textContent = Number.isFinite(d.absoluteHumidity)
        ? d.absoluteHumidity.toFixed(2) + ' g/m³'
        : '--';
    // Show Min/Ideal/Max thresholds for Temperature and Humidity
    try {
      const thr = d.thresholds || {};
      const defT = d.units === 'F' ? { min: 65, ideal: 78, max: 90 } : { min: 18, ideal: 25.5, max: 32 };
      const defH = { min: 40, ideal: 55, max: 80 };
      const tMinEl = document.getElementById('tMin');
      const tIdealEl = document.getElementById('tIdeal');
      const tMaxEl = document.getElementById('tMax');
      const hMinEl = document.getElementById('hMin');
      const hIdealEl = document.getElementById('hIdeal');
      const hMaxEl = document.getElementById('hMax');
      const tminV = Number.isFinite(thr.tempMin) ? thr.tempMin : defT.min;
      const tidealV = Number.isFinite(thr.tempIdeal) ? thr.tempIdeal : defT.ideal;
      const tmaxV = Number.isFinite(thr.tempMax) ? thr.tempMax : defT.max;
      const hminV = Number.isFinite(thr.humMin) ? thr.humMin : defH.min;
      const hidealV = Number.isFinite(thr.humIdeal) ? thr.humIdeal : defH.ideal;
      const hmaxV = Number.isFinite(thr.humMax) ? thr.humMax : defH.max;
      if (tMinEl) tMinEl.textContent = `${tminV.toFixed(1)}°`;
      if (tIdealEl) tIdealEl.textContent = `${tidealV.toFixed(1)}°`;
      if (tMaxEl) tMaxEl.textContent = `${tmaxV.toFixed(1)}°`;
      if (hMinEl) hMinEl.textContent = `${hminV.toFixed(0)}%`;
      if (hIdealEl) hIdealEl.textContent = `${hidealV.toFixed(0)}%`;
      if (hMaxEl) hMaxEl.textContent = `${hmaxV.toFixed(0)}%`;
    } catch(e){}
    // Comfort index (0-100): respect user thresholds (min/ideal/max) for temp and humidity
    // Strategy: compute two subscores (TempScore, HumScore) where 100 = ideal, 0 = at/beyond min/max; linearly interpolate.
    // Then comfort = average of the available subscores. Also derive a label using the subscores.
    function subScore(value, minV, idealV, maxV) {
      // Coerce inputs
      const v = typeof value === 'string' ? parseFloat(value) : value;
      const mn = typeof minV === 'string' ? parseFloat(minV) : minV;
      const id = typeof idealV === 'string' ? parseFloat(idealV) : idealV;
      const mx = typeof maxV === 'string' ? parseFloat(maxV) : maxV;
      if (!Number.isFinite(v) || !Number.isFinite(mn) || !Number.isFinite(id) || !Number.isFinite(mx)) return null;
      // Guard invalid ranges: fallback to distance from midpoint mapping
      if (!(mn < id && id < mx)) {
        const span = Math.max(1e-6, mx - mn);
        const mid = (mn + mx) / 2;
        const dev = Math.min(1, Math.abs(v - mid) / (span / 2));
        return Math.round(100 * (1 - dev));
      }
      const lowSpan = Math.max(1e-6, id - mn);
      const highSpan = Math.max(1e-6, mx - id);
      // At ideal: 100
      if (v === id) return 100;
      // Between min..ideal: 50..100
      if (v > mn && v < id) {
        return 50 + 50 * ((v - mn) / lowSpan);
      }
      // Between ideal..max: 50..100
      if (v > id && v < mx) {
        return 50 + 50 * ((mx - v) / highSpan);
      }
      // At min/max: 50
      if (v === mn || v === mx) return 50;
      // Below min: taper 0..50 over an extra lowSpan
      if (v < mn) {
        const t = (v - (mn - lowSpan)) / lowSpan; // v = mn -> t=1; v = mn-lowSpan -> t=0
        return Math.max(0, Math.min(50, 50 * t));
      }
      // Above max: taper 0..50 over an extra highSpan
      if (v > mx) {
        const t = ((mx + highSpan) - v) / highSpan; // v = mx -> t=1; v = mx+highSpan -> t=0
        return Math.max(0, Math.min(50, 50 * t));
      }
      return null;
    }
    // Pull thresholds with sensible defaults
    const thr = d.thresholds || {};
    const defT = d.units === 'F' ? { min: 65, ideal: 78, max: 90 } : { min: 18, ideal: 25.5, max: 32 };
    const defH = { min: 40, ideal: 55, max: 80 };
  const toNum = (v) => (typeof v === 'string' ? parseFloat(v) : v);
  const tminV = Number.isFinite(toNum(thr.tempMin)) ? toNum(thr.tempMin) : defT.min;
  const tidealV = Number.isFinite(toNum(thr.tempIdeal)) ? toNum(thr.tempIdeal) : defT.ideal;
  const tmaxV = Number.isFinite(toNum(thr.tempMax)) ? toNum(thr.tempMax) : defT.max;
  const hminV = Number.isFinite(toNum(thr.humMin)) ? toNum(thr.humMin) : defH.min;
  const hidealV = Number.isFinite(toNum(thr.humIdeal)) ? toNum(thr.humIdeal) : defH.ideal;
  const hmaxV = Number.isFinite(toNum(thr.humMax)) ? toNum(thr.humMax) : defH.max;
  // Use actual temperature for comfort scoring; heat index can unfairly depress score in mild humidity
  const tempLike = d.temperature;
    const tScore = subScore(tempLike, tminV, tidealV, tmaxV);
    const hScore = subScore(d.humidity, hminV, hidealV, hmaxV);
    let comfortScore = null;
    if (Number.isFinite(tScore) && Number.isFinite(hScore)) comfortScore = (tScore + hScore) / 2;
    else if (Number.isFinite(tScore)) comfortScore = tScore;
    else if (Number.isFinite(hScore)) comfortScore = hScore;
    // Fallback: original heuristic if thresholds are unusable
    if (!Number.isFinite(comfortScore)) {
      if (Number.isFinite(tempLike) && Number.isFinite(d.humidity)) {
        const idealT = d.units === 'F' ? 78 : 25.5;
        const tPenalty = Math.min(100, Math.abs(tempLike - idealT) * 4);
        const hPenalty = Math.min(100, Math.abs(d.humidity - 65) * 2);
        comfortScore = Math.max(0, 100 - (tPenalty + hPenalty) / 2);
      }
    }
    d.__comfort = Number.isFinite(comfortScore) ? comfortScore : d.__comfort;
    // Derive label: if comfort thresholds provided, mark Perfect when within [comfortMin, comfortMax]
    let comfortLabel = 'Caution';
    const cmin = Number.isFinite(toNum(thr.comfortMin)) ? toNum(thr.comfortMin) : null;
    const cmax = Number.isFinite(toNum(thr.comfortMax)) ? toNum(thr.comfortMax) : null;
    if (Number.isFinite(d.__comfort) && cmin != null && cmax != null) {
      if (d.__comfort >= cmin && d.__comfort <= cmax) comfortLabel = 'Perfect';
      else if (d.__comfort < cmin - 10) comfortLabel = 'Alert';
      else comfortLabel = 'Caution';
    } else if (Number.isFinite(tScore) && Number.isFinite(hScore)) {
      if (tScore >= 80 && hScore >= 80) comfortLabel = 'Perfect';
      else if (tScore <= 25 || hScore <= 25) comfortLabel = 'Alert';
      else comfortLabel = 'Caution';
    } else if (Number.isFinite(d.__comfort)) {
      if (d.__comfort >= 80) comfortLabel = 'Perfect';
      else if (d.__comfort < 25) comfortLabel = 'Alert';
      else comfortLabel = 'Caution';
    }
    d.__comfortLabel = comfortLabel;
    const comfortEl = $('#comfortValue');
    if (comfortEl) comfortEl.textContent = Number.isFinite(d.__comfort) ? d.__comfort.toFixed(0) : '--';
    const heatMini = $('#heatValueMini'); if (heatMini) heatMini.textContent = Number.isFinite(d.heatIndex) ? d.heatIndex.toFixed(1) + '°' + (d.units === 'F' ? 'F' : 'C') : '--';
    const dewMini = $('#dewValueMini'); if (dewMini) dewMini.textContent = Number.isFinite(d.dewPoint) ? d.dewPoint.toFixed(1) + '°' + (d.units === 'F' ? 'F' : 'C') : '--';
    // Deltas (vs previous reading)
    const prev = dataHistory.length > 1 ? dataHistory[dataHistory.length - 2] : null;
    const tDelta = prev && Number.isFinite(d.temperature) && Number.isFinite(prev.temperature) ? d.temperature - prev.temperature : null;
    const hDelta = prev && Number.isFinite(d.humidity) && Number.isFinite(prev.humidity) ? d.humidity - prev.humidity : null;
    const tempDeltaEl = $('#tempDelta'); if (tempDeltaEl) tempDeltaEl.textContent = tDelta === null ? '--' : `${tDelta >= 0 ? '+' : ''}${tDelta.toFixed(1)}°`;
    const humDeltaEl = $('#humDelta'); if (humDeltaEl) humDeltaEl.textContent = hDelta === null ? '--' : `${hDelta >= 0 ? '+' : ''}${hDelta.toFixed(1)}%`;

    // Status badges
    const map = { Perfect: 'ok', Caution: 'warn', 'Too Hot': 'bad', 'Too Cold': 'bad', 'Too Wet': 'bad', 'Too Dry': 'bad' };
    const t = $('#tempStatus');
    const h = $('#humStatus');
    if (t) {
      t.textContent = d.tempStatus || '--';
      t.className = 'status-badge ' + (map[d.tempStatus] || 'warn');
    }
    if (h) {
      h.textContent = d.humStatus || '--';
      h.className = 'status-badge ' + (map[d.humStatus] || 'warn');
    }
    // Comfort status classification based on score
    const comfortStatusEl = document.getElementById('comfortStatus');
    if (comfortStatusEl) {
      const label = d.__comfortLabel || 'Caution';
      comfortStatusEl.textContent = label;
      const clsMap = { Perfect: 'ok', Caution: 'warn', Alert: 'bad' };
      comfortStatusEl.className = 'status-badge ' + (clsMap[label] || 'warn');
    }

    // Top card subtle status borders
    try {
      const cardT = document.getElementById('cardTemp');
      const cardH = document.getElementById('cardHum');
      const cardC = document.getElementById('cardComfort');
      const clsFor = (status)=> ({ ok:'status-ok', warn:'status-warn', bad:'status-bad' })[status] || '';
      function setCard(el, statusKey){
        if (!el) return;
        el.classList.remove('status-ok','status-warn','status-bad');
        const badge = { temp: d.tempStatus, hum: d.humStatus, comfort: (d.__comfortLabel || (Number.isFinite(d.__comfort)?(d.__comfort>=80?'Perfect': d.__comfort<25?'Alert':'Caution'):'Caution')) }[statusKey];
        const map2 = { 'Perfect':'ok', 'Caution':'warn', 'Alert':'bad', 'Too Hot':'bad', 'Too Cold':'bad', 'Too Wet':'bad', 'Too Dry':'bad' };
        el.classList.add(clsFor(map2[badge] || 'warn'));
      }
      setCard(cardT, 'temp');
      setCard(cardH, 'hum');
      setCard(cardC, 'comfort');
    } catch(e){}

    updateTrends(d);
    updateStatistics(d);

    // System panel
    const uptimeEl = $('#uptime');
    if (uptimeEl) uptimeEl.textContent = d.system?.uptime ? (d.system.uptime / 60000).toFixed(1) + ' min' : '--';
    const cpuEl = $('#cpu');
    if (cpuEl) cpuEl.textContent = d.system?.cpuFreq ? d.system.cpuFreq + ' MHz' : '--';
    const heapEl = $('#heap');
    if (heapEl) heapEl.textContent = d.system?.freeHeap ? formatBytes(d.system.freeHeap) : '--';
    // Extended system details (if present)
    const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v ?? '--'; };
    setText('sys-host', d.system?.hostname || '--');
    setText('sys-ip', d.system?.ip || '--');
    setText('sys-ssid', d.ssid || '--');
    setText('sys-rssi', Number.isFinite(d?.system?.rssi) ? d.system.rssi + ' dBm' : '--');
    setText('heapTotal', (d.system?.heapSize != null) ? formatBytes(d.system.heapSize) : '--');
    setText('psramFree', (d.system?.freePsram != null) ? formatBytes(d.system.freePsram) : '--');
    setText('psramSize', (d.system?.psramSize != null) ? formatBytes(d.system.psramSize) : '--');
    setText('flashSize', (d.system?.flashSize != null) ? formatBytes(d.system.flashSize) : '--');
    setText('flashSpeed', (d.system?.flashSpeed != null) ? (d.system.flashSpeed/1000000) + ' MHz' : '--');
    setText('sketchSize', (d.system?.sketchSize != null) ? formatBytes(d.system.sketchSize) : '--');
    setText('sketchFree', (d.system?.freeSketch != null) ? formatBytes(d.system.freeSketch) : '--');
    setText('fsUsed', (d.system?.fsUsed != null) ? formatBytes(d.system.fsUsed) : '--');
    setText('fsTotal', (d.system?.fsTotal != null) ? formatBytes(d.system.fsTotal) : '--');
    setText('sys-sdk', d.system?.sdk || '--');
    setText('sys-chip', d.system?.chipModel || '--');
    setText('sys-rev', (d.system?.chipRev != null) ? String(d.system.chipRev) : '--');
    setText('mac-sta', d.system?.macSta || '--');
    setText('mac-ap', d.system?.macAp || '--');
    setText('hostn2', d.system?.hostname || '--');
    setText('ip2', d.system?.ip || '--');
    setText('mdns2', (typeof d?.system?.hostname === 'string' && d.system.hostname) ? (d.system.hostname + '.local') : '--');

    // Badges
    const bMode = document.getElementById('badge-mode');
    if (bMode) {
      const m = d.system?.wifiMode || '--';
      bMode.textContent = m.toUpperCase();
      bMode.classList.remove('ok','warn','bad');
      if (m === 'sta') bMode.classList.add('ok');
      else if (m === 'ap+sta') bMode.classList.add('warn');
      else if (m === 'ap' || m === 'off') bMode.classList.add('bad');
    }
    const bMDNS = document.getElementById('badge-mdns');
    if (bMDNS) {
      const on = !!d.system?.mdns;
      bMDNS.textContent = on ? 'mDNS On' : 'mDNS Off';
      bMDNS.classList.remove('ok','warn','bad');
      bMDNS.classList.add(on ? 'ok' : 'bad');
    }

    // Meters
    const setMeter = (id, used, total) => {
      const el = document.getElementById(id);
      if (!el || !Number.isFinite(total) || total <= 0) return;
      const pct = Math.max(0, Math.min(100, (used / total) * 100));
      el.style.width = pct.toFixed(0) + '%';
    };
    // Heap meter: used = total - free
    if (Number.isFinite(d?.system?.heapSize) && Number.isFinite(d?.system?.freeHeap)) {
      setMeter('heapMeter', d.system.heapSize - d.system.freeHeap, d.system.heapSize);
    }
    if (Number.isFinite(d?.system?.psramSize) && Number.isFinite(d?.system?.freePsram)) {
      setMeter('psramMeter', d.system.psramSize - d.system.freePsram, d.system.psramSize);
    }
    if (Number.isFinite(d?.system?.fsTotal) && Number.isFinite(d?.system?.fsUsed)) {
      setMeter('fsMeter', d.system.fsUsed, d.system.fsTotal);
    }
  const sHzEl = $('#sensorHz'); if (sHzEl) sHzEl.textContent = Number.isFinite(d.system?.sensorHz) ? d.system.sensorHz.toFixed(2) : '--';
  const dHzEl = $('#displayHz'); if (dHzEl) dHzEl.textContent = Number.isFinite(d.system?.displayHz) ? d.system.displayHz.toFixed(2) : '--';

  // Quick Info
    const qiHost = $('#qi-host');
  if (qiHost) qiHost.textContent = d?.system ? d.system.hostname || '' : '';
    const qiIP = $('#qi-ip');
  if (qiIP) qiIP.textContent = d?.system ? d.system.ip || '' : '';
    const qiSSID = $('#qi-ssid');
  if (qiSSID) qiSSID.textContent = (d && typeof d.ssid === 'string' && d.ssid.length) ? d.ssid : '--';
  // Header center stats mirror
  const hHost = document.getElementById('headerHost'); if (hHost) hHost.textContent = d?.system?.hostname || '--';
  const hIP = document.getElementById('headerIP'); if (hIP) hIP.textContent = d?.system?.ip || '--';
  const hSSID = document.getElementById('headerSSID'); if (hSSID) hSSID.textContent = d?.ssid || '--';
    const qiRSSI = $('#qi-rssi');
    if (qiRSSI) qiRSSI.textContent = Number.isFinite(d?.system?.rssi) ? `${d.system.rssi} dBm` : '--';
    const qiCam = $('#qi-camera');
    if (qiCam) qiCam.textContent = d?.system?.camera ? 'Online' : 'Offline';
    const qiUnits = $('#qi-units'); if (qiUnits) qiUnits.textContent = d?.units || '--';
    const qiMode = $('#qi-mode'); if (qiMode) {
      const ip = d?.system?.ip || '';
      qiMode.textContent = ip.startsWith('192.168.4.') ? 'AP' : 'STA';
    }

    // Rates and counts
    statsCounter++;
    const dataRateEl = $('#dataRate');
    if (dataRateEl) {
      dataRateEl.textContent = dataHistory.length > 1 ? (1000 / ((now - dataHistory[dataHistory.length - 2].timestamp) || 1000)).toFixed(1) + ' Hz' : '--';
    }
    const readingCountEl = $('#readingCount');
    if (readingCountEl) readingCountEl.textContent = statsCounter.toLocaleString();
    const errorRateEl = $('#errorRate');
    if (errorRateEl) errorRateEl.textContent = d.system?.errorRate ? d.system.errorRate.toFixed(1) + '%' : '0.0%';

    // Footer
    const tf = d.units === 'F';
    const temp = Number.isFinite(d.temperature) ? d.temperature.toFixed(1) + '°' + (tf ? 'F' : 'C') : '--';
    const hum = Number.isFinite(d.humidity) ? d.humidity.toFixed(1) + '%' : '--';
  setStatus(`Temp ${temp} • RH ${hum} • ${statsCounter} readings`);
    if (footerUpdatedEl) footerUpdatedEl.textContent = new Date().toLocaleTimeString();
    footerTempEl = footerTempEl || $('#footerTemp');
    footerHumEl = footerHumEl || $('#footerHum');
  footerWifiEl = footerWifiEl || $('#footerWifi');
  footerRssiEl = footerRssiEl || $('#footerRssi');
    footerCamEl = footerCamEl || $('#footerCam');
    if (footerTempEl) footerTempEl.textContent = Number.isFinite(d.temperature) ? `${d.temperature.toFixed(1)}°${tf ? 'F' : 'C'}` : '--';
    if (footerHumEl) footerHumEl.textContent = Number.isFinite(d.humidity) ? `${d.humidity.toFixed(1)}%` : '--';
  // SSID and RSSI are maintained by updateFooterNet(); avoid overwriting to prevent flicker
    if (footerCamEl) footerCamEl.textContent = d?.system?.camera ? 'On' : 'Off';

    // Notify listeners (e.g., chart) to redraw
    try {
      window.dispatchEvent(new Event('momo-data'));
    } catch (e) {}

    updateMoodLine(d);
  }

  // Mood line logic ------------------------------------------------------
  const moodElGetter = () => document.getElementById('moodLine');
  let lastMoodUpdate = 0;
  let lastMoodBucket = null;
  const MOOD_MIN_INTERVAL = 12000; // min time before we allow another change
  const MOOD_ROTATE_INTERVAL = 45000; // force rotation every 45s even if bucket constant
  const phrases = {
    good: [
      'Conditions optimal', 'Environment within target range', 'Stable and on target', 'Comfort level: optimal', 'All parameters nominal'
    ],
    fair: [
      'Minor deviation from targets', 'Slight adjustment recommended', 'Near target range', 'Monitor and fine‑tune', 'Conditions acceptable'
    ],
    bad_hot: [
      'Temperature above target range', 'Reduce heat to return to range', 'High temperature detected', 'Cooling adjustment required'
    ],
    bad_cold: [
      'Temperature below target range', 'Increase heat to return to range', 'Low temperature detected', 'Heating adjustment required'
    ],
    bad_wet: [
      'Humidity above target range', 'Increase ventilation or reduce moisture', 'High humidity detected', 'Dehumidifying adjustment required'
    ],
    bad_dry: [
      'Humidity below target range', 'Increase misting or moisture', 'Low humidity detected', 'Humidifying adjustment required'
    ],
    bad_hot_wet: [
      'Temp and humidity above targets', 'Reduce heat and humidity', 'High temp and humidity detected', 'Cooling and ventilation recommended'
    ],
    bad_hot_dry: [
      'Temp above target; humidity low', 'Reduce heat and increase humidity', 'Hot and dry conditions detected', 'Cooling and humidifying recommended'
    ],
    bad_cold_wet: [
      'Temp below target; humidity high', 'Increase heat and reduce humidity', 'Cold and damp conditions detected', 'Heating and ventilation recommended'
    ],
    bad_cold_dry: [
      'Temp and humidity below targets', 'Increase heat and humidity', 'Cold and dry conditions detected', 'Heating and humidifying recommended'
    ]
  };
  function pick(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
  const recentPhrases = [];
  const RECENT_LIMIT = 6;
  function remember(line){ recentPhrases.push(line); while(recentPhrases.length>RECENT_LIMIT) recentPhrases.shift(); }
  function pickFresh(arr){
    const pool = arr.filter(p => !recentPhrases.includes(p));
    if (pool.length === 0) return arr[Math.floor(Math.random()*arr.length)];
    return pool[Math.floor(Math.random()*pool.length)];
  }
  function updateMoodLine(d){
    const el = moodElGetter(); if(!el) return;
    const now = Date.now();
    const tempLike = Number.isFinite(d?.heatIndex) ? d.heatIndex : d?.temperature;
    const hum = d?.humidity;
    if(!Number.isFinite(tempLike) || !Number.isFinite(hum)) return;
    // Pull thresholds dynamically
    const thr = d?.thresholds || {};
    const toNum = (v) => (typeof v === 'string' ? parseFloat(v) : v);
    const defT = d?.units === 'F' ? { min: 65, ideal: 78, max: 90 } : { min: 18, ideal: 25.5, max: 32 };
    const defH = { min: 40, ideal: 55, max: 80 };
    const tmin = Number.isFinite(toNum(thr.tempMin)) ? toNum(thr.tempMin) : defT.min;
    const tideal = Number.isFinite(toNum(thr.tempIdeal)) ? toNum(thr.tempIdeal) : defT.ideal;
    const tmax = Number.isFinite(toNum(thr.tempMax)) ? toNum(thr.tempMax) : defT.max;
    const hmin = Number.isFinite(toNum(thr.humMin)) ? toNum(thr.humMin) : defH.min;
    const hideal = Number.isFinite(toNum(thr.humIdeal)) ? toNum(thr.humIdeal) : defH.ideal;
    const hmax = Number.isFinite(toNum(thr.humMax)) ? toNum(thr.humMax) : defH.max;
    // Subscore consistent with comfort calc (soft edges at min/max)
    function subScore(v, mn, id, mx){
      const val = toNum(v); const a=toNum(mn), b=toNum(id), c=toNum(mx);
      if (!Number.isFinite(val) || !Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) return NaN;
      if (!(a < b && b < c)) {
        const span = Math.max(1e-6, c - a); const mid = (a+c)/2; const dev = Math.min(1, Math.abs(val-mid)/(span/2));
        return 100 * (1 - dev);
      }
      const lowSpan = Math.max(1e-6, b-a), highSpan = Math.max(1e-6, c-b);
      if (val === b) return 100;
      if (val > a && val < b) return 50 + 50 * ((val - a)/lowSpan);
      if (val > b && val < c) return 50 + 50 * ((c - val)/highSpan);
      if (val === a || val === c) return 50;
      if (val < a) return Math.max(0, Math.min(50, 50 * ((val - (a - lowSpan))/lowSpan)));
      if (val > c) return Math.max(0, Math.min(50, 50 * (((c + highSpan) - val)/highSpan)));
      return NaN;
    }
    const tScore = subScore(tempLike, tmin, tideal, tmax);
    const hScore = subScore(hum, hmin, hideal, hmax);
    const comfortScore = Number.isFinite(d?.__comfort) ? d.__comfort : (Number.isFinite(tScore)&&Number.isFinite(hScore)?(tScore+hScore)/2: (Number.isFinite(tScore)?tScore:hScore));
    // Directional checks tied to thresholds
    const tooHot = tempLike > tmax;
    const tooCold = tempLike < tmin;
    const tooWet = hum > hmax;
    const tooDry = hum < hmin;
    // Base bucket from subscores
    let baseBucket = 'good';
    if (!Number.isFinite(comfortScore) || comfortScore < 85) baseBucket = 'fair';
    // Combined directional states take priority when both temp and humidity are out of range
    let state = baseBucket;
    if ((tooHot || tooCold) && (tooWet || tooDry)) {
      if (tooHot && tooWet) state = 'bad_hot_wet';
      else if (tooHot && tooDry) state = 'bad_hot_dry';
      else if (tooCold && tooWet) state = 'bad_cold_wet';
      else if (tooCold && tooDry) state = 'bad_cold_dry';
    } else {
      // Single directional states when only one dimension is out of range
      if (tooHot) state = 'bad_hot';
      else if (tooWet) state = 'bad_wet';
      else if (tooCold) state = 'bad_cold';
      else if (tooDry) state = 'bad_dry';
    }
    // IMMEDIATE change if bucket changed (state != lastMoodBucket)
    if (state === lastMoodBucket) {
      // Same bucket: only rotate phrase if min interval passed or forced rotation interval reached
      if (now - lastMoodUpdate < MOOD_MIN_INTERVAL) return;
      if (now - lastMoodUpdate < MOOD_ROTATE_INTERVAL) return;
    }
    lastMoodUpdate = now; lastMoodBucket = state;
  el.className = 'mood ' + (state.startsWith('bad') ? 'bad' : state);
  // Expose raw computed state for debugging & potential styling
  try { el.dataset.state = state; el.title = state.replace('_',' / '); } catch(_){ }
    const pool = phrases[state] || phrases[baseBucket] || phrases.good;
    const line = pickFresh(pool);
    el.textContent = line;
    remember(line);
  }

  function updateTrends(d) {
    if (lastValues.temperature !== null) {
      const diff = d.temperature - lastValues.temperature;
      const el = $('#tempTrend');
      const txt = $('#tempTrendText');
      if (el && txt) {
        if (Math.abs(diff) < 0.1) {
          el.textContent = '●';
          el.style.color = 'var(--neutral-400)';
          txt.textContent = 'Stable';
        } else if (diff > 0) {
          el.textContent = '↗';
          el.style.color = 'var(--danger-500)';
          txt.textContent = `+${diff.toFixed(1)}°`;
        } else {
          el.textContent = '↘';
          el.style.color = 'var(--primary-500)';
          txt.textContent = `${diff.toFixed(1)}°`;
        }
      }
    }
    if (lastValues.humidity !== null) {
      const diff = d.humidity - lastValues.humidity;
      const el = $('#humTrend');
      const txt = $('#humTrendText');
      if (el && txt) {
        if (Math.abs(diff) < 0.5) {
          el.textContent = '●';
          el.style.color = 'var(--neutral-400)';
          txt.textContent = 'Stable';
        } else if (diff > 0) {
          el.textContent = '↗';
          el.style.color = 'var(--primary-500)';
          txt.textContent = `+${diff.toFixed(1)}%`;
        } else {
          el.textContent = '↘';
          el.style.color = 'var(--warning-500)';
          txt.textContent = `${diff.toFixed(1)}%`;
        }
      }
    }
    // Comfort trend
    if (Number.isFinite(d.__comfort) && lastValues.comfort !== null) {
      const diff = d.__comfort - lastValues.comfort;
      const el = document.getElementById('comfortTrend');
      const txt = document.getElementById('comfortTrendText');
      if (el && txt) {
        if (Math.abs(diff) < 0.5) { el.textContent = '●'; el.style.color = 'var(--neutral-400)'; txt.textContent = 'Stable'; }
        else if (diff > 0) { el.textContent = '↗'; el.style.color = 'var(--primary-500)'; txt.textContent = `+${diff.toFixed(0)}`; }
        else { el.textContent = '↘'; el.style.color = 'var(--warning-500)'; txt.textContent = `${diff.toFixed(0)}`; }
      }
    }
    if (Number.isFinite(d.__comfort)) lastValues.comfort = d.__comfort;
    if (Number.isFinite(d.temperature)) lastValues.temperature = d.temperature;
    if (Number.isFinite(d.humidity)) lastValues.humidity = d.humidity;
  }

  function updateStatistics(d) {
    if (dataHistory.length < 2) return;
    const temps = dataHistory.map((h) => h.temperature).filter((t) => Number.isFinite(t));
    const hums = dataHistory.map((h) => h.humidity).filter((h) => Number.isFinite(h));
    if (temps.length > 0) {
      const tmin = Math.min(...temps);
      const tmax = Math.max(...temps);
      const tavg = temps.reduce((a, b) => a + b, 0) / temps.length;
      const tempRangeEl = $('#tempRange');
      if (tempRangeEl) tempRangeEl.textContent = `${tmin.toFixed(1)}° - ${tmax.toFixed(1)}°`;
      const tempAvgEl = $('#tempAvg');
      if (tempAvgEl) tempAvgEl.textContent = `${tavg.toFixed(1)}°`;
    }
    if (hums.length > 0) {
      const hmin = Math.min(...hums);
      const hmax = Math.max(...hums);
      const havg = hums.reduce((a, b) => a + b, 0) / hums.length;
      const humRangeEl = $('#humRange');
      if (humRangeEl) humRangeEl.textContent = `${hmin.toFixed(1)}% - ${hmax.toFixed(1)}%`;
      const humAvgEl = $('#humAvg');
      if (humAvgEl) humAvgEl.textContent = `${havg.toFixed(1)}%`;
    }
    const comforts = dataHistory.map(h => h.__comfort).filter(c => Number.isFinite(c));
    if (comforts.length > 0) {
      const cmin = Math.min(...comforts); const cmax = Math.max(...comforts); const cavg = comforts.reduce((a,b)=>a+b,0)/comforts.length;
      const crEl = document.getElementById('comfortRange'); if (crEl) crEl.textContent = `${cmin.toFixed(0)} - ${cmax.toFixed(0)}`;
      const caEl = document.getElementById('comfortAvg'); if (caEl) caEl.textContent = `${cavg.toFixed(0)}`;
    }
  }

  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  let lastNet = { ssid: null, ip: null, host: null, rssi: null };
  let netUpdating = false;
  async function updateFooterNet() {
    if (netUpdating) return; // simple debounce
    try {
      netUpdating = true;
      const r = await fetch('/api/wifi/status');
      const d = await r.json();
  const nextHost = d.hostname || '--';
  const nextIP = d.ip || '--';
      // Prefer STA SSID; if not connected and AP is active, show AP SSID
      const nextSSID = (d && typeof d.ssid === 'string' && d.ssid.length) ? d.ssid : (d && d.ap && d.ap_ssid ? d.ap_ssid : '--');
      const nextRSSI = (typeof d.rssi === 'number' && d.rssi !== 0) ? `${d.rssi} dBm` : '--';
      if (footerHostEl && lastNet.host !== nextHost) { footerHostEl.textContent = nextHost; lastNet.host = nextHost; }
      if (footerIPEl && lastNet.ip !== nextIP) { footerIPEl.textContent = nextIP; lastNet.ip = nextIP; }
  // Header SSID removed; only update footer
      const fWifi = document.getElementById('footerWifi'); if (fWifi && lastNet.ssid !== nextSSID) { fWifi.textContent = nextSSID; }
      lastNet.ssid = nextSSID;
      const fRssi = document.getElementById('footerRssi'); if (fRssi && lastNet.rssi !== nextRSSI) { fRssi.textContent = nextRSSI; lastNet.rssi = nextRSSI; }
    } catch (e) {}
    finally { netUpdating = false; }
  }

  // Component-specific bindings and cleanups
  function initDashboardBindings() {
    // Chart
    const canvas = document.getElementById('chart');
    // Chart control elements
    const tempMinInput = document.getElementById('chartTempMin');
    const tempMaxInput = document.getElementById('chartTempMax');
    const humMinInput  = document.getElementById('chartHumMin');
    const humMaxInput  = document.getElementById('chartHumMax');
    const autoscaleBtn = document.getElementById('chartAutoscale');
    const fitBtn = document.getElementById('chartFit');
    const pauseBtn = document.getElementById('chartPause');
    const exportBtn = document.getElementById('chartExport');
  let manualScale = { tMin: null, tMax: null, hMin: null, hMax: null };
  let autoscale = true;
  let paused = false;
  const SCALE_KEY = 'momo-chart-scale-v1';
  const VIEW_KEY = 'momo-chart-view-v1';
  const STATE_KEY = 'momo-chart-state-v1';
    function reflectButtons(){
      autoscaleBtn?.classList.toggle('on', autoscale);
      pauseBtn?.classList.toggle('on', paused);
    }
    // Series colors (persisted)
    const COLOR_KEY = 'momo-chart-colors-v1';
    function loadColors(){
      try { const raw = localStorage.getItem(COLOR_KEY); if (raw) return JSON.parse(raw); } catch(e){}
      // defaults fallback to CSS theme values
      const styles = getComputedStyle(document.documentElement);
      return {
        temp: styles.getPropertyValue('--primary-500')?.trim() || '#60a5fa',
        hum:  styles.getPropertyValue('--neutral-500')?.trim() || '#9ca3af'
      };
    }
    function saveColors(){ try { localStorage.setItem(COLOR_KEY, JSON.stringify(chartColors)); } catch(e){} }
    let chartColors = loadColors();
    function applyLegendColors(){
      const tDot = document.querySelector('.legend .dot.temp');
      const hDot = document.querySelector('.legend .dot.hum');
      const tInp = document.getElementById('clrTemp');
      const hInp = document.getElementById('clrHum');
      if (tDot) tDot.style.backgroundColor = chartColors.temp;
      if (hDot) hDot.style.backgroundColor = chartColors.hum;
      if (tInp) tInp.value = chartColors.temp;
      if (hInp) hInp.value = chartColors.hum;
    }
    function setupColorPicker(){
      const tInp = document.getElementById('clrTemp');
      const hInp = document.getElementById('clrHum');
      tInp?.addEventListener('input', ()=>{ chartColors.temp = tInp.value; applyLegendColors(); saveColors(); if (typeof redrawSparks==='function') try{redrawSparks();}catch(e){}; drawHandler && drawHandler(); });
      hInp?.addEventListener('input', ()=>{ chartColors.hum  = hInp.value; applyLegendColors(); saveColors(); if (typeof redrawSparks==='function') try{redrawSparks();}catch(e){}; drawHandler && drawHandler(); });
    }
    // Initialize legend colors and pickers
    applyLegendColors();
    setupColorPicker();
    // Provide sensible defaults based on units (best-known ranges)
    function defaultsFor(units){
      if (units === 'F') {
        return { tMin: 65, tMax: 90, hMin: 40, hMax: 80 };
      }
      // Celsius defaults
      return { tMin: 18, tMax: 32, hMin: 40, hMax: 80 };
    }
    // On first load, sync inputs and manualScale with defaults based on last known units
    try {
      const last = window.__momo_last || {};
      const units = last.units === 'F' ? 'F' : 'C';
      const def = defaultsFor(units);
      manualScale = { ...def };
      autoscale = false;
      if (tempMinInput) tempMinInput.value = String(def.tMin);
      if (tempMaxInput) tempMaxInput.value = String(def.tMax);
      if (humMinInput) humMinInput.value = String(def.hMin);
      if (humMaxInput) humMaxInput.value = String(def.hMax);
    } catch(e) { /* ignore */ }
  reflectButtons();
  function saveState(){ try { localStorage.setItem(STATE_KEY, JSON.stringify({ autoscale, paused })); } catch(e){} }
  function saveScale(){ try { localStorage.setItem(SCALE_KEY, JSON.stringify({ manualScale, autoscale })); } catch(e){} }
  function loadScale(){ try { const raw = localStorage.getItem(SCALE_KEY); if (!raw) return null; return JSON.parse(raw); } catch(e){ return null; } }
  function saveView(view){ try { localStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch(e){} }
  function loadView(){ try { const raw = localStorage.getItem(VIEW_KEY); if (!raw) return null; return JSON.parse(raw); } catch(e){ return null; } }
  autoscaleBtn?.addEventListener('click', ()=>{ autoscale = !autoscale; if (autoscale){ manualScale = { tMin:null,tMax:null,hMin:null,hMax:null }; } reflectButtons(); saveScale(); saveState(); drawHandler && drawHandler(); });
  pauseBtn?.addEventListener('click', ()=>{ paused = !paused; reflectButtons(); saveState(); });
    fitBtn?.addEventListener('click', ()=>{
      const hist = window.__momo_history || [];
      const temps = hist.map(h=>h.temperature).filter(Number.isFinite);
      const hums  = hist.map(h=>h.humidity).filter(Number.isFinite);
      if (!temps.length || !hums.length) return;
      manualScale.tMin = Math.min(...temps);
      manualScale.tMax = Math.max(...temps);
      manualScale.hMin = Math.min(...hums);
      manualScale.hMax = Math.max(...hums);
      autoscale = false;
      if (tempMinInput) tempMinInput.value = manualScale.tMin.toFixed(1);
      if (tempMaxInput) tempMaxInput.value = manualScale.tMax.toFixed(1);
      if (humMinInput) humMinInput.value = manualScale.hMin.toFixed(1);
      if (humMaxInput) humMaxInput.value = manualScale.hMax.toFixed(1);
      reflectButtons(); saveScale(); saveState(); drawHandler && drawHandler();
    });
    exportBtn?.addEventListener('click', ()=>{
      try {
        const link = document.createElement('a');
        link.download = 'momo-chart-' + Date.now() + '.png';
        link.href = canvas.toDataURL('image/png');
        link.click();
      } catch(e) { console.warn('Export failed', e); }
    });
    function readManualInputs(){
      function num(v){ const n = parseFloat(v); return Number.isFinite(n) ? n : null; }
      manualScale.tMin = num(tempMinInput?.value);
      manualScale.tMax = num(tempMaxInput?.value);
      manualScale.hMin = num(humMinInput?.value);
      manualScale.hMax = num(humMaxInput?.value);
      autoscale = !(manualScale.tMin!==null || manualScale.tMax!==null || manualScale.hMin!==null || manualScale.hMax!==null);
      reflectButtons();
    }
    [tempMinInput,tempMaxInput,humMinInput,humMaxInput].forEach(inp => inp?.addEventListener('change', ()=>{ readManualInputs(); saveScale(); drawHandler && drawHandler(); }));
  reflectButtons();
    // Try to restore prior saved scale
    const savedScale = loadScale();
    const stateRaw = (()=>{ try { return localStorage.getItem(STATE_KEY); } catch(e){ return null; } })();
    if (stateRaw) {
      try { const st = JSON.parse(stateRaw); if (typeof st.autoscale==='boolean') autoscale = st.autoscale; if (typeof st.paused==='boolean') paused = st.paused; } catch(e){}
    }
    if (savedScale) {
      manualScale = savedScale.manualScale || manualScale;
      if (typeof savedScale.autoscale === 'boolean') autoscale = savedScale.autoscale;
      if (manualScale) {
        if (tempMinInput && manualScale.tMin != null) tempMinInput.value = String(manualScale.tMin);
        if (tempMaxInput && manualScale.tMax != null) tempMaxInput.value = String(manualScale.tMax);
        if (humMinInput && manualScale.hMin != null) humMinInput.value = String(manualScale.hMin);
        if (humMaxInput && manualScale.hMax != null) humMaxInput.value = String(manualScale.hMax);
      }
      reflectButtons();
    }
  let ro, drawHandler, intervalId;
    let viewStart = 0; // 0..1 relative view window start
    let viewEnd = 1;   // 0..1 relative view window end
    const savedView = loadView();
    if (savedView && Number.isFinite(savedView.viewStart) && Number.isFinite(savedView.viewEnd)) {
      viewStart = Math.max(0, Math.min(1, savedView.viewStart));
      viewEnd = Math.max(0, Math.min(1, savedView.viewEnd));
      if (viewEnd <= viewStart) { viewStart = 0; viewEnd = 1; }
    }
    if (canvas && canvas.getContext) {
      const ctx = canvas.getContext('2d');
      function sizeCanvas() {
        const dpr = Math.max(1, window.devicePixelRatio || 1);
        const cssW = canvas.clientWidth || 300;
        const cssH = canvas.clientHeight || 200;
        canvas.width = Math.floor(cssW * dpr);
        canvas.height = Math.floor(cssH * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      function draw() {
        if (document.hidden) return; // never render when tab is hidden
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        ctx.clearRect(0, 0, w, h);
        const histAll = window.__momo_history || [];
        const n = histAll.length;
        if (n < 2) return;
        const i0 = Math.floor(n * Math.max(0, Math.min(1, viewStart)));
        const i1 = Math.floor(n * Math.max(0, Math.min(1, viewEnd)));
        const hist = histAll.slice(Math.max(0, Math.min(i0, i1)), Math.max(1, Math.max(i0, i1)));
        const temps = hist.map((x) => x.temperature).filter(Number.isFinite);
        const hums = hist.map((x) => x.humidity).filter(Number.isFinite);
        if (!temps.length || !hums.length) return;
        // Determine scale bounds
        let tmin = Math.min(...temps), tmax = Math.max(...temps);
        let hmin = Math.min(...hums), hmax = Math.max(...hums);
        if (!autoscale) {
          if (manualScale.tMin !== null) tmin = manualScale.tMin;
          if (manualScale.tMax !== null) tmax = manualScale.tMax;
          if (manualScale.hMin !== null) hmin = manualScale.hMin;
          if (manualScale.hMax !== null) hmax = manualScale.hMax;
          // Ensure non-zero span
          if (tmin === tmax) { tmin -= 0.5; tmax += 0.5; }
          if (hmin === hmax) { hmin -= 0.5; hmax += 0.5; }
        } else {
          // Autoscale: ensure non-zero span and add small top/bottom padding to avoid clipping
          if (tmin === tmax) { tmin -= 0.5; tmax += 0.5; }
          if (hmin === hmax) { hmin -= 0.5; hmax += 0.5; }
          const tPad = Math.max((tmax - tmin) * 0.05, 0.2);
          const hPad = Math.max((hmax - hmin) * 0.05, 1);
          tmin -= tPad; tmax += tPad;
          hmin -= hPad; hmax += hPad;
          // Clamp humidity to practical range
          hmin = Math.max(0, hmin); hmax = Math.min(100, hmax);
          if (hmin >= hmax) { hmin = Math.max(0, hmin - 1); hmax = Math.min(100, hmax + 1); }
        }
  // Enhanced chart layout variables
  const padL = 48; const padR = 56; const padT = 12; const padB = 32; // increased for clearer axes & labels
  const plotW = w - padL - padR; const plotH = h - padT - padB;
  const xAt = (i, n2) => padL + (i * plotW) / Math.max(1, n2 - 1);
  const yAt = (v, vmin, vmax) => padT + plotH - ((v - vmin) / Math.max(0.01, vmax - vmin)) * plotH;
  // Background & border
  ctx.fillStyle = 'rgba(255,255,255,.02)';
  ctx.fillRect(padL, padT, plotW, plotH);
  ctx.strokeStyle = 'rgba(255,255,255,.08)';
  ctx.strokeRect(padL + .5, padT + .5, plotW - 1, plotH - 1);
  // Stronger left & bottom axes lines
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,.35)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(padL + 0.5, padT); // Y axis
  ctx.lineTo(padL + 0.5, padT + plotH);
  ctx.moveTo(padL, padT + plotH + 0.5); // X axis
  ctx.lineTo(padL + plotW, padT + plotH + 0.5);
  ctx.stroke();
  ctx.restore();
  // Tick helpers (nice numbers)
  function niceStep(span, target){
    const raw = span / Math.max(1,target);
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const rem = raw / pow;
    let step;
    if (rem < 1.5) step = 1; else if (rem < 3.5) step = 2; else if (rem < 7.5) step = 5; else step = 10;
    return step * pow;
  }
  ctx.font = '11px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial';
  ctx.textAlign='right'; ctx.textBaseline='middle';
  const tSpan = Math.max(0.01, tmax - tmin);
  const hSpan = Math.max(0.01, hmax - hmin);
  const tStep = niceStep(tSpan, 5);
  const hStep = niceStep(hSpan, 5);
  // Horizontal grid lines aligned to temperature ticks
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,.07)';
  for (let v = Math.ceil(tmin / tStep) * tStep; v <= tmax + 0.001; v += tStep){
    const y = yAt(v, tmin, tmax) + 0.5;
    ctx.beginPath(); ctx.moveTo(padL + 0.5, y); ctx.lineTo(padL + plotW - 0.5, y); ctx.stroke();
  }
  ctx.restore();
  // Temperature ticks (left)
  ctx.fillStyle = 'rgba(255,255,255,.7)';
  ctx.strokeStyle = 'rgba(255,255,255,.25)';
  for (let v = Math.ceil(tmin / tStep) * tStep; v <= tmax + 0.001; v += tStep){
    const y = yAt(v, tmin, tmax) + 0.5;
    ctx.beginPath(); ctx.moveTo(padL - 4, y); ctx.lineTo(padL, y); ctx.stroke();
    ctx.fillText(v.toFixed(1), padL - 6, y);
  }
  // Humidity ticks (right)
  ctx.textAlign='left';
  const rightX = padL + plotW + 6;
  ctx.fillStyle = 'rgba(200,200,200,.65)';
  for (let v = Math.ceil(hmin / hStep) * hStep; v <= hmax + 0.001; v += hStep){
    const y = yAt(v, hmin, hmax) + 0.5;
    ctx.beginPath(); ctx.moveTo(padL + plotW, y); ctx.lineTo(padL + plotW + 4, y); ctx.stroke();
    ctx.fillText(v.toFixed(0)+'%', rightX, y);
  }
  // Bottom time ticks + vertical grid lines
  ctx.textAlign='center'; ctx.textBaseline='top';
  const tStart = hist[0].timestamp || Date.now();
  const tEnd = hist[hist.length-1].timestamp || tStart;
  const spanMs = Math.max(1, tEnd - tStart);
  const desiredXTicks = Math.min(6, Math.max(3, Math.floor(plotW / 120)));
  const stepMs = spanMs / desiredXTicks;
  for (let i=0;i<=desiredXTicks;i++){
    const tt = tStart + i*stepMs;
    const frac = (tt - tStart)/spanMs;
    const x = padL + frac * plotW;
    // vertical grid line
    ctx.strokeStyle='rgba(255,255,255,.07)';
    ctx.beginPath(); ctx.moveTo(x+0.5, padT); ctx.lineTo(x+0.5, padT+plotH); ctx.stroke();
    ctx.strokeStyle='rgba(255,255,255,.15)';
    ctx.beginPath(); ctx.moveTo(x+0.5, padT+plotH); ctx.lineTo(x+0.5, padT+plotH+6); ctx.stroke();
    const d = new Date(tt);
    const label = d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'});
    ctx.fillStyle='rgba(255,255,255,.65)';
    ctx.fillText(label, x, padT+plotH+8);
  }
        function drawLine(vals, vmin, vmax, color) {
          const n = vals.length; if (n < 2) return;
          // Slight smoothing using Catmull-Rom -> Bezier, preserves point positions, clamp control points to bounds
          const pts = new Array(n).fill(0).map((_,i)=>({ x: xAt(i,n), y: yAt(vals[i], vmin, vmax) }));
          const s = 0.18; // smoothing intensity (0 = straight lines, ~0.2 = subtle)
          ctx.strokeStyle = color; ctx.lineWidth = 1.4; ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          const topY = yAt(vmax, vmin, vmax);
          const bottomY = yAt(vmin, vmin, vmax);
          const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
          for (let i=0;i<n-1;i++) {
            const p0 = i>0 ? pts[i-1] : pts[i];
            const p1 = pts[i];
            const p2 = pts[i+1];
            const p3 = i+2 < n ? pts[i+2] : pts[i+1];
            const cp1x = p1.x + (p2.x - p0.x) * (s/6);
            let cp1y = p1.y + (p2.y - p0.y) * (s/6);
            const cp2x = p2.x - (p3.x - p1.x) * (s/6);
            let cp2y = p2.y - (p3.y - p1.y) * (s/6);
            // Clamp control point Y to plot bounds to prevent overshoot outside vmin/vmax
            cp1y = clamp(cp1y, topY, bottomY);
            cp2y = clamp(cp2y, topY, bottomY);
            ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
          }
          ctx.stroke();
        }
  const colT = chartColors.temp || '#60a5fa';
  const colH = chartColors.hum  || '#9ca3af';
  drawLine(temps, tmin, tmax, colT);
  drawLine(hums, hmin, hmax, colH);
        // Legend last values
        const lastT = temps[temps.length - 1];
        const lastH = hums[hums.length - 1];
        ctx.font = '12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial';
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        const legendX = padL + 6; const legendY = padT + 14;
        ctx.fillStyle = colT; ctx.fillText(`Temp ${lastT.toFixed(1)}°`, legendX, legendY);
        ctx.fillStyle = colH; ctx.fillText(`Hum ${lastH.toFixed(1)}%`, legendX + 110, legendY);
        // Hover crosshair & tooltip
        if (typeof hoverX === 'number') {
          const frac = Math.max(0, Math.min(1, (hoverX - padL) / Math.max(1, plotW)));
            const idx = Math.min(temps.length - 1, Math.max(0, Math.round(frac * (temps.length - 1))));
            const tVal = temps[idx]; const hVal = hums[idx];
            const x = xAt(idx, temps.length);
            const tY = yAt(tVal, tmin, tmax); const hY = yAt(hVal, hmin, hmax);
            ctx.save(); ctx.setLineDash([4,4]); ctx.strokeStyle = 'rgba(255,255,255,.25)';
            ctx.beginPath(); ctx.moveTo(x + .5, padT); ctx.lineTo(x + .5, padT + plotH); ctx.stroke(); ctx.setLineDash([]);
            ctx.fillStyle = colT; ctx.beginPath(); ctx.arc(x, tY, 3, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = colH; ctx.beginPath(); ctx.arc(x, hY, 3, 0, Math.PI * 2); ctx.fill();
            // Build tooltip lines first, then compute dynamic sizing
            ctx.font = '11px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            const point = hist[idx];
            let rawTs = point.timestamp ?? point.ts ?? point.time;
            let tsDate = null;
            if (typeof rawTs === 'number') tsDate = new Date(rawTs > 2e10 ? rawTs : rawTs * 1000); else if (rawTs) tsDate = new Date(rawTs);
            const tsLabel = tsDate ? tsDate.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'}) : '';
            const lineTemp = `Temp: ${tVal.toFixed(2)}°`;
            const lineHum  = `Hum:  ${hVal.toFixed(2)}%`;
            let lineDelta = '';
            if (idx > 0) {
              const prevPoint = hist[idx-1];
              const prevT = prevPoint.temperature; const prevH = prevPoint.humidity;
              if (Number.isFinite(prevT) && Number.isFinite(prevH)) {
                const dT = tVal - prevT; const dH = hVal - prevH;
                lineDelta = `Δ ${dT>=0?'+':''}${dT.toFixed(2)}° / ${dH>=0?'+':''}${dH.toFixed(2)}%`;
              }
            }
            const lines = [tsLabel, lineTemp, lineHum].concat(lineDelta ? [lineDelta] : []);
            const padX = 10, padY = 10, lineH = 15; // more top padding to avoid clipping
            const textW = Math.max(...lines.map(l => ctx.measureText(l).width));
            const boxW = Math.ceil(textW + padX*2);
            const boxH = padY*2 + lineH * lines.length;
            let boxX = x + 12, boxY = padT + 8;
            if (boxX + boxW > w - padR) boxX = x - boxW - 12;
            if (boxX < padL) boxX = padL;
            if (boxY + boxH > padT + plotH) boxY = padT + plotH - boxH - 4;
            // Draw container
            ctx.fillStyle = '#0b0d10'; ctx.strokeStyle = 'rgba(255,255,255,.15)';
            ctx.beginPath(); ctx.rect(boxX + .5, boxY + .5, boxW - 1, boxH - 1); ctx.fill(); ctx.stroke();
            // Render lines with coloring
            lines.forEach((ln, i) => {
              let color = 'rgba(255,255,255,.7)';
              if (ln === lineTemp) color = colT;
              else if (ln === lineHum) color = colH;
              else if (ln === lineDelta) color = 'rgba(255,255,255,.55)';
              ctx.fillStyle = color;
              // Top-baseline text so it sits fully inside the box
              ctx.fillText(ln, boxX + padX, boxY + padY + i*lineH);
            });
            ctx.restore();
        }
      }
      // Coalesced redraw scheduler to avoid burst rendering
      const MIN_DRAW_INTERVAL = 300; // ms, max ~3.3 fps for data-driven updates
      let lastDrawTs = 0;
      let drawPending = false;
      function scheduleDraw(force = false) {
        if (document.hidden) { drawPending = true; return; }
        const now = Date.now();
        if (force || (now - lastDrawTs) >= MIN_DRAW_INTERVAL) {
          lastDrawTs = now; drawPending = false;
          requestAnimationFrame(draw);
        } else if (!drawPending) {
          drawPending = true;
          const delay = Math.max(16, MIN_DRAW_INTERVAL - (now - lastDrawTs));
          setTimeout(() => {
            drawPending = false;
            if (!document.hidden) { lastDrawTs = Date.now(); requestAnimationFrame(draw); }
          }, delay);
        }
      }
      ro = new ResizeObserver(() => {
        sizeCanvas();
        scheduleDraw(true);
      });
      ro.observe(canvas);
      sizeCanvas();
      drawHandler = () => scheduleDraw();
      window.addEventListener('momo-data', () => { if (!paused) scheduleDraw(); });
      // Periodic refresh in case no data events arrive (very light due to scheduler)
      intervalId = setInterval(() => scheduleDraw(), 2000);
      // On visibility change, perform a single immediate draw when becoming visible
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) scheduleDraw(true);
      });

      // Interactions: hover tooltip crosshair and wheel zoom
      let hoverX = null;
      canvas.addEventListener('mousemove', (e) => {
        const rect = canvas.getBoundingClientRect();
        hoverX = e.clientX - rect.left;
        draw();
        if (hoverX != null) {
          const w = canvas.clientWidth; const h = canvas.clientHeight; const pad = 8;
          const ctx2 = ctx;
          ctx2.save();
          ctx2.strokeStyle = 'rgba(255,255,255,.12)';
          ctx2.beginPath(); ctx2.moveTo(hoverX, pad); ctx2.lineTo(hoverX, h - pad); ctx2.stroke();
          ctx2.restore();
        }
      });
      canvas.addEventListener('mouseleave', () => { hoverX = null; draw(); });
      canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const delta = Math.sign(e.deltaY) * 0.05; // zoom step
        const center = (hoverX ?? canvas.clientWidth / 2) / canvas.clientWidth;
        let span = Math.max(0.1, Math.min(1, (viewEnd - viewStart) * (1 + delta)));
        let start = Math.max(0, Math.min(1 - span, center - span / 2));
        viewStart = start; viewEnd = start + span; saveView({ viewStart, viewEnd }); draw();
      }, { passive: false });
      canvas.addEventListener('dblclick', () => { viewStart = 0; viewEnd = 1; saveView({ viewStart, viewEnd }); draw(); });

      // drag-to-pan with mouse
      let dragging = false; let dragStartX = 0; let dragStartView = null;
      canvas.addEventListener('mousedown', (e)=>{ dragging = true; dragStartX = e.clientX; dragStartView = { viewStart, viewEnd }; });
      window.addEventListener('mouseup', ()=>{ if (dragging){ dragging = false; saveView({ viewStart, viewEnd }); } });
      window.addEventListener('mousemove', (e)=>{
        if (!dragging) return;
        const dx = e.clientX - dragStartX;
        const frac = dx / Math.max(1, canvas.clientWidth);
        const span = dragStartView.viewEnd - dragStartView.viewStart;
        let start = dragStartView.viewStart - frac * span;
        start = Math.max(0, Math.min(1 - span, start));
        viewStart = start; viewEnd = start + span; draw();
      });
    }

    // Clear chart button
    const clearBtn = document.getElementById('clearChart');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        try {
          dataHistory.splice(0, dataHistory.length); // empty existing array in-place
          window.__momo_history = dataHistory;
          persistHistory(true);
          // Force immediate redraw of chart & sparks
          try { window.dispatchEvent(new Event('momo-data')); } catch(e){}
        } catch(e) {
          console.warn('Failed to clear chart history', e);
        }
      });
    }

    // Draw micro sparklines
    function drawSpark(id, values, colorVarOrHex) {
      const c = document.getElementById(id);
      if (!c || !c.getContext) return;
      const ctx = c.getContext('2d');
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const cssW = c.clientWidth || 200; const cssH = c.clientHeight || 28;
      c.width = Math.floor(cssW * dpr); c.height = Math.floor(cssH * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);
      if (!values || values.length < 2) return;
      const vmin = Math.min(...values.filter(Number.isFinite));
      const vmax = Math.max(...values.filter(Number.isFinite));
      const pad = 2;
      const xAt = (i, n) => pad + (i * (cssW - 2 * pad)) / Math.max(1, n - 1);
      const yAt = (v) => cssH - pad - ((v - vmin) / Math.max(0.01, vmax - vmin)) * (cssH - 2 * pad);
      const styles = getComputedStyle(document.documentElement);
      const color = (typeof colorVarOrHex === 'string' && colorVarOrHex.trim().startsWith('--'))
        ? (styles.getPropertyValue(colorVarOrHex) || '#60a5fa')
        : (colorVarOrHex || '#60a5fa');
      ctx.strokeStyle = color; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(xAt(0, values.length), yAt(values[0]));
      // Apply smoothing for sparklines: quadratic midpoint smoothing
      ctx.beginPath();
      let x0 = xAt(0, values.length), y0 = yAt(values[0]);
      ctx.moveTo(x0,y0);
      for (let i=1;i<values.length;i++) {
        const x1 = xAt(i, values.length), y1 = yAt(values[i]);
        const xc = (x0 + x1)/2, yc = (y0 + y1)/2;
        ctx.quadraticCurveTo(x0, y0, xc, yc);
        x0 = x1; y0 = y1;
      }
      ctx.lineTo(x0,y0); ctx.stroke();
    }
    function redrawSparks() {
      const hist = (window.__momo_history || []).filter(p => p && typeof p.timestamp === 'number');
      if (!hist.length) {
        drawSpark('sparkTemp', [], chartColors.temp || '--primary-500');
        drawSpark('sparkHum', [], chartColors.hum || '--neutral-500');
        drawSpark('sparkComfort', [], '--accent-500');
        const r = '--';
        const elT = document.getElementById('sparkTempRange'); if (elT) elT.textContent = r;
        const elH = document.getElementById('sparkHumRange'); if (elH) elH.textContent = r;
        const elC = document.getElementById('sparkComfortRange'); if (elC) elC.textContent = r;
        return;
      }
      const now = Date.now();
      const windowMs = (SPARK_WINDOW_MIN || 30) * 60 * 1000;
      const startTs = now - windowMs;
      // Keep only points within the shared window (inclusive)
      const slice = hist.filter(p => p.timestamp >= startTs && p.timestamp <= now);
      const points = slice.length ? slice : hist.slice(-Math.min(hist.length, 120));
      const temps = points.map(h => h.temperature).filter(Number.isFinite);
      const hums = points.map(h => h.humidity).filter(Number.isFinite);
      const comforts = points.map(h => h.__comfort).filter(Number.isFinite);
      drawSpark('sparkTemp', temps, chartColors.temp || '--primary-500');
      drawSpark('sparkHum', hums, chartColors.hum || '--neutral-500');
      drawSpark('sparkComfort', comforts, '--accent-500');
      // Timeline labels (use same start/end across all three)
      const firstTs = points.length ? points[0].timestamp : startTs;
      const lastTs  = points.length ? points[points.length - 1].timestamp : now;
      const fmtHM = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const label = `${fmtHM(firstTs)}–${fmtHM(lastTs)}`;
      const elT = document.getElementById('sparkTempRange'); if (elT) elT.textContent = label;
      const elH = document.getElementById('sparkHumRange'); if (elH) elH.textContent = label;
      const elC = document.getElementById('sparkComfortRange'); if (elC) elC.textContent = label;
    }
    window.addEventListener('momo-data', redrawSparks);
    setTimeout(redrawSparks, 0);

    // Mini camera bindings
    const mini = document.getElementById('snapshotMini');
    const refreshMini = () => mini && (mini.src = '/api/camera/snapshot?ts=' + Date.now());
    document.getElementById('refreshMini')?.addEventListener('click', refreshMini);
    let miniAuto = false;
    const miniAutoBtn = document.getElementById('miniAuto');
    function reflectMiniAuto() {
      miniAutoBtn?.classList.toggle('on', !!miniAuto);
    }
    function miniStep() {
      if (!miniAuto || !mini) return;
      mini.src = '/api/camera/snapshot?ts=' + Date.now();
    }
    if (mini) mini.onload = () => { if (miniAuto) setTimeout(miniStep, 0); };
    function toggleMiniAuto() {
      miniAuto = !miniAuto;
      reflectMiniAuto();
      if (miniAuto) miniStep();
    }
    mini?.addEventListener('dblclick', toggleMiniAuto);
    miniAutoBtn?.addEventListener('click', toggleMiniAuto);
    reflectMiniAuto();

    // Cleanup
    return () => {
      try { ro && ro.disconnect(); } catch (e) {}
      try { drawHandler && window.removeEventListener('momo-data', drawHandler); } catch (e) {}
      try { intervalId && clearInterval(intervalId); } catch (e) {}
      try { if (mini) mini.onload = null; } catch (e) {}
    };
  }

  function initCameraBindings() {
    const img = document.getElementById('snapshot');
    const wrap = document.getElementById('camWrap');
    const refresh = () => {
      if (!img) return;
      // When live, restarting reassigns stream URL to force reconnect
      if (img.src && img.src.includes('/api/camera/stream')) {
        img.src = '';
        setTimeout(() => img && (img.src = '/api/camera/stream'), 30);
      } else {
        img.src = '/api/camera/snapshot?ts=' + Date.now();
      }
    };
    const autoBtn = document.getElementById('autoToggle');
    document.getElementById('refreshShot')?.addEventListener('click', refresh);
    document.getElementById('fullRes')?.addEventListener('click', () => {
      try { window.open('/api/camera/snapshot_full?q=12', '_blank'); } catch (e) {}
    });
    // Aspect ratio controls
    const ar43 = document.getElementById('camAR43');
    const ar169 = document.getElementById('camAR169');
    const ar1 = document.getElementById('camAR1');
    function setAspect(cls){
      if (!wrap) return;
      wrap.classList.remove('w43','w169','square');
      if (cls) wrap.classList.add(cls);
      [ar43, ar169, ar1].forEach(b => b?.classList.remove('on'));
      if (cls==='w43') ar43?.classList.add('on');
      if (cls==='w169') ar169?.classList.add('on');
      if (cls==='square') ar1?.classList.add('on');
    }
    ar43?.addEventListener('click', ()=> setAspect('w43'));
    ar169?.addEventListener('click', ()=> setAspect('w169'));
    ar1?.addEventListener('click', ()=> setAspect('square'));
    let live = true; // default to live on open
    function setLive(on) {
      live = !!on;
      autoBtn?.classList.toggle('on', live);
      if (!img) return;
      if (live) {
        img.src = '/api/camera/stream';
      } else {
        img.src = '/api/camera/snapshot?ts=' + Date.now();
      }
    }
    // Live data: WebSocket + poll fallback
    function connectWS() {
      try {
        const socket = new WebSocket(`ws://${location.host}/ws`);
        const badge = document.getElementById('connBadge');
        socket.onopen = () => { setStatus('Live data connected'); if (badge){ badge.textContent='Live'; badge.classList.remove('muted'); } };
        socket.onclose = () => { setStatus('Live data disconnected'); if (badge){ badge.textContent='Idle'; badge.classList.add('muted'); } };
        socket.onmessage = (e) => { try { render(JSON.parse(e.data)); } catch (err) {} };
      } catch (err) {}
    }
    connectWS();
    setStatus('Initializing...');
    setLive(true);
  setAspect('w43');

  // Streaming stats (server-reported)
  let frameCount = 0;
  let bytesCount = 0;
  let winStart = Date.now();
  let lastSize = 0;
    let fpsEl = document.getElementById('camFps');
    let brEl = document.getElementById('camBitrate');
    let resEl = document.getElementById('camRes');
    let framesEl = document.getElementById('camFrames');
    let upEl = document.getElementById('camUptime');
    let sizeEl = document.getElementById('camSize');
    let qEl = document.getElementById('camQ');
    let fsEl = document.getElementById('camFS');

    function fmtBytes(bps) {
      const units = ['bps','Kbps','Mbps'];
      let u = 0; let v = bps;
      while (v >= 1000 && u < units.length - 1) { v /= 1000; u++; }
      return v.toFixed(1) + ' ' + units[u];
    }
    async function updateStats() {
      try {
        const r = await fetch('/api/camera/stream_stats');
        const d = await r.json();
        const now = d.now || Date.now();
        const dt = Math.max(0.1, ((now - (d.since || now)) / 1000));
        const fps = (d.frames || 0) / dt;
        const bitrate = ((d.bytes || 0) * 8) / dt;
        frameCount = d.frames || 0;
        bytesCount = d.bytes || 0;
        winStart = d.since || Date.now();
        if (fpsEl) fpsEl.textContent = fps.toFixed(1);
        if (brEl) brEl.textContent = fmtBytes(bitrate);
        if (framesEl) framesEl.textContent = String(frameCount);
        if (upEl) upEl.textContent = (dt.toFixed(1) + ' s');
        if (sizeEl) sizeEl.textContent = lastSize ? (Math.round(lastSize/1024) + ' KB') : '--';
      } catch {}
      // quality/frame size from settings
      try {
        const r2 = await fetch('/api/settings/get', { cache: 'no-store' });
        const d2 = await r2.json();
        if (qEl && d2?.camera?.quality != null) qEl.textContent = d2.camera.quality;
        if (fsEl && d2?.camera?.frameSize != null) fsEl.textContent = String(d2.camera.frameSize);
      } catch {}
    }
    // hook into image load to estimate size and resolution
    if (img) {
      const origOnload = img.onload;
      img.onload = (ev) => {
        try {
          // Cannot get transfer size reliably; retain last resolution
          // Some browsers set performance.getEntriesByName for image; fallback to headers via fetch not available here.
          // We approximate using naturalWidth/Height and last network transfer size isn’t available, so set lastSize to 0.
          if (resEl) resEl.textContent = img.naturalWidth && img.naturalHeight ? (img.naturalWidth + '×' + img.naturalHeight) : '--';
          // We can estimate per-frame size by quickly reloading a snapshot HEAD, but that’s extra traffic; skip.
          lastSize = 0;
          // Stats tick
          // will be updated by periodic timer
        } catch {}
        if (typeof origOnload === 'function') try { origOnload.call(img, ev); } catch {}
      };
    }
    // Periodic stats updater
    const statsTimer = setInterval(updateStats, 1000);

    // Tuning helpers
    async function camCtrl(payload) {
      try { await fetch('/api/camera/ctrl', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); } catch (e) {}
    }
    document.getElementById('camPresetAuto')?.addEventListener('click', () => camCtrl({ whitebal:true, awb_gain:true, wb_mode:0, lenc:1, bpc:1, wpc:1, dcw:1, brightness:1, saturation:1, aec2:true, gainceiling:64 }));
    document.getElementById('camPresetDay')?.addEventListener('click', () => camCtrl({ whitebal:true, awb_gain:true, wb_mode:2, lenc:1, brightness:0, saturation:1 }));
    document.getElementById('camPresetOffice')?.addEventListener('click', () => camCtrl({ whitebal:true, awb_gain:true, wb_mode:3, lenc:1, brightness:0, saturation:1 }));
    document.getElementById('camPresetLow')?.addEventListener('click', () => camCtrl({ aec2:true, gainceiling:128, brightness:2, saturation:0 }));
    let mirrorOn=false, flipOn=false;
    document.getElementById('camMirror')?.addEventListener('click', () => { mirrorOn=!mirrorOn; camCtrl({ hmirror: mirrorOn }); });
    document.getElementById('camFlip')?.addEventListener('click', () => { flipOn=!flipOn; camCtrl({ vflip: flipOn }); });

    // Cleanup: stop stream when leaving
    return () => {
      try { if (img) img.src = ''; } catch (e) {}
      try { clearInterval(statsTimer); } catch (e) {}
    };
  }

  function initNetworkBindings() {
    let pollId;
    async function fillInfo() {
      try {
        const r = await fetch('/api/wifi/info');
        const d = await r.json();
        const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v ?? '--'; };
        set('nw-mode', d.mode);
        set('wifiState', d.state);
        set('hostn', d.hostname);
        set('nw-mdns', d.mdns ? 'On' : 'Off');
        // Badges (Connection)
        const bMode = document.getElementById('nw-badge-mode');
        if (bMode) { bMode.textContent = (d.mode || '--').toUpperCase(); bMode.classList.remove('ok','warn','bad'); if (d.mode==='sta') bMode.classList.add('ok'); else if (d.mode==='ap+sta') bMode.classList.add('warn'); else if (d.mode==='ap'||d.mode==='off') bMode.classList.add('bad'); }
        const bState = document.getElementById('nw-badge-state');
        if (bState) { const st = d.state || '--'; bState.textContent = st.toUpperCase(); bState.classList.remove('ok','warn','bad'); if (st==='connected') bState.classList.add('ok'); else if (st==='connecting'||st==='ap') bState.classList.add('warn'); else bState.classList.add('bad'); }
        set('ip', d.sta?.ip || '--');
        set('gw', d.sta?.gateway || '--');
        set('subnet', d.sta?.subnet || '--');
        set('dns', d.sta?.dns || '--');
        set('ssid', d.sta?.ssid || '--');
        set('bssid', d.sta?.bssid || '--');
        set('chan', d.sta?.channel || '--');
        set('rssi', (d.sta?.rssi != null) ? (d.sta.rssi + ' dBm') : '--');
        set('sta-mac', d.sta?.mac || '--');
        set('ap-ssid', d.ap?.ssid || '--');
        set('ap-ip', d.ap?.ip || '--');
        set('ap-clients', d.ap?.clients != null ? String(d.ap.clients) : '--');
        set('ap-mac', d.ap?.mac || '--');
        set('ap-cap', d.ap?.captive ? 'On' : 'Off');
        const apBadge = document.getElementById('ap-badge');
        if (apBadge) { const apOn = !!d.ap?.enabled; apBadge.textContent = apOn ? 'AP On' : 'AP Off'; apBadge.classList.remove('ok','warn','bad'); apBadge.classList.add(apOn ? 'ok':'bad'); }
  set('txp', d.radio?.tx_power_dbm != null ? String(d.radio.tx_power_dbm) + ' dBm' : '--');
        set('sleep', d.radio?.sleep ? 'On' : 'Off');
        const hostIn = document.getElementById('host-set'); if (hostIn && !hostIn.value) hostIn.value = d.hostname || '';
      } catch (e) {}
    }
    fillInfo();
    pollId = setInterval(fillInfo, 5000);

    const scanBtn = document.getElementById('scan');
    let scanPoll;
    scanBtn?.addEventListener('click', async () => {
      const el = document.getElementById('scanResults'); if (!el) return;
      // UI: loading state
      scanBtn.disabled = true; scanBtn.classList.add('loading');
      el.innerHTML = `<div class="loading-row"><span class="spinner"></span> Scanning for networks…</div>`;
      try { await fetch('/api/wifi/scan/start'); } catch (e) {}
      // Poll every 900ms until status === 'done' | 'failed'
      const pollOnce = async () => {
        try {
          const r = await fetch('/api/wifi/scan/results');
          const d = await r.json();
          if (d.status === 'scanning') { return; }
          if (d.status === 'failed') { el.innerHTML = '<div class="loading-row">Scan failed. Try again.</div>'; cleanupScan(); return; }
          if (Array.isArray(d.networks)) {
            const list = d.networks
              .filter((n) => n.ssid && n.ssid.trim().length > 0)
              .sort((a, b) => b.rssi - a.rssi);
            if (!list.length) { el.innerHTML = '<div class="loading-row">No networks found.</div>'; cleanupScan(); return; }
            el.innerHTML = list.map((n) => {
              const secure = n.security && n.security !== 'open';
              const icon = secure ? '🔒' : '🔓';
              return `<div class="row">
                <div>${icon} ${n.ssid}</div>
                <div class="muted">${n.rssi} dBm ${secure ? 'secured' : 'open'} ch ${n.channel ?? ''}</div>
                <button data-ssid="${encodeURIComponent(n.ssid)}" data-secure="${secure}" class="btn sm">Connect</button>
              </div>`;
            }).join('');
            el.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
              const ssid = decodeURIComponent(b.dataset.ssid);
              const secure = b.dataset.secure === 'true';
              if (secure) openPw(ssid); else connectTo(ssid, '');
            }));
            cleanupScan();
          }
        } catch (e) { el.innerHTML = '<div class="loading-row">Scan error.</div>'; cleanupScan(); }
      };
      const cleanupScan = () => { clearInterval(scanPoll); scanPoll = undefined; scanBtn.disabled = false; scanBtn.classList.remove('loading'); };
      try { clearInterval(scanPoll); } catch {}
      scanPoll = setInterval(pollOnce, 900);
      // Also kick immediate first check after a short delay for async start
      setTimeout(pollOnce, 900);
    });
    async function connectTo(ssid, password = '') {
      try {
        await fetch('/api/wifi/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ssid, password }),
        });
      } catch {}
      alert('Connecting... check Network status.');
    }
    function openPw(ssid) {
      const m = document.getElementById('pwModal');
      const s = document.getElementById('pwSsid');
      const p = document.getElementById('pwPass');
      if (!m || !s || !p) return;
      s.value = ssid;
      p.value = '';
      m.style.display = 'flex';
      setTimeout(() => p.focus(), 0);
    }
    function closePw() {
      const m = document.getElementById('pwModal');
      if (m) m.style.display = 'none';
    }
    document.getElementById('pwForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const ssid = document.getElementById('pwSsid').value.trim();
      const pass = document.getElementById('pwPass').value;
      closePw();
      connectTo(ssid, pass);
    });
    document.getElementById('pwCancel')?.addEventListener('click', () => closePw());

    document.getElementById('forget')?.addEventListener('click', async () => {
      if (confirm('Forget WiFi credentials and reboot into AP mode?')) {
        try { await fetch('/api/wifi/forget', { method: 'POST' }); } catch (e) {}
      }
    });

    // Controls
    document.getElementById('reconnect')?.addEventListener('click', async () => { try { await fetch('/api/wifi/reconnect', { method: 'POST' }); } catch (e) {} setTimeout(fillInfo, 1000); });
    document.getElementById('disconnect')?.addEventListener('click', async () => { try { await fetch('/api/wifi/disconnect', { method: 'POST' }); } catch (e) {} setTimeout(fillInfo, 500); });
    document.getElementById('ap-toggle')?.addEventListener('click', async () => {
      try {
        // Decide next state based on current info
        const r = await fetch('/api/wifi/info'); const d = await r.json();
        const next = !(d.ap?.enabled);
        await fetch('/api/wifi/toggle_ap', { method: 'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ enable: next }) });
      } catch (e) {}
      setTimeout(fillInfo, 800);
    });
    // Recovery helpers
    document.getElementById('ap-setup')?.addEventListener('click', async () => { try { await fetch('/api/wifi/toggle_ap', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ enable:true }) }); } catch(e){} setTimeout(fillInfo, 800); });
    document.getElementById('ap-stop')?.addEventListener('click', async () => { try { await fetch('/api/wifi/toggle_ap', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ enable:false }) }); } catch(e){} setTimeout(fillInfo, 800); });
    document.getElementById('apply-txp')?.addEventListener('click', async () => {
      const v = parseInt(document.getElementById('txp-set')?.value || '20', 10);
      try { await fetch('/api/wifi/txpower/set', { method: 'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ value: v }) }); } catch (e) {}
      setTimeout(fillInfo, 500);
    });
    document.getElementById('sleep-on')?.addEventListener('click', async () => { try { await fetch('/api/wifi/sleep/set', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ enable:true }) }); } catch (e) {} setTimeout(fillInfo, 400); });
    document.getElementById('sleep-off')?.addEventListener('click', async () => { try { await fetch('/api/wifi/sleep/set', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ enable:false }) }); } catch (e) {} setTimeout(fillInfo, 400); });
    document.getElementById('apply-host')?.addEventListener('click', async () => {
      const v = (document.getElementById('host-set')?.value || '').trim();
      if (!v) return;
      try { await fetch('/api/wifi/hostname/set', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ hostname: v }) }); } catch (e) {}
      setTimeout(fillInfo, 600);
    });
    document.getElementById('mdns-restart')?.addEventListener('click', async () => { try { await fetch('/api/wifi/mdns/restart', { method:'POST' }); } catch (e) {} setTimeout(fillInfo, 600); });

    return () => { try { pollId && clearInterval(pollId); } catch (e) {} };
  }

  function initSettingsBindings() {
    async function loadSettings() {
      try {
        const r = await fetch('/api/settings/get');
        const d = await r.json();
        const f = document.getElementById('settingsForm');
        if (!f) return;
        f.hostname.value = d.hostname || '';
        f.units.value = d.units || 'C';
        f.tmin.value = d.thresholds?.tempMin ?? '';
        f.tideal.value = d.thresholds?.tempIdeal ?? '';
        f.tmax.value = d.thresholds?.tempMax ?? '';
        f.hmin.value = d.thresholds?.humMin ?? '';
        f.hideal.value = d.thresholds?.humIdeal ?? '';
        f.hmax.value = d.thresholds?.humMax ?? '';
  if (f.cmin) f.cmin.value = d.thresholds?.comfortMin ?? '';
  if (f.cideal) f.cideal.value = d.thresholds?.comfortIdeal ?? '';
  if (f.cmax) f.cmax.value = d.thresholds?.comfortMax ?? '';
        if (d.camera) {
          f.camsize.value = d.camera.frameSize;
          f.camq.value = d.camera.quality;
        }
      } catch (e) {}
    }
    loadSettings();

    document.getElementById('settingsForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const payload = {
        hostname: f.hostname.value.trim(),
        units: f.units.value,
        thresholds: {
          tempMin: parseFloat(f.tmin.value),
          tempIdeal: parseFloat(f.tideal.value),
          tempMax: parseFloat(f.tmax.value),
          humMin: parseFloat(f.hmin.value),
          humIdeal: parseFloat(f.hideal.value),
          humMax: parseFloat(f.hmax.value),
          comfortMin: f.cmin ? parseFloat(f.cmin.value) : undefined,
          comfortIdeal: f.cideal ? parseFloat(f.cideal.value) : undefined,
          comfortMax: f.cmax ? parseFloat(f.cmax.value) : undefined,
        },
        camera: {
          frameSize: parseInt(f.camsize.value, 10),
          quality: parseInt(f.camq.value, 10),
        },
      };
      try {
        await fetch('/api/settings/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        alert('Saved');
      } catch (err) {
        alert('Failed to save');
      }
    });
  }

  function initSystemBindings() {
    // OTA UI controller
    const els = {
      card: document.getElementById('otaCard'),
      status: document.getElementById('ota-status'),
      current: document.getElementById('ota-current'),
      latest: document.getElementById('ota-latest'),
  repo: document.getElementById('ota-repo'),
  pub: document.getElementById('ota-pub'),
      msg: document.getElementById('ota-msg'),
      meter: document.getElementById('otaMeter'),
      progress: document.getElementById('otaProgress'),
      check: document.getElementById('ota-check'),
  update: document.getElementById('ota-update'),
      link: document.getElementById('ota-release-link')
    };
    async function refreshOtaInfo() {
      try {
        els.status.textContent = 'Checking…';
        els.status.classList.remove('ok','bad');
        els.meter?.classList.add('loading');
        els.meter.style.width = '25%';
        const r = await fetch('/api/ota/check');
        const j = await r.json();
        els.current.textContent = j.current || '--';
        els.latest.textContent = j.latest || '--';
        const publishedTxt = j.publishedAt ? ` (released ${new Date(j.publishedAt).toLocaleDateString()})` : '';
        if (els.pub) els.pub.textContent = publishedTxt;
        if (!j.ok) {
          // Neutral state: no releases found or no update information
          els.msg.textContent = 'No update found.';
          els.status.textContent = 'No update';
          els.status.classList.remove('ok','bad');
          els.update.disabled = true;
          if (!j.latest && els.pub) els.pub.textContent = '';
        } else {
          els.msg.textContent = j.hasUpdate ? 'Update available.' : 'You are up to date.';
          els.status.textContent = j.hasUpdate ? 'Update available' : 'Up to date';
          els.status.classList.toggle('ok', !j.hasUpdate);
          els.status.classList.toggle('bad', j.hasUpdate);
          els.update.disabled = !j.hasUpdate;
        }
        // No separate FS button in simplified UX
        // Optional: backend may later include releaseUrl/repo
        if (j.releaseUrl) { els.link.style.display = 'inline-block'; els.link.href = j.releaseUrl; }
        if (j.repo) { els.repo.textContent = j.repo; }
      } catch (e) {
        els.msg.textContent = 'Failed to contact device';
        els.status.textContent = 'Error';
      } finally {
        els.meter?.classList.remove('loading');
        els.meter.style.width = '0%';
      }
    }
    els.check?.addEventListener('click', refreshOtaInfo);
    // Start with a passive info load (non-blocking)
    setTimeout(refreshOtaInfo, 200);

    els.update?.addEventListener('click', async ()=>{
      if (!confirm('Apply update and reboot the device?')) return;
      try {
        els.update.disabled = true; els.check.disabled = true;
        els.status.textContent = 'Updating…';
        els.msg.textContent = 'Downloading and flashing firmware + Web UI. Do not power off.';
        els.meter?.classList.add('loading');
        els.meter.style.width = '10%';
        await fetch('/api/ota/update_all', { method:'POST' });
        // Poll for reboot completion by trying /api/data
        let phase = 'rebooting'; let attempts = 0;
        const spin = setInterval(()=>{
          const p = Math.min(95, 10 + attempts*3); els.meter.style.width = p + '%'; attempts++; }, 1000);
        // Wait for device to go away then come back
        const sleep = (ms)=>new Promise(res=>setTimeout(res,ms));
        // Give it a moment to start reboot
        await sleep(2000);
        // Probe loop: expect failures, then success
        let back = false;
        for (let i=0;i<90;i++) { // up to ~90s
          try {
            const r = await fetch('/api/data', { cache:'no-store' });
            if (r.ok) { back = true; break; }
          } catch(e) {}
          await sleep(1000);
        }
        clearInterval(spin);
        els.meter.classList.remove('loading');
        els.meter.style.width = back ? '100%' : '0%';
        els.status.textContent = back ? 'Updated' : 'Timeout';
        els.msg.textContent = back ? 'Device is back online.' : 'Device did not return in time. Refresh manually.';
        els.check.disabled = false; // allow re-check
        await sleep(800);
        refreshOtaInfo();
      } catch (e) {
        els.status.textContent = 'Failed';
        els.msg.textContent = 'Update could not be started.';
        els.update.disabled = false; els.check.disabled = false;
        els.meter?.classList.remove('loading');
        els.meter.style.width = '0%';
      }
    });

    // Removed separate FS update flow; Apply Update uses combined endpoint

    document.getElementById('reboot')?.addEventListener('click', async () => {
      try { await fetch('/api/system/reboot', { method: 'POST' }); } catch (e) {}
    });
    document.getElementById('sys-mdns')?.addEventListener('click', async () => { try { await fetch('/api/wifi/mdns/restart', { method:'POST' }); } catch (e) {} });
    document.getElementById('sys-reconnect')?.addEventListener('click', async () => { try { await fetch('/api/wifi/reconnect', { method:'POST' }); } catch (e) {} });
    document.getElementById('sys-disconnect')?.addEventListener('click', async () => { try { await fetch('/api/wifi/disconnect', { method:'POST' }); } catch (e) {} });
    document.getElementById('sys-forget')?.addEventListener('click', async () => { if (!confirm('Forget WiFi and reboot into AP?')) return; try { await fetch('/api/wifi/forget', { method:'POST' }); } catch (e) {} });
    document.getElementById('sys-cam-restart')?.addEventListener('click', async () => { try { await fetch('/api/camera/restart', { method:'POST' }); } catch (e) {} });
    document.getElementById('sys-dl-log')?.addEventListener('click', async () => {
      try {
        const r = await fetch('/api/data');
        const d = await r.json();
        const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'diagnostics.json'; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (e) {}
    });
    // legacy alert handlers removed in favor of hero card UX
  }

  // (removed duplicate updateFooterNet definition)

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initApp);
  else initApp();
})();
