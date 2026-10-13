const STORAGE_KEY = 'coin-album-v1';
const DELETED_KEY = 'coin-album-deleted';
const MAP_HINT_DEFAULT = '尚無位置標記：新增紀念幣時在地圖上點一下，即可標記取得地點';

let coins = [];
let db = null;
let currentDetailId = null;
let editingId = null;
let tempPhotos = { front: null, back: null };
let pin = null;
let sideTarget = null;
let mainMap = null;
let miniMap = null;
let miniMarker = null;
let mapLayer = null;
let markers = {};
let needMapRender = false;
let toastTimer = null;
let currentGeocodeResults = [];
let geocodeBusy = false;
let fbAuth = null;
let fbFs = null;
let fbDb = null;
let fbUnsub = null;
let snapUid = null;
let coinsSnap = null;
let deletedSnap = null;
let syncBusy = false;
let syncUser = null;
let tombIds = new Set();

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

function escapeHtml(v){
  return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function uid(){
  return crypto.randomUUID ? crypto.randomUUID() : 'c' + Date.now() + '-' + Math.random().toString(16).slice(2);
}
function initial(coin){
  return (coin.name || '').trim().charAt(0) || '?';
}
function fmtDate(d){
  return d ? String(d).replace(/-/g, '/') : '';
}
function todayStr(){
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function leafletReady(){
  return typeof L !== 'undefined';
}

function openDB(){
  return new Promise(resolve => {
    if (!window.indexedDB){ resolve(null); return; }
    let settled = false;
    const done = v => { if (!settled){ settled = true; resolve(v); } };
    const timer = setTimeout(() => done(null), 5000);
    let req;
    try { req = indexedDB.open('coin-album', 1); } catch { clearTimeout(timer); done(null); return; }
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
    };
    req.onsuccess = e => { clearTimeout(timer); done(e.target.result || null); };
    req.onerror = () => { clearTimeout(timer); done(null); };
    req.onblocked = () => { clearTimeout(timer); done(null); };
  });
}

function idbGet(key){
  return new Promise(resolve => {
    if (!db){ resolve(undefined); return; }
    try {
      const r = db.transaction('kv', 'readonly').objectStore('kv').get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(undefined);
    } catch { resolve(undefined); }
  });
}

function idbSet(key, val){
  return new Promise((resolve, reject) => {
    if (!db){ reject(new Error('nodb')); return; }
    try {
      const r = db.transaction('kv', 'readwrite').objectStore('kv').put(val, key);
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
    } catch (e) { reject(e); }
  });
}

function loadCoinsLegacy(){
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter(c => c && c.id && c.name) : [];
  } catch { return []; }
}

async function initStorage(){
  db = await openDB();
  const stored = await idbGet('coins');
  let list = Array.isArray(stored) ? stored.filter(c => c && c.id && c.name) : [];
  const legacy = loadCoinsLegacy();
  if (legacy.length){
    list = mergeCoins(legacy, list);
    if (db){
      try {
        await idbSet('coins', list);
        try { localStorage.removeItem(STORAGE_KEY); } catch {}
      } catch {
        db = null;
      }
    }
  }
  coins = list;
  updateStorageMode();
}

function updateStorageMode(){
  const el = $('#storage-mode');
  if (el) el.textContent = db ? '本機儲存：IndexedDB ・ ' : '本機儲存：localStorage ・ ';
}

async function saveCoins(){
  if (db){
    try {
      await idbSet('coins', coins);
      return true;
    } catch (err) {
      toast('儲存失敗（' + (err && err.name ? err.name : '未知錯誤') + '），資料仍受雲端同步保護');
      return false;
    }
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(coins));
    return true;
  } catch {
    toast('儲存失敗：瀏覽器空間不足（localStorage 模式）');
    return false;
  }
}

function processImage(file){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        const max = 640;
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = () => reject(new Error('decode'));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error('read'));
    reader.readAsDataURL(file);
  });
}

function toast(msg){
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

function render(){
  updateCount();
  renderWall();
  if (mainMap) renderMap(); else needMapRender = true;
}
function updateCount(){
  $('#coin-count').textContent = coins.length + ' 枚';
}

function renderWall(){
  const q = ($('#search').value || '').trim().toLowerCase();
  const list = coins
    .filter(c => !q || [c.name, c.country, c.location].some(v => (v || '').toLowerCase().includes(q)))
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  $('#wall').innerHTML = list.map(cardHtml).join('');
  $('#empty-wall').classList.toggle('hidden', coins.length > 0);
  $('#no-result').classList.toggle('hidden', !(q && list.length === 0 && coins.length > 0));
}
function cardHtml(coin){
  const photo = coin.front
    ? '<img src="' + coin.front + '" alt="' + escapeHtml(coin.name) + '">'
    : '<div class="coin-placeholder"><span>' + escapeHtml(initial(coin)) + '</span></div>';
  const meta = [coin.location || coin.country, fmtDate(coin.date)].filter(Boolean).join(' · ') || '—';
  return '<div class="coin-card" data-id="' + coin.id + '">' +
    '<div class="coin-ring"><div class="coin-face">' + photo + '</div></div>' +
    '<div class="coin-name">' + escapeHtml(coin.name) + '</div>' +
    '<div class="coin-meta">' + escapeHtml(meta) + '</div>' +
  '</div>';
}

function openDetail(id){
  const coin = coins.find(c => c.id === id);
  if (!coin) return;
  currentDetailId = id;
  $('#detail-flip').classList.remove('flipped');
  $('#detail-flip').innerHTML = '<div class="flip-inner">' + flipSideHtml(coin, false) + (coin.back ? flipSideHtml(coin, true) : '') + '</div>';
  $('#flip-hint').classList.toggle('hidden', !coin.back);
  $('#detail-name').textContent = coin.name;
  const rows = [];
  if (coin.country) rows.push(['國家 / 地區', coin.country]);
  if (coin.location) rows.push(['取得地點', coin.location]);
  if (coin.date) rows.push(['取得日期', fmtDate(coin.date)]);
  $('#detail-rows').innerHTML = rows.map(r => '<dt>' + r[0] + '</dt><dd>' + escapeHtml(r[1]) + '</dd>').join('');
  showModal('detail-modal');
}
function flipSideHtml(coin, isBack){
  const photo = isBack ? coin.back : coin.front;
  const inner = photo
    ? '<img src="' + photo + '" alt="">'
    : '<div class="coin-placeholder"><span>' + escapeHtml(initial(coin)) + '</span></div>';
  return '<div class="flip-side' + (isBack ? ' back' : '') + '"><div class="flip-photo">' + inner + '</div></div>';
}

function deleteCurrent(){
  const coin = coins.find(c => c.id === currentDetailId);
  if (!coin) return;
  if (!confirm('確定刪除「' + coin.name + '」？此操作無法復原。')) return;
  const delId = currentDetailId;
  coins = coins.filter(c => c.id !== delId);
  recordLocalDelete(delId);
  cloudDelete(delId);
  saveCoins();
  render();
  hideModal('detail-modal');
  toast('已刪除');
}
function locateCurrent(){
  const coin = coins.find(c => c.id === currentDetailId);
  if (!coin) return;
  if (coin.lat == null || coin.lng == null){ toast('這枚紀念幣尚未標記位置'); return; }
  hideModal('detail-modal');
  switchView('map');
  setTimeout(() => {
    if (!mainMap) return;
    const m = markers[coin.id];
    if (!m) return;
    if (mapLayer.zoomToShowLayer) mapLayer.zoomToShowLayer(m, () => m.openPopup());
    else {
      mainMap.setView([coin.lat, coin.lng], 13);
      m.openPopup();
    }
  }, 150);
}

function setField(f, n, v){
  const el = f.elements.namedItem(n);
  if (el) el.value = v == null ? '' : v;
}
function openEditForm(coin){
  editingId = coin ? coin.id : null;
  $('#form-title').textContent = coin ? '編輯紀念幣' : '新增紀念幣';
  const f = $('#coin-form');
  f.reset();
  setField(f, 'name', coin ? coin.name : '');
  setField(f, 'country', coin ? coin.country || '' : '');
  setField(f, 'location', coin ? coin.location || '' : '');
  setField(f, 'date', coin ? coin.date || '' : todayStr());
  tempPhotos = { front: coin ? coin.front || null : null, back: coin ? coin.back || null : null };
  renderSlots();
  pin = coin && coin.lat != null && coin.lng != null ? { lat: coin.lat, lng: coin.lng } : null;
  currentGeocodeResults = [];
  $('#geocode-results').classList.add('hidden');
  showModal('edit-modal');
  ensureMiniMap();
}

function renderSlots(){
  ['front', 'back'].forEach(side => {
    const slot = $('.photo-slot[data-side="' + side + '"]');
    const clear = $('.photo-clear[data-side="' + side + '"]');
    if (tempPhotos[side]){
      slot.classList.add('filled');
      slot.innerHTML = '<img src="' + tempPhotos[side] + '" alt="">';
      clear.classList.remove('hidden');
    } else {
      slot.classList.remove('filled');
      slot.innerHTML = '<span class="plus">+</span>';
      clear.classList.add('hidden');
    }
  });
}

const TILE_PROVIDERS = [
  {
    name: '衛星影像',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri, Source: Esri, Maxar, Earthstar Geographics',
    maxNativeZoom: 19
  },
  {
    name: '深色地圖',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri, HERE, Garmin, USGS',
    maxNativeZoom: 16
  },
  {
    name: 'CARTO',
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; OpenStreetMap contributors, &copy; CARTO',
    maxNativeZoom: 19
  },
  {
    name: 'OpenStreetMap',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors',
    maxNativeZoom: 19
  }
];

function addTileLayer(map){
  const entries = [];

  TILE_PROVIDERS.forEach(p => {
    const layer = L.tileLayer(p.url, {
      maxZoom: 19,
      maxNativeZoom: p.maxNativeZoom,
      attribution: p.attribution
    });
    entries.push({ p, layer });
  });

  const failed = new Set();
  let active = entries[0];
  active.layer.addTo(map);

  entries.forEach(entry => {
    let errors = 0;
    let exhausted = false;
    entry.layer.on('tileerror', () => {
      errors++;
      if (errors >= 4){
        failed.add(entry.p.name);
        errors = 0;
        const next = entries.find(e => e !== entry && !failed.has(e.p.name));
        if (next){
          if (active === entry){
            map.removeLayer(entry.layer);
            active = next;
            next.layer.addTo(map);
          }
          toast('「' + entry.p.name + '」圖磚無法載入，已自動切換到「' + next.p.name + '」');
        } else if (!exhausted){
          exhausted = true;
          toast('所有圖磚來源都無法載入，請確認網路連線後重新整理');
        }
      }
    });
    entry.layer.on('tileload', () => { errors = 0; exhausted = false; });
  });
}

function ensureMiniMap(){
  if (!leafletReady()){
    toast('地圖元件需要網路連線才能載入');
    return;
  }
  if (miniMap){
    if (pin) miniMap.setView([pin.lat, pin.lng], 13);
    syncPinUI();
    setTimeout(() => miniMap.invalidateSize(), 60);
    return;
  }
  miniMap = L.map('mini-map', { scrollWheelZoom: false }).setView(pin ? [pin.lat, pin.lng] : [24.5, 121.5], pin ? 13 : 5);
  addTileLayer(miniMap);
  miniMap.on('click', ev => setPin(ev.latlng.lat, ev.latlng.lng));
  syncPinUI();
  setTimeout(() => miniMap.invalidateSize(), 60);
}
function setPin(lat, lng){
  pin = { lat, lng };
  syncPinUI();
}
function clearPin(){
  pin = null;
  syncPinUI();
}
function syncPinUI(){
  if (pin){
    $('#pin-coords').textContent = pin.lat.toFixed(4) + ', ' + pin.lng.toFixed(4);
    if (miniMap){
      if (miniMarker) miniMarker.setLatLng([pin.lat, pin.lng]);
      else miniMarker = L.marker([pin.lat, pin.lng], { icon: pinIcon() }).addTo(miniMap);
    }
  } else {
    $('#pin-coords').textContent = '尚未標記';
    if (miniMap && miniMarker){
      miniMap.removeLayer(miniMarker);
      miniMarker = null;
    }
  }
}
function pinIcon(){
  return L.divIcon({ className: 'coin-marker', html: '<div class="pin-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
}

const COUNTRY_ZH = {
  Taiwan: '台灣', TWN: '台灣', TW: '台灣',
  Japan: '日本', JPN: '日本', JP: '日本',
  'South Korea': '南韓', Korea: '南韓', KOR: '南韓', KR: '南韓',
  China: '中國', CHN: '中國', CN: '中國',
  'Hong Kong': '香港', HKG: '香港', HK: '香港',
  Macau: '澳門', Macao: '澳門', MAC: '澳門', MO: '澳門',
  Thailand: '泰國', THA: '泰國', TH: '泰國',
  Singapore: '新加坡', SGP: '新加坡', SG: '新加坡',
  Malaysia: '馬來西亞', MYS: '馬來西亞', MY: '馬來西亞',
  Vietnam: '越南', VNM: '越南', VN: '越南',
  Indonesia: '印尼', IDN: '印尼', ID: '印尼',
  Philippines: '菲律賓', PHL: '菲律賓', PH: '菲律賓',
  'United States': '美國', USA: '美國', US: '美國',
  Canada: '加拿大', CAN: '加拿大', CA: '加拿大',
  'United Kingdom': '英國', GBR: '英國', GB: '英國',
  France: '法國', FRA: '法國', FR: '法國',
  Germany: '德國', DEU: '德國', DE: '德國',
  Italy: '義大利', ITA: '義大利', IT: '義大利',
  Spain: '西班牙', ESP: '西班牙', ES: '西班牙',
  Netherlands: '荷蘭', NLD: '荷蘭', NL: '荷蘭',
  Switzerland: '瑞士', CHE: '瑞士', CH: '瑞士',
  Australia: '澳洲', AUS: '澳洲', AU: '澳洲',
  'New Zealand': '紐西蘭', NZL: '紐西蘭', NZ: '紐西蘭'
};

function countryZh(name){
  return COUNTRY_ZH[name] || name;
}

async function esriGeocode(q){
  const url = 'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?f=json&maxLocations=6&outFields=Country&singleLine=' + encodeURIComponent(q);
  const res = await fetch(url);
  if (!res.ok) throw new Error('esri ' + res.status);
  const data = await res.json();
  return (data.candidates || []).map(c => ({
    label: c.address,
    lat: c.location.y,
    lng: c.location.x,
    country: (c.attributes && c.attributes.Country) || ''
  }));
}

async function photonGeocode(q){
  const res = await fetch('https://photon.komoot.io/api/?limit=6&q=' + encodeURIComponent(q));
  if (!res.ok) throw new Error('photon ' + res.status);
  const data = await res.json();
  return (data.features || []).map(f => {
    const p = f.properties || {};
    return {
      label: [p.name, p.city, p.state, p.country].filter(Boolean).join(', '),
      lat: f.geometry.coordinates[1],
      lng: f.geometry.coordinates[0],
      country: p.country || ''
    };
  });
}

async function nominatimGeocode(q){
  const res = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=6&q=' + encodeURIComponent(q));
  if (!res.ok) throw new Error('nominatim ' + res.status);
  const data = await res.json();
  return data.map(r => ({
    label: r.display_name,
    lat: parseFloat(r.lat),
    lng: parseFloat(r.lon),
    country: ''
  }));
}

async function geocodeQuery(q){
  const providers = [esriGeocode, photonGeocode, nominatimGeocode];
  for (const fn of providers){
    try {
      const list = await fn(q);
      if (list.length) return list;
    } catch {}
  }
  return [];
}

function parsePlusCodeInput(q){
  const parts = String(q || '').trim().toUpperCase().split(/\s+/);
  const s = parts[0];
  if (!s || !/^[23456789CFGHJMPQRVWX+]+$/.test(s)) return null;
  const rest = parts.slice(1).join(' ').trim();
  if (s.indexOf('+') >= 0){
    const m = s.match(/^([23456789CFGHJMPQRVWX]{2,8})\+([23456789CFGHJMPQRVWX]{0,2})$/);
    if (m && m[1].length % 2 === 0 && m[2].length !== 1) return { pair: m[1], grid: m[2], rest: rest };
    return null;
  }
  if (s.length >= 8 && s.length <= 10) return { pair: s.slice(0, 8), grid: s.slice(8), rest: rest };
  return null;
}

function isSeaLabel(label){
  return /\b(sea|ocean|bay|gulf|strait)\b|[海洋]/i.test(String(label || ''));
}

function decodePlusCode(pc, refLat, refLng){
  const A = '23456789CFGHJMPQRVWX';
  const isShort = pc.pair.length < 8;
  const pair = isShort ? '2'.repeat(8 - pc.pair.length) + pc.pair : pc.pair;
  let lat = -90, lng = -180;
  let latRes = 20, lngRes = 20;
  for (let i = 0; i < 8; i++){
    const idx = A.indexOf(pair[i]);
    if (idx < 0) return null;
    if (i % 2 === 0){ lat += idx * latRes; latRes /= 20; }
    else { lng += idx * lngRes; lngRes /= 20; }
  }
  if (isShort){
    if (refLat == null || refLng == null) return null;
    const S = Math.pow(20, pc.pair.length / 2 - 2);
    while (lat - refLat > S / 2) lat -= S;
    while (refLat - lat > S / 2) lat += S;
    while (lng - refLng > S / 2) lng -= S;
    while (refLng - lng > S / 2) lng += S;
  }
  let cellLat = 0.0025, cellLng = 0.0025;
  for (let i = 0; i < pc.grid.length; i++){
    const v = A.indexOf(pc.grid[i]);
    if (v < 0) return null;
    lat += Math.floor(v / 5) * cellLat / 4;
    lng += (v % 5) * cellLng / 5;
    cellLat /= 4;
    cellLng /= 5;
  }
  lat += cellLat / 2;
  lng += cellLng / 2;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

async function reverseGeocodeLabel(lat, lng){
  try {
    const url = 'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/reverseGeocode?f=json&location=' + encodeURIComponent(lng + ',' + lat);
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const a = data && data.address;
    if (!a) return null;
    return { label: a.Match_addr || a.LongLabel || '', country: a.CountryCode || '' };
  } catch { return null; }
}

async function cityReference(q){
  const providers = [photonGeocode, esriGeocode, nominatimGeocode];
  for (const fn of providers){
    try {
      const list = await fn(q);
      if (list.length) return list[0];
    } catch {}
  }
  return null;
}

async function runGeocode(){
  if (geocodeBusy) return;
  const input = $('#location-input');
  const q = (input.value || '').trim();
  if (!q){ toast('請先輸入要搜尋的地點'); return; }
  geocodeBusy = true;
  const btn = $('#btn-geocode');
  btn.disabled = true;
  btn.textContent = '搜尋中…';
  const pc = parsePlusCodeInput(q);
  if (pc){
    let ref = null;
    let refSource = 'none';
    if (pc.pair.length < 8){
      if (pc.rest){
        const refPoint = await cityReference(pc.rest);
        if (refPoint){
          ref = { lat: refPoint.lat, lng: refPoint.lng };
          refSource = 'name';
        }
      }
      if (!ref && miniMap){
        ref = miniMap.getCenter();
        refSource = 'map';
      }
    }
    const decoded = decodePlusCode(pc, ref ? ref.lat : null, ref ? ref.lng : null);
    if (!decoded){
      btn.disabled = false;
      btn.textContent = '搜尋';
      geocodeBusy = false;
      toast(pc.pair.length < 8 && refSource === 'none'
        ? '簡短代碼需要城市參考：請在代碼後加上城市名，如 5WC5+W8 名古屋'
        : 'Plus Code 無法辨識，請確認代碼是否完整');
      return;
    }
    const addr = await reverseGeocodeLabel(decoded.lat, decoded.lng);
    const label = (addr && addr.label) || q.toUpperCase().split(/\s+/)[0];
    if (pc.pair.length < 8 && refSource === 'map' && isSeaLabel(label)){
      btn.disabled = false;
      btn.textContent = '搜尋';
      geocodeBusy = false;
      toast('推算結果落在海上：請在代碼後加上城市名（如 5WC5+W8 名古屋）或改用完整代碼');
      return;
    }
    btn.disabled = false;
    btn.textContent = '搜尋';
    geocodeBusy = false;
    applyGeocodeResult({
      label: label,
      lat: decoded.lat,
      lng: decoded.lng,
      country: (addr && addr.country) || ''
    });
    if (miniMap) miniMap.setView([decoded.lat, decoded.lng], 17);
    toast(pc.pair.length === 8 ? '已標記 Plus Code 位置'
      : (refSource === 'name' ? '已依城市推算簡短代碼並標記位置'
      : '已標記（依地圖中心推算，若不對請在代碼後加城市名）'));
    return;
  }
  const list = await geocodeQuery(q);
  btn.disabled = false;
  btn.textContent = '搜尋';
  geocodeBusy = false;
  if (!list.length){ toast('找不到這個地點，換個關鍵字試試'); return; }
  currentGeocodeResults = list;
  renderGeocodeResults(list);
}

function renderGeocodeResults(list){
  const box = $('#geocode-results');
  box.innerHTML = list.map((r, i) =>
    '<button type="button" class="geocode-item" data-i="' + i + '">' +
      '<span class="gi-label">' + escapeHtml(r.label) + '</span>' +
      (r.country ? '<span class="gi-sub">' + escapeHtml(countryZh(r.country)) + '</span>' : '') +
    '</button>'
  ).join('');
  box.classList.remove('hidden');
}

function applyGeocodeResult(r){
  const f = $('#coin-form');
  setField(f, 'location', r.label);
  setPin(r.lat, r.lng);
  if (miniMap) miniMap.setView([r.lat, r.lng], 15);
  const countryInput = f.elements.namedItem('country');
  if (r.country && countryInput && !countryInput.value.trim()){
    setField(f, 'country', countryZh(r.country));
  }
  $('#geocode-results').classList.add('hidden');
}

async function submitForm(e){
  e.preventDefault();
  const f = $('#coin-form');
  const fd = new FormData(f);
  const name = String(fd.get('name') || '').trim();
  if (!name){ toast('請輸入幣名'); return; }
  const data = {
    name,
    country: String(fd.get('country') || '').trim(),
    location: String(fd.get('location') || '').trim(),
    date: String(fd.get('date') || '').trim(),
    front: tempPhotos.front,
    back: tempPhotos.back,
    lat: pin ? pin.lat : null,
    lng: pin ? pin.lng : null
  };
  const now = new Date().toISOString();
  let saved;
  if (editingId){
    const i = coins.findIndex(c => c.id === editingId);
    if (i >= 0){
      coins[i] = { id: coins[i].id, createdAt: coins[i].createdAt, updatedAt: now, ...data };
      saved = coins[i];
    }
  } else {
    saved = { id: uid(), createdAt: now, updatedAt: now, ...data };
    coins.push(saved);
  }
  const savedOk = await saveCoins();
  render();
  hideModal('edit-modal');
  cloudSet(saved);
  if (savedOk) toast(editingId ? '已更新' : '已新增 1 枚紀念幣');
}

function spiderfyPositions(count, center){
  const res = [];
  res.length = count;
  if (count < 9){
    const r = Math.max(25 * (2 + count) / (2 * Math.PI), 58);
    const step = 2 * Math.PI / count;
    for (let i = 0; i < count; i++){
      const a = i * step;
      res[i] = new L.Point(center.x + r * Math.cos(a), center.y + r * Math.sin(a))._round();
    }
  } else {
    let r = 58;
    const separation = 34;
    const growth = 5 * 2 * Math.PI;
    let angle = 0;
    for (let i = count; i >= 0; i--){
      if (i < count){
        res[i] = new L.Point(center.x + r * Math.cos(angle), center.y + r * Math.sin(angle))._round();
      }
      angle += separation / r + i * 0.0005;
      r += growth / angle;
    }
  }
  return res;
}

function ensureMainMap(){
  if (mainMap) return;
  if (!leafletReady()){
    const hint = $('#map-empty');
    hint.textContent = '地圖元件需要網路連線才能載入，圖鑑牆與資料儲存不受影響';
    hint.classList.remove('hidden');
    return;
  }
  mainMap = L.map('map', { worldCopyJump: true }).setView([24.5, 121.5], 6);
  addTileLayer(mainMap);
  if (typeof L.MarkerClusterGroup === 'function'){
    mapLayer = L.markerClusterGroup({
      showCoverageOnHover: false,
      maxClusterRadius: 45,
      spiderfyShapePositions: spiderfyPositions,
      spiderLegPolylineOptions: { weight: 2, color: '#d9a441', opacity: 0.6 }
    }).addTo(mainMap);
  } else {
    mapLayer = L.layerGroup().addTo(mainMap);
  }
  renderMap();
}
function renderMap(){
  if (!mainMap){ needMapRender = true; return; }
  mapLayer.clearLayers();
  markers = {};
  const pts = [];
  coins.forEach(coin => {
    if (coin.lat == null || coin.lng == null) return;
    const m = L.marker([coin.lat, coin.lng], { icon: markerIcon(coin) }).addTo(mapLayer);
    m.bindPopup(popupHtml(coin));
    markers[coin.id] = m;
    pts.push([coin.lat, coin.lng]);
  });
  const hint = $('#map-empty');
  hint.textContent = MAP_HINT_DEFAULT;
  hint.classList.toggle('hidden', pts.length > 0);
  if (pts.length === 1) mainMap.setView(pts[0], 8);
  else if (pts.length > 1){
    const b = L.latLngBounds(pts).pad(0.25);
    mainMap.setView(b.getCenter(), Math.min(mainMap.getBoundsZoom(b), 16));
  }
}
function markerIcon(coin){
  const style = coin.front ? 'background-image:url(' + coin.front + ');' : '';
  const label = coin.front ? '' : '<span>' + escapeHtml(initial(coin)) + '</span>';
  return L.divIcon({
    className: 'coin-marker',
    html: '<div class="coin-marker-inner" style="' + style + '">' + label + '</div>',
    iconSize: [34, 34],
    iconAnchor: [17, 17],
    popupAnchor: [0, -14]
  });
}
function popupHtml(coin){
  const img = coin.front
    ? '<img src="' + coin.front + '" alt="">'
    : '<div class="coin-placeholder"><span>' + escapeHtml(initial(coin)) + '</span></div>';
  const meta = [coin.location || coin.country, fmtDate(coin.date)].filter(Boolean).join(' · ');
  return '<div class="popup">' +
    '<div class="popup-img">' + img + '</div>' +
    '<div class="popup-name">' + escapeHtml(coin.name) + '</div>' +
    '<div class="popup-meta">' + escapeHtml(meta) + '</div>' +
    '<button class="popup-btn" onclick="openDetail(\'' + coin.id + '\')">查看</button>' +
  '</div>';
}

function switchView(v){
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === v));
  $('#wall-view').classList.toggle('active', v === 'wall');
  $('#map-view').classList.toggle('active', v === 'map');
  if (v === 'map'){
    ensureMainMap();
    if (needMapRender){ renderMap(); needMapRender = false; }
    setTimeout(() => mainMap && mainMap.invalidateSize(), 60);
  }
}

function showModal(id){
  $('#' + id).classList.remove('hidden');
}
function hideModal(id){
  $('#' + id).classList.add('hidden');
}
function closeEditModal(){
  hideModal('edit-modal');
}

function syncConfigured(){
  const c = window.FIREBASE_CONFIG;
  return !!(c && c.projectId && c.apiKey && c.projectId.indexOf('貼上') === -1 && c.apiKey.indexOf('貼上') === -1);
}

async function loadFirebase(){
  if (fbDb) return;
  const v = '10.12.2';
  const [appMod, authMod, fsMod] = await Promise.all([
    import('https://www.gstatic.com/firebasejs/' + v + '/firebase-app.js'),
    import('https://www.gstatic.com/firebasejs/' + v + '/firebase-auth.js'),
    import('https://www.gstatic.com/firebasejs/' + v + '/firebase-firestore.js')
  ]);
  const app = appMod.initializeApp(window.FIREBASE_CONFIG);
  fbAuth = authMod;
  fbFs = fsMod;
  fbDb = fsMod.getFirestore(app);
}

function coinTime(c){
  return String(c.updatedAt || c.createdAt || '');
}
function mergeCoins(local, cloud){
  const map = new Map();
  [].concat(local, cloud).forEach(c => {
    const prev = map.get(c.id);
    if (!prev || coinTime(c) > coinTime(prev)) map.set(c.id, c);
  });
  return Array.from(map.values());
}
function coinsSignature(list){
  return JSON.stringify((list || []).map(c => [c.id, coinTime(c)]).sort());
}

function loadPendingDeletes(){
  try {
    const arr = JSON.parse(localStorage.getItem(DELETED_KEY) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function recordLocalDelete(id){
  const list = loadPendingDeletes();
  if (list.indexOf(id) === -1){
    list.push(id);
    try { localStorage.setItem(DELETED_KEY, JSON.stringify(list)); } catch {}
  }
}

function applyCloudState(cloud){
  let merged = coins;
  if (cloud) merged = mergeCoins(coins, cloud);
  merged = merged.filter(c => !tombIds.has(c.id));
  if (coinsSignature(merged) !== coinsSignature(coins)){
    coins = merged;
    saveCoins();
    render();
  }
}

function coinStamp(c){
  return String(c.updatedAt || c.createdAt || '');
}

function diffCoinsForPush(localCoins, cloudCoins, tombSet){
  const byId = new Map((cloudCoins || []).map(c => [c.id, c]));
  return (localCoins || []).filter(c => {
    if (tombSet.has(c.id)) return false;
    const remote = byId.get(c.id);
    if (!remote) return true;
    return coinStamp(remote) !== coinStamp(c);
  });
}

function startSnapshot(uid){
  if (fbUnsub && snapUid === uid) return;
  if (fbUnsub){ fbUnsub(); fbUnsub = null; }
  snapUid = uid;
  const unsubCoins = fbFs.onSnapshot(fbFs.collection(fbDb, 'users', uid, 'coins'), snap => {
    coinsSnap = snap;
    const cloud = snap.docs.map(d => d.data()).filter(c => c && c.id && c.name);
    applyCloudState(cloud);
  }, () => {});
  const unsubDeleted = fbFs.onSnapshot(fbFs.collection(fbDb, 'users', uid, 'deleted'), snap => {
    deletedSnap = snap;
    tombIds = new Set(snap.docs.map(d => d.id));
    applyCloudState(null);
  }, () => {});
  fbUnsub = () => { unsubCoins(); unsubDeleted(); };
}

async function syncNow(silent){
  if (!syncUser) return;
  if (syncBusy){ if (!silent) toast('同步進行中，請稍候'); return; }
  syncBusy = true;
  try {
    const uid = syncUser.uid;
    let cloud;
    if (coinsSnap && !coinsSnap.metadata.fromCache){
      cloud = coinsSnap.docs.map(d => d.data()).filter(c => c && c.id && c.name);
    } else {
      const cSnap = await fbFs.getDocs(fbFs.collection(fbDb, 'users', uid, 'coins'));
      cloud = cSnap.docs.map(d => d.data()).filter(c => c && c.id && c.name);
    }
    let tombList;
    if (deletedSnap && !deletedSnap.metadata.fromCache){
      tombList = deletedSnap.docs.map(d => d.id);
    } else {
      const dSnap = await fbFs.getDocs(fbFs.collection(fbDb, 'users', uid, 'deleted'));
      tombList = dSnap.docs.map(d => d.id);
    }
    tombIds = new Set(tombList);

    const merged = mergeCoins(coins, cloud).filter(c => !tombIds.has(c.id));
    const pending = loadPendingDeletes();
    const toPush = diffCoinsForPush(merged, cloud, tombIds);

    if (pending.length || toPush.length){
      let batch = fbFs.writeBatch(fbDb);
      let ops = 0;
      const flush = async () => {
        if (ops > 0) await batch.commit();
        batch = fbFs.writeBatch(fbDb);
        ops = 0;
      };
      for (const id of pending){
        tombIds.add(id);
        batch.set(fbFs.doc(fbDb, 'users', uid, 'deleted', id), { id: id, at: new Date().toISOString() });
        batch.delete(fbFs.doc(fbDb, 'users', uid, 'coins', id));
        ops++;
        if (ops >= 400) await flush();
      }
      for (const c of toPush){
        batch.set(fbFs.doc(fbDb, 'users', uid, 'coins', c.id), c);
        ops++;
        if (ops >= 400) await flush();
      }
      await flush();
      if (pending.length){
        try { localStorage.removeItem(DELETED_KEY); } catch {}
      }
    }

    coins = merged;
    saveCoins();
    render();
    startSnapshot(uid);
    if (!silent) toast('同步完成，共 ' + coins.length + ' 枚');
  } finally {
    syncBusy = false;
  }
}

async function cloudSet(coin){
  if (!syncUser || !fbDb) return;
  try {
    await fbFs.setDoc(fbFs.doc(fbDb, 'users', syncUser.uid, 'coins', coin.id), coin);
  } catch {}
}
async function cloudDelete(id){
  if (!syncUser || !fbDb) return;
  try {
    await fbFs.setDoc(fbFs.doc(fbDb, 'users', syncUser.uid, 'deleted', id), { id: id, at: new Date().toISOString() });
    await fbFs.deleteDoc(fbFs.doc(fbDb, 'users', syncUser.uid, 'coins', id));
  } catch {}
}

function syncErrMsg(err, isCreate){
  const code = err && err.code ? err.code : '';
  if (code === 'auth/email-already-in-use') return '此 Email 已註冊過，請改用登入';
  if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found') return 'Email 或密碼不正確';
  if (code === 'auth/weak-password') return '密碼至少需要 6 個字元';
  if (code === 'auth/invalid-email') return 'Email 格式不正確';
  if (code === 'auth/too-many-requests') return '嘗試次數過多，請稍後再試';
  if (code === 'auth/unauthorized-domain') return '此網域尚未加入 Firebase 授權網域，詳見部署說明';
  if (code === 'auth/network-request-failed' || code === 'auth/internal-error') return '網路連線異常，請確認網路';
  return isCreate ? '建立帳號失敗，請稍後再試' : '登入失敗，請稍後再試';
}

function updateSyncModal(){
  if (syncUser){
    $('#sync-logged-out').classList.add('hidden');
    $('#sync-logged-in').classList.remove('hidden');
    $('#sync-account').textContent = '已登入：' + (syncUser.email || '') + '，變更會自動同步到所有裝置';
  } else {
    $('#sync-logged-out').classList.remove('hidden');
    $('#sync-logged-in').classList.add('hidden');
  }
}

async function doLogin(isCreate){
  const email = $('#login-email').value.trim();
  const pass = $('#login-pass').value;
  if (!email || !pass){ toast('請輸入 Email 與密碼'); return; }
  try {
    await loadFirebase();
    const auth = fbAuth.getAuth();
    if (isCreate) await fbAuth.createUserWithEmailAndPassword(auth, email, pass);
    else await fbAuth.signInWithEmailAndPassword(auth, email, pass);
    syncUser = auth.currentUser;
    $('#login-pass').value = '';
    updateSyncModal();
    hideModal('sync-modal');
    await syncNow();
  } catch (err){
    toast(syncErrMsg(err, isCreate));
  }
}

async function doLogout(){
  try {
    if (fbAuth) await fbAuth.signOut(fbAuth.getAuth());
  } catch {}
  if (fbUnsub){ fbUnsub(); fbUnsub = null; }
  syncUser = null;
  snapUid = null;
  coinsSnap = null;
  deletedSnap = null;
  tombIds = new Set();
  updateSyncModal();
  hideModal('sync-modal');
  toast('已登出，此裝置改為僅本機記錄');
}

async function initSync(){
  if (!syncConfigured()) return;
  try {
    await loadFirebase();
    fbAuth.onAuthStateChanged(fbAuth.getAuth(), user => {
      syncUser = user;
      if (user) syncNow(true).catch(() => {});
    });
  } catch {}
}

function loadSample(){
  const base = [
    ['九份老街紀念幣', '台灣', '新北市瑞芳區 九份老街', '2025-11-02', 25.1087, 121.8445],
    ['台北 101 紀念幣', '台灣', '台北 101 觀景台', '2026-01-15', 25.0338, 121.5645],
    ['清水寺紀念幣', '日本', '京都 清水寺', '2026-04-08', 34.9949, 135.7850],
    ['艾菲爾鐵塔紀念幣', '法國', '巴黎 艾菲爾鐵塔', '2026-07-20', 48.8584, 2.2945]
  ];
  base.forEach(a => coins.push({
    id: uid(),
    createdAt: new Date().toISOString(),
    name: a[0], country: a[1], location: a[2], date: a[3],
    front: null, back: null,
    lat: a[4], lng: a[5]
  }));
  saveCoins();
  render();
  toast('已載入 4 枚示範紀念幣，可自行編輯或刪除');
}

async function onPhotoFile(e){
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !sideTarget) return;
  try {
    tempPhotos[sideTarget] = await processImage(file);
    renderSlots();
    toast('照片已加入');
  } catch {
    toast('圖片讀取失敗，請換一張試試');
  }
}

function bindEvents(){
  $('#btn-add').addEventListener('click', () => openEditForm(null));
  $('#btn-add-empty').addEventListener('click', () => openEditForm(null));
  $('#btn-sample').addEventListener('click', loadSample);
  $('#search').addEventListener('input', renderWall);
  $$('.tab').forEach(t => t.addEventListener('click', () => switchView(t.dataset.view)));

  $('#wall').addEventListener('click', e => {
    const card = e.target.closest('.coin-card');
    if (card) openDetail(card.dataset.id);
  });

  $('#detail-flip').addEventListener('click', () => {
    const coin = coins.find(c => c.id === currentDetailId);
    if (coin && coin.back) $('#detail-flip').classList.toggle('flipped');
  });
  $('#btn-edit').addEventListener('click', () => {
    const coin = coins.find(c => c.id === currentDetailId);
    if (coin) openEditForm(coin);
  });
  $('#btn-delete').addEventListener('click', deleteCurrent);
  $('#btn-locate').addEventListener('click', locateCurrent);

  $('#coin-form').addEventListener('submit', submitForm);
  $('#btn-cancel').addEventListener('click', closeEditModal);
  $('#btn-clear-pin').addEventListener('click', clearPin);
  $('#btn-sync').addEventListener('click', () => {
    if (!syncConfigured()){ toast('尚未設定雲端同步：請在 sync-config.js 填入 Firebase 設定'); return; }
    updateSyncModal();
    showModal('sync-modal');
  });
  $('#login-form').addEventListener('submit', e => { e.preventDefault(); doLogin(false); });
  $('#btn-create-account').addEventListener('click', () => doLogin(true));
  $('#btn-sync-now').addEventListener('click', async () => {
    const btn = $('#btn-sync-now');
    btn.disabled = true;
    btn.textContent = '同步中…';
    try { await syncNow(); } catch { toast('同步失敗，請確認網路連線'); }
    btn.disabled = false;
    btn.textContent = '立即同步';
  });
  $('#btn-logout').addEventListener('click', doLogout);
  $('#btn-geocode').addEventListener('click', runGeocode);
  $('#location-input').addEventListener('keydown', e => {
    if (e.key === 'Enter'){ e.preventDefault(); runGeocode(); }
  });
  $('#geocode-results').addEventListener('click', e => {
    const item = e.target.closest('.geocode-item');
    if (!item) return;
    const r = currentGeocodeResults[parseInt(item.dataset.i, 10)];
    if (r) applyGeocodeResult(r);
  });

  $('#photo-file').addEventListener('change', onPhotoFile);

  $$('.photo-slot').forEach(slot => slot.addEventListener('click', () => {
    sideTarget = slot.dataset.side;
    $('#photo-file').click();
  }));
  $$('.photo-clear').forEach(btn => btn.addEventListener('click', () => {
    tempPhotos[btn.dataset.side] = null;
    renderSlots();
  }));

  $$('.modal-backdrop').forEach(b => {
    b.addEventListener('click', e => { if (e.target === b) hideModal(b.id); });
  });
  $$('[data-close]').forEach(btn => btn.addEventListener('click', () => hideModal(btn.dataset.close)));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape'){
      $$('.modal-backdrop').forEach(m => m.classList.add('hidden'));
      $('#geocode-results').classList.add('hidden');
    }
  });

}

async function init(){
  bindEvents();
  await initStorage();
  render();
  initSync();
}
init();
