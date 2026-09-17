import { db, uid } from './db.js';
import { readTags, guessFromFilename, probeDuration } from './tags.js';
import * as deezer from './deezer.js';
import * as spotify from './spotify.js';
import { Player } from './player.js';
import * as cloud from './cloud.js';

/* ================= Utilitaires ================= */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const icon = (name, cls = '') => `<svg class="i ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const AUDIO_EXT = /\.(mp3|m4a|aac|flac|wav|ogg|oga|opus|webm|aiff?)$/i;
const AUDIO_MIME = { mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', webm: 'audio/webm', aif: 'audio/aiff', aiff: 'audio/aiff' };
const IS_IOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// Type MIME fiable : les téléchargements et certains sélecteurs de fichiers renvoient un type vide
function audioType(blob, fileName) {
  if (blob?.type && blob.type !== 'application/octet-stream') return blob.type;
  const ext = String(fileName || '').split('.').pop().toLowerCase();
  return AUDIO_MIME[ext] || 'audio/mpeg';
}
const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;

function fmt(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtTotal(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
}

function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

const prefs = {
  data: (() => { try { return JSON.parse(localStorage.getItem('sillon.prefs')) || {}; } catch { return {}; } })(),
  get(k, d) { return this.data[k] ?? d; },
  set(k, v) {
    this.data[k] = v;
    try { localStorage.setItem('sillon.prefs', JSON.stringify(this.data)); } catch { /* ignore */ }
  },
};

/* ================= Bibliothèque ================= */
const lib = {
  tracks: new Map(),
  playlists: new Map(),
  covers: new Map(),     // clé → objectURL
  localIndex: new Map(), // « titre|artiste » → fileKey
  localByTitle: new Map(), // « titre » → [{ artist, fileKey }]
};

async function loadLibrary() {
  const [tracks, playlists, covers] = await Promise.all([db.getAll('tracks'), db.getAll('playlists'), db.getAll('covers')]);
  tracks.forEach((t) => lib.tracks.set(t.id, t));
  playlists.forEach((p) => lib.playlists.set(p.id, p));
  covers.forEach((c) => lib.covers.set(c.id, URL.createObjectURL(c.blob)));
  reindex();
}

function norm(s) {
  return (s || '')
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/\s-\s.*$/, ' ')
    .replace(/\s(feat|ft)\.?\s.*$/, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function matchKey(t) {
  const title = norm(t.title);
  if (!title) return null;
  const artist = norm((t.artist || '').split(/,|&| feat| ft\.| x /i)[0]);
  return `${title}|${artist}`;
}

function reindex() {
  lib.localIndex.clear();
  lib.localByTitle.clear();
  for (const t of lib.tracks.values()) {
    if (!t.fileKey) continue;
    const k = matchKey(t);
    if (!k) continue;
    if (!lib.localIndex.has(k)) lib.localIndex.set(k, t.fileKey);
    const title = k.split('|')[0];
    if (!lib.localByTitle.has(title)) lib.localByTitle.set(title, []);
    lib.localByTitle.get(title).push({ artist: norm(t.artist), fileKey: t.fileKey });
  }
}

// Deux noms d'artistes se recoupent s'ils partagent un mot significatif
function artistsOverlap(a, b) {
  if (!a || !b) return true;
  const words = a.split(' ').filter((w) => w.length > 2);
  return words.some((w) => b.includes(w)) || b.includes(a) || a.includes(b);
}

const coverSrc = (t) => (t?.coverKey ? lib.covers.get(t.coverKey) : t?.coverUrl) || null;

// Fichier audio à lire pour ce titre : associé, identique, ou même titre et artiste proche
function localFileFor(t) {
  if (t.fileKey) return t.fileKey;
  const k = matchKey(t);
  if (!k) return null;
  if (lib.localIndex.has(k)) return lib.localIndex.get(k);
  const candidates = lib.localByTitle.get(k.split('|')[0]) || [];
  const artist = norm(t.artist);
  return candidates.find((c) => artistsOverlap(c.artist, artist))?.fileKey || null;
}

function spotifyPlaybackOn() {
  return spotify.isConnected() && spotify.profile()?.premium && prefs.get('spotifyPlayback', true);
}

// Un titre est lisible s'il a un fichier, un lien direct ou une version Spotify Premium
function isPlayable(t) {
  if (localFileFor(t) || t.source === 'url') return true;
  return Boolean(spotifyPlaybackOn() && (t.spotifyUri || t.isrc));
}

// Sur mobile, le SDK Spotify ne fonctionne pas : on pilote l'app Spotify (Connect)
let deviceCheck = { at: 0, ok: false, warned: false };
async function spotifyRoute() {
  if (spotify.sdkSupported()) return 'sdk';
  if (Date.now() - deviceCheck.at > 20000) {
    const device = await spotify.pickDevice().catch(() => null);
    deviceCheck = { ...deviceCheck, at: Date.now(), ok: Boolean(device) };
  }
  if (deviceCheck.ok) return 'connect';
  if (!deviceCheck.warned) {
    deviceCheck.warned = true;
    toast('Pour écouter en entier via Spotify, ouvre l’app Spotify sur ce téléphone et lance un titre, puis reviens ici.', { timeout: 9000 });
  }
  return null;
}

async function saveTrack(t) {
  lib.tracks.set(t.id, t);
  await db.put('tracks', t);
  cloud.touch('track', t.id);
}

async function savePlaylist(p) {
  p.updatedAt = Date.now();
  lib.playlists.set(p.id, p);
  await db.put('playlists', p);
  cloud.touch('playlist', p.id);
}

function sortedPlaylists() {
  return [...lib.playlists.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/* ================= Lecteur ================= */
const player = new Player({
  getTrack: (id) => lib.tracks.get(id),
  artFor: coverSrc,
  crossfade: () => prefs.get('crossfade', 5),
  canPlay: (t) => Boolean(t) && isPlayable(t),
  resolve: async (t) => {
    const fileKey = localFileFor(t);
    let missing = null;
    if (fileKey) {
      const owner = [...lib.tracks.values()].find((x) => x.fileKey === fileKey) || t;
      let blob = await db.get('files', fileKey);
      // Fichier sauvegardé dans le compte mais pas encore sur cet appareil
      if (!blob && cloud.currentUser()) {
        blob = await cloud.downloadAudio(fileKey);
        if (blob) {
          blob = new Blob([blob], { type: audioType(blob, owner.fileName) });
          await db.put('files', blob, fileKey).catch(() => {});
        } else {
          missing = owner.cloudSkip === 'too-big'
            ? `« ${t.title} » dépasse 50 Mo : il n’est que sur l’appareil où tu l’as importé.`
            : `« ${t.title} » n’est pas encore dans ton compte. Ouvre Sillon sur l’appareil où tu l’as importé et attends la fin de l’envoi.`;
        }
      } else if (!blob) {
        missing = `Le fichier de « ${t.title} » n’est pas sur cet appareil. Connecte-toi à ton compte pour le récupérer.`;
      }
      if (blob) {
        const type = audioType(blob, owner.fileName);
        // Safari lit mal les fichiers servis directement depuis IndexedDB : on passe par une copie en mémoire
        if (IS_IOS || blob.type !== type) blob = new Blob([await blob.arrayBuffer()], { type });
      }
      if (blob) return { type: 'audio', url: URL.createObjectURL(blob), revoke: true, mode: 'full' };
    }
    if (t.source === 'url') return { type: 'audio', url: t.url, mode: 'full' };
    const via = spotifyPlaybackOn() && (t.spotifyUri || t.isrc) ? await spotifyRoute() : null;
    if (via) {
      let uri = t.spotifyUri;
      if (!uri && t.isrc) {
        try {
          const r = await spotify.api(`/search?type=track&limit=1&q=isrc:${encodeURIComponent(t.isrc)}`);
          uri = r?.tracks?.items?.[0]?.uri;
          if (uri) saveTrack({ ...t, spotifyUri: uri });
        } catch { /* titre introuvable sur Spotify */ }
      }
      if (uri) return { type: 'spotify', uri, via };
    }
    if (missing) throw new Error(missing);
    return { type: 'skip' };
  },
});
player.context = null;

const lists = new Map(); // clé de liste affichée → ids

// Titre sans source complète : on propose Deezer (ton abonnement) ou ton fichier
function unavailableSheet(t) {
  const onDeezer = t.source === 'deezer' && t.link;
  openSheet('Pas de version complète ici', `
    <div class="sheet-track">${artHtml(coverSrc(t), '', 'sheet-art')}<span class="row-main"><span class="row-title">${esc(t.title)}</span><span class="row-sub">${esc(t.artist || '')}</span></span></div>
    <p class="sheet-text">${onDeezer
      ? 'Deezer ne permet pas aux autres apps de lire ses titres en entier, même avec Premium. Tu peux l’écouter dans Deezer, ou associer ton propre fichier pour l’écouter ici.'
      : 'Associe ton propre fichier audio pour écouter ce titre en entier ici.'}</p>
    <div class="sheet-actions">
      <button class="btn btn-ghost" data-action="u-attach">${icon('note')} Associer mon fichier</button>
      ${onDeezer ? `<a class="btn btn-primary" href="${esc(t.link)}" target="_blank" rel="noopener" data-action="u-open">Écouter sur Deezer</a>` : ''}
    </div>`, {
    'u-attach': () => { closeSheet(); pendingAttachId = t.id; attachInput.click(); },
    'u-open': () => { closeSheet(); window.open(t.link, '_blank', 'noopener'); },
  });
}

function playFrom(key, id) {
  const ids = lists.get(key);
  if (!ids?.length) return;
  const t = lib.tracks.get(id);
  if (t && !isPlayable(t)) return unavailableSheet(t);
  player.context = { key, name: listName(key) };
  player.playList(ids, id);
}

function playCollection(key, shuffle = false) {
  const ids = lists.get(key);
  if (!ids?.length) return toast('Cette liste est vide.');
  const playable = ids.filter((id) => isPlayable(lib.tracks.get(id)));
  if (!playable.length) return toast('Aucun titre de cette liste n’a de version complète. Utilise « Compléter avec mes fichiers ».', { timeout: 7000 });
  if (player.shuffle !== shuffle) player.toggleShuffle();
  const start = shuffle ? playable[Math.floor(Math.random() * playable.length)] : playable[0];
  player.context = { key, name: listName(key) };
  player.playList(ids, start);
}

function listName(key) {
  if (key === 'liked') return 'Titres likés';
  if (key === 'all') return 'Tous les titres';
  if (key.startsWith('playlist:')) return lib.playlists.get(key.slice(9))?.name || '';
  if (key === 'search') return 'Recherche';
  return 'Ajoutés récemment';
}

/* ================= Toasts & feuilles ================= */
function toast(message, { error = false, timeout = 4200 } = {}) {
  const el = document.createElement('div');
  el.className = `toast${error ? ' is-error' : ''}`;
  el.setAttribute('role', error ? 'alert' : 'status');
  el.textContent = message;
  $('#toasts').appendChild(el);
  const close = () => { el.classList.add('is-leaving'); setTimeout(() => el.remove(), 250); };
  if (timeout) setTimeout(close, timeout);
  return { el, update: (m) => { el.textContent = m; }, close, done: (m) => { el.textContent = m; setTimeout(close, 3000); } };
}

const sheet = $('#sheet');
let sheetActions = {};

function openSheet(title, body, actions = {}) {
  clearTimeout(sheetCloseTimer);
  sheet.classList.remove('is-closing');
  sheetActions = actions;
  sheet.innerHTML = `
    <div class="sheet-panel">
      <div class="sheet-head">
        <h2 class="sheet-title">${esc(title)}</h2>
        <button class="icon-btn" data-action="sheet-close" aria-label="Fermer">${icon('close')}</button>
      </div>
      <div class="sheet-body">${body}</div>
    </div>`;
  if (!sheet.open) sheet.showModal();
  const first = sheet.querySelector('input:not([type=checkbox]), textarea');
  if (first) first.focus();
}

let sheetCloseTimer = 0;
function closeSheet() {
  sheetActions = {};
  if (!sheet.open || sheet.classList.contains('is-closing')) return;
  if (REDUCED_MOTION.matches) { sheet.close(); return; }
  sheet.classList.add('is-closing');
  sheetCloseTimer = setTimeout(() => { sheet.classList.remove('is-closing'); sheet.close(); }, 200);
}

sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(); });
sheet.addEventListener('close', () => { sheetActions = {}; });

function confirmSheet(title, text, label, onConfirm) {
  openSheet(title, `
    <p class="sheet-text">${esc(text)}</p>
    <div class="sheet-actions">
      <button class="btn btn-ghost" data-action="sheet-close">Annuler</button>
      <button class="btn btn-danger" data-action="confirm">${esc(label)}</button>
    </div>`, { confirm: async () => { closeSheet(); await onConfirm(); } });
}

function promptSheet(title, label, value, submitLabel, onSubmit) {
  openSheet(title, `
    <form class="form" data-form="prompt">
      <label class="field"><span class="field-label">${esc(label)}</span>
        <input class="input" name="value" value="${esc(value)}" required maxlength="120" autocomplete="off"></label>
      <div class="sheet-actions">
        <button type="button" class="btn btn-ghost" data-action="sheet-close">Annuler</button>
        <button class="btn btn-primary">${esc(submitLabel)}</button>
      </div>
    </form>`);
  $('form', sheet).addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = new FormData(e.target).get('value').trim();
    if (!v) return;
    closeSheet();
    await onSubmit(v);
  });
}

/* ================= Pochettes ================= */
function artHtml(src, alt = '', cls = '') {
  return src
    ? `<img class="art ${cls}" src="${esc(src)}" alt="${esc(alt)}" loading="lazy" decoding="async">`
    : `<span class="art art-empty ${cls}" aria-hidden="true">${icon('note')}</span>`;
}

function playlistArt(p, cls = '') {
  if (p.coverUrl) return artHtml(p.coverUrl, '', cls);
  const covers = [];
  for (const id of p.trackIds) {
    const src = coverSrc(lib.tracks.get(id));
    if (src && !covers.includes(src)) covers.push(src);
    if (covers.length === 4) break;
  }
  if (covers.length === 4) {
    return `<span class="art mosaic ${cls}">${covers.map((c) => `<img src="${esc(c)}" alt="" loading="lazy">`).join('')}</span>`;
  }
  if (covers.length) return artHtml(covers[0], '', cls);
  return monogram(p.name, cls);
}

function monogram(name, cls = '') {
  const hue = parseInt(hash(name || '?'), 36) % 360;
  const letter = (name || '?').trim().charAt(0).toUpperCase();
  return `<span class="art monogram ${cls}" style="--h:${hue}" aria-hidden="true">${esc(letter)}</span>`;
}

const colorCache = new Map();
const colorValues = new Map(); // couleurs déjà calculées, utilisables sans attendre
function ambientColor(src) {
  if (!src) return Promise.resolve(null);
  if (colorCache.has(src)) return colorCache.get(src);
  const p = new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 24;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, 24, 24);
        const d = ctx.getImageData(0, 0, 24, 24).data;
        let r = 0, g = 0, b = 0, w = 0;
        for (let i = 0; i < d.length; i += 4) {
          const max = Math.max(d[i], d[i + 1], d[i + 2]);
          const min = Math.min(d[i], d[i + 1], d[i + 2]);
          const weight = 0.08 + (max - min) / 255; // privilégie les pixels colorés
          r += d[i] * weight; g += d[i + 1] * weight; b += d[i + 2] * weight; w += weight;
        }
        resolve(toAmbient(r / w, g / w, b / w));
      } catch { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
  colorCache.set(src, p);
  p.then((c) => { if (c) colorValues.set(src, c); });
  return p;
}

function toAmbient(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0;
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  h = Math.round(h * 60 + 360) % 360;
  // Peu saturée (pochette noir et blanc) : on reste sur le violet néon
  if (s < 0.12) return 'hsl(262 90% 62%)';
  return `hsl(${h} ${Math.round(Math.min(Math.max(s, 0.7), 1) * 100)}% ${Math.round(Math.min(Math.max(l, 0.52), 0.64) * 100)}%)`;
}

/* ================= Rendu des listes ================= */
function trackRows(key, ids, { removable = false, numbered = true } = {}) {
  lists.set(key, ids);
  if (!ids.length) return '';
  const current = player.current?.id;
  const rows = ids.map((id, i) => {
    const t = lib.tracks.get(id);
    if (!t) return '';
    const unavailable = !isPlayable(t);
    return `
      <li class="row${id === current ? ' is-current' : ''}${unavailable ? ' is-unavailable' : ''}" data-id="${esc(id)}">
        <span class="row-num">${numbered ? `<span class="row-index">${i + 1}</span>` : ''}${icon('play', 'row-play')}<span class="eq" aria-hidden="true"><i></i><i></i><i></i></span></span>
        ${artHtml(coverSrc(t), '', 'row-art')}
        <span class="row-main">
          <span class="row-title">${esc(t.title || 'Sans titre')}</span>
          <span class="row-sub">${esc(t.artist || 'Artiste inconnu')}</span>
        </span>
        <span class="row-album">${esc(t.album || '')}</span>
        <button class="icon-btn like${t.liked ? ' is-on' : ''}" data-action="like" data-like="${esc(id)}" aria-pressed="${Boolean(t.liked)}" aria-label="J’aime">${icon('heart')}</button>
        <span class="row-time">${t.duration ? fmt(t.duration) : ''}</span>
        <button class="icon-btn" data-action="track-menu" data-removable="${removable}" aria-label="Plus d’options pour ${esc(t.title)}">${icon('more')}</button>
      </li>`;
  }).join('');
  return `<ol class="tracks" data-list="${esc(key)}">${rows}</ol>`;
}

function tile(href, art, name, sub) {
  return `<a class="tile" href="${href}">${art}<span class="tile-name">${esc(name)}</span><span class="tile-sub">${esc(sub)}</span></a>`;
}

function likedIds() {
  return [...lib.tracks.values()].filter((t) => t.liked).sort((a, b) => b.liked - a.liked).map((t) => t.id);
}

function allIds() {
  return [...lib.tracks.values()].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).map((t) => t.id);
}

/* ================= Vues ================= */
const views = {
  home() {
    if (!lib.tracks.size && !lib.playlists.size) return onboardingView();
    const liked = likedIds();
    const tiles = [
      liked.length ? tile('#/liked', `<span class="art liked-art">${icon('heart')}</span>`, 'Titres likés', plural(liked.length, 'titre')) : '',
      tile('#/all', `<span class="art all-art">${icon('note')}</span>`, 'Tous les titres', plural(lib.tracks.size, 'titre')),
      ...sortedPlaylists().map((p) => tile(`#/playlist/${p.id}`, playlistArt(p), p.name, plural(p.trackIds.length, 'titre'))),
    ].join('');
    const recent = allIds().slice(0, 8);
    return `
      <div class="page">
        <header class="page-head">
          <h1 class="page-title">Ta discothèque</h1>
          <a class="icon-btn only-mobile" href="#/settings" aria-label="Réglages">${icon('sliders')}</a>
        </header>
        <section class="block">
          <h2 class="block-title">Playlists</h2>
          <div class="tiles">${tiles}</div>
        </section>
        <section class="block">
          <div class="block-head"><h2 class="block-title">Ajoutés récemment</h2><a class="link" href="#/all">Tout afficher</a></div>
          ${trackRows('recent', recent, { numbered: false })}
        </section>
      </div>`;
  },

  collection(kind, id) {
    let title, sub, ids, art, key, playlist = null;
    if (kind === 'liked') {
      key = 'liked'; title = 'Titres likés'; ids = likedIds();
      art = `<span class="art liked-art">${icon('heart')}</span>`;
      sub = 'Les titres que tu as aimés';
    } else if (kind === 'all') {
      key = 'all'; title = 'Tous les titres'; ids = allIds();
      art = `<span class="art all-art">${icon('note')}</span>`;
      sub = 'Toute ta bibliothèque, du plus récent au plus ancien';
    } else {
      playlist = lib.playlists.get(id);
      if (!playlist) return notFoundView();
      key = `playlist:${id}`; title = playlist.name;
      ids = playlist.trackIds.filter((t) => lib.tracks.has(t));
      art = playlistArt(playlist);
      sub = playlist.description || { deezer: 'Importée depuis Deezer', spotify: 'Importée depuis Spotify', local: 'Créée à partir de tes fichiers' }[playlist.source] || 'Ta playlist';
    }
    const total = ids.reduce((s, t) => s + (lib.tracks.get(t)?.duration || 0), 0);
    const missing = ids.filter((t) => !isPlayable(lib.tracks.get(t))).length;
    const size = title.length <= 14 ? 'xl' : title.length <= 28 ? 'l' : 'm';
    const coverForTint = playlist ? (playlist.coverUrl || coverSrc(lib.tracks.get(ids[0]))) : null;

    return `
      <div class="collection" data-tint-src="${esc(coverForTint || '')}">
        <header class="hero">
          <div class="hero-cover" data-live-key="${esc(key)}">
            <span class="hero-halo" aria-hidden="true"></span>
            <span class="cover-frame">${art}</span>
          </div>
          <div class="hero-text">
            <h1 class="hero-title size-${size}">${esc(title)}</h1>
            <p class="hero-sub">${esc(sub)}</p>
            <p class="hero-meta">${plural(ids.length, 'titre')}${total ? `, ${fmtTotal(total)}` : ''}${missing ? `<span class="hero-note">${ids.length - missing} sur ${ids.length} disponible${ids.length - missing > 1 ? 's' : ''} en entier</span>` : ''}</p>
          </div>
        </header>
        <div class="toolbar">
          <button class="play-fab" data-action="play-collection" data-key="${esc(key)}" aria-label="Lire">${icon('play')}</button>
          <button class="icon-btn icon-btn-lg" data-action="shuffle-collection" data-key="${esc(key)}" aria-label="Lecture aléatoire">${icon('shuffle')}</button>
          ${playlist?.sourceId?.startsWith('deezer:') ? `<a class="btn btn-ghost toolbar-complete" href="https://www.deezer.com/${playlist.sourceId.split(':')[1]}/${playlist.sourceId.split(':')[2]}" target="_blank" rel="noopener">Écouter sur Deezer</a>` : ''}
          ${playlist ? `
            ${missing && playlist.sourceId
              ? `<button class="btn btn-ghost toolbar-complete" data-action="complete-playlist" data-id="${esc(playlist.id)}">${icon('note')} Compléter avec mes fichiers</button>`
              : `<button class="icon-btn icon-btn-lg" data-action="add-files-to-playlist" data-id="${esc(playlist.id)}" aria-label="Ajouter des fichiers">${icon('plus')}</button>`}
            <button class="icon-btn icon-btn-lg" data-action="playlist-menu" data-id="${esc(playlist.id)}" aria-label="Options de la playlist">${icon('more')}</button>` : ''}
        </div>
        <div class="page page-tracks">
          ${ids.length ? `
            <div class="tracks-head" aria-hidden="true"><span>#</span><span></span><span>Titre</span><span class="row-album">Album</span><span></span><span>${icon('clock')}</span><span></span></div>
            ${trackRows(key, ids, { removable: Boolean(playlist) })}` : emptyCollection(kind, playlist)}
        </div>
      </div>`;
  },

  search() {
    return `
      <div class="page">
        <header class="page-head"><h1 class="page-title">Rechercher</h1></header>
        <label class="search-field">
          ${icon('search')}
          <input class="input input-search" id="search-input" type="search" placeholder="Titre, artiste, album ou playlist" autocomplete="off" enterkeyhint="search">
        </label>
        <div id="search-results" class="search-results"></div>
      </div>`;
  },

  library() {
    const rows = sortedPlaylists().map((p) => `
      <a class="lib-row" href="#/playlist/${p.id}">${playlistArt(p, 'lib-art')}
        <span class="lib-main"><span class="lib-name">${esc(p.name)}</span><span class="lib-sub">${plural(p.trackIds.length, 'titre')}</span></span></a>`).join('');
    return `
      <div class="page">
        <header class="page-head">
          <h1 class="page-title">Bibliothèque</h1>
          <button class="icon-btn" data-action="new-playlist" aria-label="Nouvelle playlist">${icon('plus')}</button>
        </header>
        <nav class="lib-list">
          <a class="lib-row" href="#/liked"><span class="art liked-art lib-art">${icon('heart')}</span><span class="lib-main"><span class="lib-name">Titres likés</span><span class="lib-sub">${plural(likedIds().length, 'titre')}</span></span></a>
          <a class="lib-row" href="#/all"><span class="art all-art lib-art">${icon('note')}</span><span class="lib-main"><span class="lib-name">Tous les titres</span><span class="lib-sub">${plural(lib.tracks.size, 'titre')}</span></span></a>
          ${rows}
        </nav>
      </div>`;
  },

  import() {
    const connected = spotify.isConnected();
    const hasClient = Boolean(spotify.getClientId());
    const me = spotify.profile();
    return `
      <div class="page page-narrow">
        <header class="page-head"><h1 class="page-title">Ajouter de la musique</h1></header>

        <section class="panel" id="drop-zone">
          <h2 class="panel-title">${icon('note')} Tes fichiers audio</h2>
          <p class="panel-text">MP3, M4A, FLAC, WAV ou OGG. Les fichiers sont copiés dans l’app : ils se lisent en entier, sans pub et sans connexion.</p>
          <div class="panel-actions">
            <button class="btn btn-primary" data-action="pick-files">Choisir des fichiers</button>
            <button class="btn btn-ghost folder-only" data-action="pick-folder">${icon('folder')} Importer un dossier</button>
          </div>
          <p class="panel-hint only-desktop">Tu peux aussi glisser tes fichiers n’importe où dans la fenêtre.</p>
        </section>

        <section class="panel">
          <h2 class="panel-title">${icon('link')} Un lien</h2>
          <form class="form" data-form="link">
            <label class="field">
              <span class="field-label">Colle un lien de playlist, d’album ou de profil</span>
              <input class="input" name="link" type="url" inputmode="url" placeholder="https://www.deezer.com/fr/playlist/…" required autocomplete="off">
            </label>
            <button class="btn btn-primary">Importer le lien</button>
          </form>
          <ul class="hint-list">
            <li><strong>Deezer</strong> : playlist, album ou profil public (toutes ses playlists), sans connexion.</li>
            <li><strong>Spotify</strong> : tes propres playlists, après connexion ci-dessous.</li>
            <li><strong>Lien direct</strong> vers un fichier audio (.mp3, .m4a…) hébergé en ligne.</li>
          </ul>
        </section>

        <section class="panel">
          <h2 class="panel-title">${icon('user')} Compte Spotify</h2>
          ${connected ? `
            <p class="panel-text">Connecté en tant que <strong>${esc(me?.name || '')}</strong>${me?.premium ? '' : ' (compte gratuit : la lecture complète demande Premium)'}.</p>
            <div class="panel-actions">
              <button class="btn btn-primary" data-action="spotify-pick">Choisir mes playlists</button>
              <button class="btn btn-ghost" data-action="spotify-liked">Importer mes titres likés</button>
            </div>` : `
            <p class="panel-text">Importe toutes tes playlists en un clic. Spotify demande une petite configuration unique.</p>
            <div class="panel-actions">
              ${hasClient ? '<button class="btn btn-primary" data-action="spotify-login">Se connecter à Spotify</button>' : ''}
              <a class="btn ${hasClient ? 'btn-ghost' : 'btn-primary'}" href="#/settings">Configurer Spotify</a>
            </div>`}
        </section>

        <section class="panel panel-quiet">
          <h2 class="panel-title">Écouter en entier, sans pub</h2>
          <p class="panel-text">Deezer et Spotify ne laissent aucune autre app diffuser gratuitement leurs morceaux. Un titre importé se lit en entier grâce à :</p>
          <ol class="steps">
            <li><strong>Ton fichier audio</strong>, s’il a le même titre et le même artiste. Sur une playlist importée, utilise « Compléter avec mes fichiers ».</li>
            <li><strong>Spotify Premium</strong>, dans le navigateur sur ordinateur ou via l’app Spotify sur téléphone.</li>
          </ol>
          <p class="panel-hint">Les titres sans l’une de ces sources apparaissent en grisé et sont passés pendant la lecture.</p>
        </section>
      </div>`;
  },

  settings() {
    const me = spotify.profile();
    const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    return `
      <div class="page page-narrow">
        <header class="page-head"><h1 class="page-title">Réglages</h1></header>

        ${accountPanel()}

        <section class="panel">
          <h2 class="panel-title">${icon('phone')} Installer l’app</h2>
          ${standalone ? '<p class="panel-text">Sillon est installée sur cet appareil.</p>'
            : ios ? `<ol class="steps"><li>Ouvre ce site dans <strong>Safari</strong>.</li><li>Touche le bouton <strong>Partager</strong>.</li><li>Choisis <strong>Sur l’écran d’accueil</strong>.</li></ol>`
            : `<p class="panel-text">Ajoute Sillon à ton écran d’accueil ou à ton ordinateur pour l’ouvrir comme une app, en plein écran.</p>
               <div class="panel-actions"><button class="btn btn-primary install-btn" data-action="install">Installer Sillon</button></div>
               <p class="panel-hint install-fallback">Si le bouton n’apparaît pas : menu du navigateur, puis « Installer l’application » ou « Ajouter à l’écran d’accueil ».</p>`}
        </section>

        <section class="panel">
          <h2 class="panel-title">${icon('play')} Lecture</h2>
          <label class="field">
            <span class="field-label">Fondu enchaîné entre les titres : <strong data-crossfade-label>${crossfadeLabel(prefs.get('crossfade', 5))}</strong></span>
            <input class="range range-setting" type="range" min="0" max="12" step="1" value="${prefs.get('crossfade', 5)}" data-crossfade style="--p:${(prefs.get('crossfade', 5) / 12) * 100}%" ${player.canFade ? '' : 'disabled'}>
          </label>
          <p class="panel-hint">${player.canFade
            ? 'Le titre suivant commence avant la fin du précédent, le volume passe progressivement de l’un à l’autre.'
            : 'Le navigateur de cet appareil ne permet pas de régler le volume (iPhone) : les titres s’enchaînent directement, sans fondu.'}</p>
        </section>

        <section class="panel">
          <h2 class="panel-title">${icon('user')} Spotify</h2>
          ${spotify.isConnected() ? `
            <p class="panel-text">Connecté en tant que <strong>${esc(me?.name || '')}</strong>.</p>
            <label class="switch">
              <input type="checkbox" data-pref="spotifyPlayback" ${prefs.get('spotifyPlayback', true) ? 'checked' : ''} ${me?.premium ? '' : 'disabled'}>
              <span class="switch-track" aria-hidden="true"></span>
              <span>Lire les titres en entier via Spotify${me?.premium ? '' : ' (Premium requis)'}${spotify.sdkSupported() ? '' : ', le son sort de l’app Spotify de ce téléphone'}</span>
            </label>
            <div class="panel-actions"><button class="btn btn-ghost" data-action="spotify-logout">Se déconnecter</button></div>` : `
            <ol class="steps">
              <li>Va sur <a class="link" href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener">developer.spotify.com/dashboard</a> et crée une app (nom et description au choix, coche « Web API » et « Web Playback SDK »).</li>
              <li>Dans « Redirect URIs », ajoute exactement cette adresse :
                <span class="copy-line"><code id="redirect-uri">${esc(spotify.redirectUri())}</code><button class="btn btn-small" data-action="copy-redirect">Copier</button></span>
              </li>
              <li>Copie le « Client ID » de l’app et colle-le ici.</li>
            </ol>
            <form class="form form-inline" data-form="client-id">
              <label class="field"><span class="field-label">Client ID</span>
                <input class="input" name="clientId" value="${esc(spotify.getClientId())}" required pattern="[A-Za-z0-9]{20,64}" autocomplete="off" spellcheck="false"></label>
              <button class="btn btn-primary">Enregistrer et se connecter</button>
            </form>
            <p class="panel-hint">Depuis 2026, Spotify réserve ces apps personnelles aux comptes Premium. L’adresse doit être en https (ou http://127.0.0.1 en local).</p>`}
        </section>

        <section class="panel">
          <h2 class="panel-title">${icon('disk')} Stockage</h2>
          <p class="panel-text" id="storage-info">Calcul de l’espace utilisé…</p>
          <div class="panel-actions"><button class="btn btn-danger-ghost" data-action="wipe">Tout effacer</button></div>
        </section>
      </div>`;
  },
};

function crossfadeLabel(seconds) {
  return Number(seconds) ? `${seconds} s` : 'désactivé';
}

function accountPanel() {
  const title = `<h2 class="panel-title">${icon('user')} Compte</h2>`;
  if (!cloud.isConfigured()) {
    return `<section class="panel">${title}
      <p class="panel-text">Les comptes ne sont pas encore activés sur ce site. Suis la partie « Comptes » du fichier README pour relier Sillon à Supabase.</p></section>`;
  }
  if (!cloud.isReady()) {
    return `<section class="panel">${title}<p class="panel-text">${navigator.onLine ? 'Connexion au service de comptes…' : 'Connecte-toi à internet pour accéder à ton compte.'}</p></section>`;
  }
  const u = cloud.currentUser();
  if (u) {
    return `<section class="panel">${title}
      <p class="panel-text">Connecté avec <strong>${esc(u.email)}</strong>. Tes playlists, titres likés et fichiers audio sont sauvegardés dans ton compte : connecte-toi sur un autre appareil pour les retrouver.</p>
      <p class="sync-line" data-sync-status>${esc(syncText())}</p>
      <div class="panel-actions">
        <button class="btn btn-primary" data-action="sync-now">Synchroniser maintenant</button>
        <button class="btn btn-ghost" data-action="sign-out">Se déconnecter</button>
      </div></section>`;
  }
  return `<section class="panel">${title}
    <p class="panel-text">Crée un compte pour sauvegarder tes musiques et les retrouver sur tous tes appareils.</p>
    <form class="form" data-form="auth">
      <label class="field"><span class="field-label">E-mail</span>
        <input class="input" name="email" type="email" autocomplete="email" inputmode="email" required></label>
      <label class="field"><span class="field-label">Mot de passe (6 caractères minimum)</span>
        <input class="input" name="password" type="password" autocomplete="current-password" minlength="6" required></label>
      <div class="panel-actions">
        <button class="btn btn-primary" name="mode" value="signin">Se connecter</button>
        <button class="btn btn-ghost" name="mode" value="signup">Créer un compte</button>
      </div>
      <button type="button" class="link auth-forgot" data-action="forgot-password">Mot de passe oublié ?</button>
    </form></section>`;
}

function onboardingView() {
  return `
    <div class="page onboarding">
      <div class="onboarding-mark" aria-hidden="true"><span class="brand-mark brand-mark-big"></span></div>
      <h1 class="onboarding-title">Ta musique, sans pub, dans ta poche.</h1>
      <p class="onboarding-text">${cloud.isConfigured() ? 'Ajoute tes morceaux, ou connecte-toi pour retrouver ta bibliothèque.' : 'Commence par ajouter des morceaux. Tout reste sur cet appareil.'}</p>
      <div class="onboarding-actions">
        <button class="choice" data-action="pick-files">${icon('note')}<span><strong>Mes fichiers audio</strong><small>MP3, FLAC, M4A… lus en entier</small></span></button>
        <a class="choice" href="#/import">${icon('link')}<span><strong>Un lien Deezer ou Spotify</strong><small>Playlist, album ou profil</small></span></a>
        ${cloud.isConfigured() ? `<a class="choice" href="#/settings">${icon('user')}<span><strong>J’ai déjà un compte</strong><small>Retrouver mes musiques sur cet appareil</small></span></a>` : ''}
      </div>
      <a class="link onboarding-settings" href="#/settings">Installer l’app sur ce téléphone</a>
    </div>`;
}

function emptyCollection(kind, playlist) {
  if (kind === 'liked') return '<div class="empty"><p>Touche le cœur d’un titre pour le retrouver ici.</p></div>';
  if (playlist) {
    return `<div class="empty"><p>Cette playlist est vide.</p>
      <button class="btn btn-primary" data-action="add-files-to-playlist" data-id="${esc(playlist.id)}">Ajouter des fichiers</button></div>`;
  }
  return '<div class="empty"><p>Aucun titre pour l’instant.</p><a class="btn btn-primary" href="#/import">Ajouter de la musique</a></div>';
}

function notFoundView() {
  return '<div class="page empty"><p>Cette playlist n’existe plus.</p><a class="btn btn-primary" href="#/">Retour à l’accueil</a></div>';
}

/* ================= Recherche ================= */
function runSearch(q) {
  const out = $('#search-results');
  if (!out) return;
  const query = norm(q);
  if (!query) {
    out.innerHTML = lib.tracks.size ? '' : '<div class="empty"><p>Ta bibliothèque est vide.</p><a class="btn btn-primary" href="#/import">Ajouter de la musique</a></div>';
    return;
  }
  const words = query.split(' ');
  const hit = (s) => { const n = norm(s); return words.every((w) => n.includes(w)); };
  const tracks = [...lib.tracks.values()].filter((t) => hit(`${t.title} ${t.artist} ${t.album}`)).slice(0, 100).map((t) => t.id);
  const pls = sortedPlaylists().filter((p) => hit(p.name)).slice(0, 12);
  out.innerHTML = `
    ${pls.length ? `<section class="block"><h2 class="block-title">Playlists</h2><div class="tiles">${pls.map((p) => tile(`#/playlist/${p.id}`, playlistArt(p), p.name, plural(p.trackIds.length, 'titre'))).join('')}</div></section>` : ''}
    ${tracks.length ? `<section class="block"><h2 class="block-title">Titres</h2>${trackRows('search', tracks, { numbered: false })}</section>` : ''}
    ${!pls.length && !tracks.length ? `<div class="empty"><p>Rien ne correspond à « ${esc(q)} ».</p></div>` : ''}`;
}

/* ================= Routeur ================= */
const main = $('#main');

function currentRoute() {
  const [name = '', id] = location.hash.replace(/^#\/?/, '').split('/');
  return { name, id: id && decodeURIComponent(id) };
}

function render({ keepScroll = false } = {}) {
  const { name, id } = currentRoute();
  const scroll = main.scrollTop;
  let html;
  if (name === 'playlist') html = views.collection('playlist', id);
  else if (name === 'liked' || name === 'all') html = views.collection(name);
  else if (views[name]) html = views[name]();
  else html = views.home();
  const searchValue = $('#search-input')?.value;
  main.innerHTML = html;
  main.scrollTop = keepScroll ? scroll : 0;

  $$('[data-nav]').forEach((a) => {
    const target = a.dataset.nav;
    const active = target === (name || 'home') || (target === 'library' && ['playlist', 'liked', 'all'].includes(name) && a.closest('.tabbar'));
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  $$('.side-list a').forEach((a) => a.classList.toggle('is-active', a.getAttribute('href') === location.hash));

  if (name === 'search') {
    const input = $('#search-input');
    if (searchValue) input.value = searchValue;
    runSearch(input.value);
    if (!keepScroll && matchMedia('(hover: hover)').matches) input.focus();
  }
  if (name === 'settings') updateStorageInfo();

  const tint = $('[data-tint-src]');
  if (tint?.dataset.tintSrc) {
    const known = colorValues.get(tint.dataset.tintSrc);
    if (known) tint.style.setProperty('--tint', known);
    else ambientColor(tint.dataset.tintSrc).then((c) => { if (c && main.contains(tint)) tint.style.setProperty('--tint', c); });
  }
  syncPlayingState();
  renderSidebar();
}

// Transition douce entre les pages (navigateurs compatibles)
window.addEventListener('hashchange', () => {
  if (!document.startViewTransition || REDUCED_MOTION.matches || document.hidden) return render();
  document.startViewTransition(() => render());
});

function renderSidebar() {
  const pls = sortedPlaylists();
  $('#side-list').innerHTML = `
    <a href="#/liked" class="side-item"><span class="art liked-art side-art">${icon('heart')}</span><span class="side-name">Titres likés</span></a>
    <a href="#/all" class="side-item"><span class="art all-art side-art">${icon('note')}</span><span class="side-name">Tous les titres</span></a>
    ${pls.map((p) => `<a href="#/playlist/${p.id}" class="side-item" data-live-key="playlist:${esc(p.id)}">${playlistArt(p, 'side-art')}<span class="side-name">${esc(p.name)}</span><span class="side-eq eq" aria-hidden="true"><i></i><i></i><i></i></span></a>`).join('')}`;
  $$('#side-list a').forEach((a) => a.classList.toggle('is-active', a.getAttribute('href') === location.hash));
  syncPlayingState();
}

/* ================= Interface du lecteur ================= */
const ui = {
  bar: $('#playerbar'),
  np: $('#np'),
};

function syncPlayingState() {
  const cur = player.current?.id;
  $$('.row[data-id]').forEach((r) => r.classList.toggle('is-current', r.dataset.id === cur));
  document.body.classList.toggle('is-playing', player.playing);
  const ctx = player.context?.key;
  $$('[data-live-key]').forEach((el) => el.classList.toggle('is-live', el.dataset.liveKey === ctx && Boolean(cur)));
}

let lastTrackId = null;
function renderPlayer() {
  const t = player.current;
  document.body.classList.toggle('has-track', Boolean(t));
  syncPlayingState();
  const playIcon = player.playing ? 'pause' : 'play';
  $$('[data-action="toggle"]').forEach((b) => {
    if (b.dataset.icon === playIcon) return;
    const changed = Boolean(b.dataset.icon);
    b.dataset.icon = playIcon;
    b.innerHTML = icon(playIcon);
    b.setAttribute('aria-label', player.playing ? 'Pause' : 'Lecture');
    if (changed && !REDUCED_MOTION.matches) b.firstElementChild.animate([{ transform: 'scale(0.6)', opacity: 0.4 }, { transform: 'none', opacity: 1 }], { duration: 220, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' });
  });
  $$('[data-action="shuffle"]').forEach((b) => { b.classList.toggle('is-on', player.shuffle); b.setAttribute('aria-pressed', player.shuffle); });
  $$('[data-action="repeat"]').forEach((b) => {
    b.classList.toggle('is-on', player.repeat !== 'off');
    const name = player.repeat === 'one' ? 'repeat-one' : 'repeat';
    if (b.dataset.icon !== name) { b.dataset.icon = name; b.innerHTML = icon(name); }
    b.setAttribute('aria-label', { off: 'Répéter', all: 'Répéter la liste', one: 'Répéter le titre' }[player.repeat]);
  });
  if (!t) return;

  const src = coverSrc(t);
  const isNewTrack = t.id !== lastTrackId;
  const animateText = isNewTrack && lastTrackId !== null && !REDUCED_MOTION.matches;
  $$('[data-np="title"]').forEach((el) => swapText(el, t.title || 'Sans titre', animateText));
  $$('[data-np="artist"]').forEach((el) => swapText(el, t.artist || 'Artiste inconnu', animateText));
  $$('[data-np="context"]').forEach((el) => { el.textContent = player.context?.name || ''; });
  $$('[data-np="mode"]').forEach((el) => {
    const label = { spotify: 'Lecture via Spotify', connect: `Lecture sur ${player.deviceName || 'l’app Spotify'}` }[player.mode] || '';
    el.textContent = label;
    el.hidden = !label;
  });
  $$('[data-np="like"]').forEach((b) => {
    b.dataset.like = t.id;
    b.classList.toggle('is-on', Boolean(t.liked));
    b.setAttribute('aria-pressed', Boolean(t.liked));
  });
  if (isNewTrack) {
    const first = lastTrackId === null;
    lastTrackId = t.id;
    $$('[data-np="art"]').forEach((el) => swapLayer(el, artHtml(src, `Pochette de ${t.album || t.title}`), first ? 0 : player.direction));
    $$('[data-np="backdrop"]').forEach((el) => swapLayer(el, src ? `<span class="np-backdrop-image" style="background-image:url('${esc(src)}')"></span>` : '', 0));
    document.title = `${t.title} · ${t.artist || 'Sillon'}`;
    ambientColor(src).then((c) => {
      if (player.current?.id !== t.id) return;
      document.documentElement.style.setProperty('--ambient', c || 'hsl(262 90% 62%)');
    });
  }
  if (!ui.np.hidden) renderQueue();
  renderTime();
  startProgressLoop();
}

const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)');

// Change un texte en douceur (glisse vers le haut)
function swapText(el, text, animate) {
  if (el.textContent === text) return;
  el.textContent = text;
  if (animate && el.offsetParent) {
    el.animate([{ opacity: 0, transform: 'translateY(0.45em)' }, { opacity: 1, transform: 'none' }], { duration: 380, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' });
  }
}

// Superpose le nouveau contenu (pochette, fond) et fait disparaître l'ancien en fondu
function swapLayer(container, html, direction) {
  const layer = document.createElement('span');
  layer.className = 'swap-layer';
  layer.innerHTML = html;
  const previous = [...container.children];
  const animate = previous.length && !REDUCED_MOTION.matches && container.offsetParent;
  if (!animate) {
    container.replaceChildren(layer);
    return;
  }
  layer.classList.add('is-entering');
  layer.style.setProperty('--dir', direction);
  container.appendChild(layer);
  const img = layer.querySelector('img');
  const ready = img && !img.complete ? Promise.race([img.decode().catch(() => {}), new Promise((r) => setTimeout(r, 450))]) : Promise.resolve();
  ready.then(() => requestAnimationFrame(() => {
    layer.classList.remove('is-entering');
    previous.forEach((old) => {
      old.style.setProperty('--dir', direction);
      old.classList.add('is-leaving');
      setTimeout(() => old.remove(), 600);
    });
  }));
}

// Barre de progression fluide : mise à jour à chaque image pendant la lecture
let progressFrame = 0;
function progressLoop() {
  progressFrame = 0;
  if (!player.playing || document.hidden) return;
  renderTime();
  progressFrame = requestAnimationFrame(progressLoop);
}
function startProgressLoop() {
  if (!progressFrame && player.playing && !document.hidden) progressFrame = requestAnimationFrame(progressLoop);
}
document.addEventListener('visibilitychange', startProgressLoop);

let seeking = false;
function renderTime() {
  const d = player.duration;
  const p = Math.min(player.position, d || Infinity);
  const ratio = d ? p / d : 0;
  $$('[data-np="seek"]').forEach((input) => {
    if (seeking && document.activeElement === input) return;
    input.value = Math.round(ratio * 1000);
    input.style.setProperty('--p', `${ratio * 100}%`);
  });
  $$('[data-np="progress"]').forEach((el) => el.style.setProperty('--p', `${ratio * 100}%`));
  const elapsed = fmt(p);
  const total = fmt(d);
  if (!seeking) $$('[data-np="elapsed"]').forEach((el) => { if (el.textContent !== elapsed) el.textContent = elapsed; });
  $$('[data-np="duration"]').forEach((el) => { if (el.textContent !== total) el.textContent = total; });
}

let timeFrame = 0;
player.addEventListener('change', renderPlayer);
player.addEventListener('time', () => {
  if (timeFrame || progressFrame) return;
  timeFrame = requestAnimationFrame(() => { timeFrame = 0; renderTime(); });
});
player.addEventListener('error', (e) => toast(e.detail.message, { error: true, timeout: 7000 }));
player.addEventListener('blocked', () => toast('Touche le bouton lecture pour lancer le son.', { timeout: 5000 }));
// Débloque le son dès le premier toucher (exigence de Safari sur iPhone)
// (seuls ces événements comptent comme un vrai geste pour autoriser le son)
['touchend', 'click', 'keydown'].forEach((type) => document.addEventListener(type, () => player.unlock(), { capture: true, passive: true }));
player.addEventListener('loading', (e) => document.body.classList.toggle('is-loading', e.detail.loading));
player.addEventListener('volume', renderVolume);

function renderVolume() {
  const v = player.volume;
  $$('[data-np="volume"]').forEach((i) => { i.value = Math.round(v * 100); i.style.setProperty('--p', `${v * 100}%`); });
  $$('[data-action="mute"]').forEach((b) => { b.innerHTML = icon(v === 0 ? 'mute' : 'volume'); });
}

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.np === 'seek') {
    seeking = true;
    const ratio = el.value / 1000;
    el.style.setProperty('--p', `${ratio * 100}%`);
    $$('[data-np="elapsed"]').forEach((x) => { x.textContent = fmt(ratio * player.duration); });
  } else if (el.dataset.np === 'volume') {
    player.setVolume(el.value / 100);
  } else if (el.dataset.crossfade !== undefined) {
    const value = Number(el.value);
    prefs.set('crossfade', value);
    el.style.setProperty('--p', `${(value / 12) * 100}%`);
    $$('[data-crossfade-label]').forEach((x) => { x.textContent = crossfadeLabel(value); });
  } else if (el.id === 'search-input') {
    runSearch(el.value);
  }
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.np === 'seek') {
    seeking = false;
    player.seek((el.value / 1000) * player.duration);
  } else if (el.dataset.pref) {
    prefs.set(el.dataset.pref, el.checked);
    render({ keepScroll: true });
  }
});

let lastInputWasKeyboard = false;
document.addEventListener('keydown', () => { lastInputWasKeyboard = true; }, true);
document.addEventListener('pointerdown', () => { lastInputWasKeyboard = false; }, true);

function openNowPlaying() {
  if (!player.current) return;
  ui.np.hidden = false;
  ui.np.style.transform = '';
  requestAnimationFrame(() => requestAnimationFrame(() => ui.np.classList.add('is-open')));
  document.body.classList.add('np-open');
  renderQueue();
  if (lastInputWasKeyboard) $('[data-action="np-close"]', ui.np).focus({ preventScroll: true });
}

function closeNowPlaying() {
  ui.np.classList.remove('is-open', 'is-dragging');
  ui.np.style.transform = '';
  document.body.classList.remove('np-open');
  setTimeout(() => { if (!ui.np.classList.contains('is-open')) ui.np.hidden = true; }, 420);
}

// Gestes sur téléphone : glisser la pochette pour changer de titre, tirer vers le bas pour fermer
(function setupNowPlayingGestures() {
  const stage = $('.np-stage', ui.np);
  const cover = $('.np-cover', ui.np);
  let start = null;

  ui.np.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || e.target.closest('button, input, a, .queue-list')) return;
    start = { x: e.clientX, y: e.clientY, t: performance.now(), axis: null, onCover: stage.contains(e.target) };
  });

  ui.np.addEventListener('pointermove', (e) => {
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (!start.axis) {
      if (Math.hypot(dx, dy) < 10) return;
      start.axis = Math.abs(dx) > Math.abs(dy) && start.onCover ? 'x' : dy > 0 ? 'y' : 'none';
      if (start.axis === 'x') cover.classList.add('is-dragging');
      if (start.axis === 'y') ui.np.classList.add('is-dragging');
    }
    if (start.axis === 'x') {
      cover.style.transform = `translateX(${dx}px) rotate(${dx / 40}deg)`;
      cover.style.opacity = String(Math.max(0.35, 1 - Math.abs(dx) / 500));
    } else if (start.axis === 'y') {
      ui.np.style.transform = `translateY(${Math.max(0, dy)}px)`;
    }
  });

  const end = (e) => {
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    const fast = performance.now() - start.t < 260;
    const { axis } = start;
    start = null;
    if (axis === 'x') {
      cover.classList.remove('is-dragging');
      cover.style.transform = '';
      cover.style.opacity = '';
      if (Math.abs(dx) > 90 || (fast && Math.abs(dx) > 40)) {
        if (dx < 0) player.next();
        else player.prev();
      }
    } else if (axis === 'y') {
      ui.np.classList.remove('is-dragging');
      if (dy > 140 || (fast && dy > 60)) closeNowPlaying();
      else ui.np.style.transform = '';
    }
  };
  ui.np.addEventListener('pointerup', end);
  ui.np.addEventListener('pointercancel', end);
})();

function renderQueue() {
  const list = $('#np-queue-list');
  const ids = player.upcoming.filter((id) => lib.tracks.has(id) && isPlayable(lib.tracks.get(id))).slice(0, 60);
  list.innerHTML = ids.length
    ? ids.map((id, i) => {
      const t = lib.tracks.get(id);
      if (!t) return '';
      return `<li><button class="queue-item" data-action="queue-jump" data-offset="${player.upcoming.indexOf(id)}">${artHtml(coverSrc(t), '', 'queue-art')}<span class="row-main"><span class="row-title">${esc(t.title)}</span><span class="row-sub">${esc(t.artist || '')}</span></span></button></li>`;
    }).join('')
    : '<li class="queue-empty">Rien après ce titre.</li>';
}

/* ================= Actions ================= */
const fileInput = $('#file-input');
const folderInput = $('#folder-input');
const attachInput = $('#attach-input');
let pendingPlaylistId = null;
let pendingAttachId = null;

const actions = {
  'sheet-close': closeSheet,
  'sync-now': () => cloud.run(),
  'sign-out': async () => {
    try { await cloud.signOut(); } catch (err) { toast(err.message, { error: true }); }
  },
  'forgot-password': async (el) => {
    const email = el.closest('form')?.email.value.trim();
    if (!email) return toast('Saisis d’abord ton adresse e-mail.');
    try {
      await cloud.resetPassword(email);
      toast(`Si un compte existe pour ${email}, un e-mail vient d’être envoyé pour choisir un nouveau mot de passe.`, { timeout: 9000 });
    } catch (err) { toast(err.message, { error: true }); }
  },
  toggle: () => player.toggle(),
  next: () => player.next(),
  prev: () => player.prev(),
  shuffle: () => player.toggleShuffle(),
  repeat: () => player.cycleRepeat(),
  mute: () => {
    if (player.volume > 0) { player.lastVolume = player.volume; player.setVolume(0); } else player.setVolume(player.lastVolume || 0.8);
  },
  'np-open': openNowPlaying,
  'np-close': closeNowPlaying,
  'np-queue': () => ui.np.classList.toggle('show-queue'),
  'queue-jump': (el) => player.jumpTo(Number(el.dataset.offset)),
  'play-collection': (el) => playCollection(el.dataset.key),
  'shuffle-collection': (el) => playCollection(el.dataset.key, true),
  like: (el) => toggleLike(el.dataset.like),
  'pick-files': () => { pendingPlaylistId = null; fileInput.click(); },
  'pick-folder': () => folderInput.click(),
  'add-files-to-playlist': (el) => { pendingPlaylistId = el.dataset.id; fileInput.click(); },
  'complete-playlist': (el) => completePlaylistFlow(el.dataset.id),
  'new-playlist': () => createPlaylistFlow(),
  'track-menu': (el) => trackMenu(el.closest('.row').dataset.id, el.dataset.removable === 'true', el.closest('[data-list]')?.dataset.list),
  'playlist-menu': (el) => playlistMenu(el.dataset.id),
  'spotify-login': () => spotifyLogin(),
  'spotify-logout': () => { spotify.disconnect(); toast('Déconnecté de Spotify.'); render({ keepScroll: true }); },
  'spotify-pick': () => spotifyPicker(),
  'spotify-liked': () => runImport(async () => saveImportedPlaylist(await spotify.likedTracks(), 'spotify')),
  'copy-redirect': async () => {
    try { await navigator.clipboard.writeText(spotify.redirectUri()); toast('Adresse copiée.'); } catch { toast('Sélectionne l’adresse et copie-la manuellement.'); }
  },
  install: async () => {
    if (!installPrompt) return toast('Utilise le menu du navigateur : « Installer l’application ».');
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    installPrompt = null;
    document.body.classList.remove('can-install');
    if (outcome === 'accepted') toast('Sillon est installée.');
  },
  wipe: () => confirmSheet(
    cloud.currentUser() ? 'Effacer cet appareil ?' : 'Tout effacer ?',
    cloud.currentUser()
      ? 'Tes musiques et playlists seront supprimées de cet appareil uniquement. Elles restent dans ton compte et reviendront à la prochaine synchronisation.'
      : 'Tes fichiers importés, playlists et titres likés seront supprimés de cet appareil. Cette action est définitive.',
    'Effacer', async () => {
    player.stopAudio();
    cloud.forgetDevice();
    await Promise.all(['tracks', 'playlists', 'files', 'covers'].map((s) => db.clear(s)));
    lib.tracks.clear(); lib.playlists.clear(); lib.covers.clear(); reindex();
    location.hash = '#/';
    location.reload();
  }),
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (el) {
    const fn = sheetActions[el.dataset.action] || actions[el.dataset.action];
    if (fn) {
      e.preventDefault();
      fn(el, e);
    }
    return;
  }
  const row = e.target.closest('.row[data-id]');
  if (row && !e.target.closest('a')) playFrom(row.closest('[data-list]').dataset.list, row.dataset.id);
  const bar = e.target.closest('[data-open-np]');
  if (bar && !e.target.closest('button, input, a') && matchMedia('(max-width: 760px)').matches) openNowPlaying();
});

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select, [contenteditable]')) return;
  if (e.key === ' ' && !e.target.closest('button, a')) { e.preventDefault(); player.toggle(); }
  else if (e.key === 'Escape' && !ui.np.hidden) closeNowPlaying();
  else if (e.key === 'ArrowRight' && e.shiftKey) player.next();
  else if (e.key === 'ArrowLeft' && e.shiftKey) player.prev();
});

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('[data-form]');
  if (!form || form.dataset.form === 'prompt') return;
  e.preventDefault();
  const data = new FormData(form);
  if (form.dataset.form === 'link') {
    const ok = await runImport(() => importLink(data.get('link')));
    if (ok) form.reset();
  } else if (form.dataset.form === 'auth') {
    const mode = e.submitter?.value || 'signin';
    const email = String(data.get('email')).trim();
    const password = String(data.get('password'));
    const buttons = $$('button', form);
    buttons.forEach((b) => { b.disabled = true; });
    try {
      if (mode === 'signup') {
        const { needsConfirmation } = await cloud.signUp(email, password);
        if (needsConfirmation) toast(`Compte créé. Ouvre le lien envoyé à ${email} pour l’activer, puis connecte-toi ici.`, { timeout: 12000 });
      } else {
        await cloud.signIn(email, password);
      }
    } catch (err) {
      toast(err.message, { error: true, timeout: 7000 });
    } finally {
      buttons.forEach((b) => { b.disabled = false; });
    }
  } else if (form.dataset.form === 'client-id') {
    spotify.setClientId(data.get('clientId'));
    spotifyLogin();
  }
});

async function toggleLike(id) {
  const t = lib.tracks.get(id);
  if (!t) return;
  const next = { ...t, liked: t.liked ? 0 : Date.now() };
  await saveTrack(next);
  $$(`[data-like="${CSS.escape(id)}"]`).forEach((b) => {
    b.classList.toggle('is-on', Boolean(next.liked));
    b.setAttribute('aria-pressed', Boolean(next.liked));
  });
  if (currentRoute().name === 'liked') render({ keepScroll: true });
}

function trackMenu(id, removable, listKey) {
  const t = lib.tracks.get(id);
  if (!t) return;
  const playlistId = listKey?.startsWith('playlist:') ? listKey.slice(9) : null;
  const hasFile = Boolean(localFileFor(t));
  openSheet(t.title || 'Titre', `
    <div class="sheet-track">${artHtml(coverSrc(t), '', 'sheet-art')}<span class="row-main"><span class="row-title">${esc(t.title)}</span><span class="row-sub">${esc(t.artist || '')}${t.album ? `, ${esc(t.album)}` : ''}</span></span></div>
    <div class="menu">
      <button class="menu-item" data-action="m-next">${icon('queue')} Lire ensuite</button>
      <button class="menu-item" data-action="m-queue">${icon('queue')} Ajouter à la file d’attente</button>
      <button class="menu-item" data-action="m-add">${icon('plus')} Ajouter à une playlist</button>
      ${t.source !== 'local' ? `<button class="menu-item" data-action="m-attach">${icon('note')} ${hasFile ? 'Remplacer le fichier associé' : 'Associer mon fichier audio'}</button>` : ''}
      ${t.link ? `<a class="menu-item" href="${esc(t.link)}" target="_blank" rel="noopener">${icon('link')} Ouvrir sur ${t.source === 'spotify' ? 'Spotify' : 'Deezer'}</a>` : ''}
      ${removable && playlistId ? `<button class="menu-item" data-action="m-remove">${icon('minus')} Retirer de cette playlist</button>` : ''}
      <button class="menu-item is-danger" data-action="m-delete">${icon('trash')} Supprimer de la bibliothèque</button>
    </div>`, {
    'm-next': () => { closeSheet(); player.playNext(id); toast('Sera lu ensuite.'); },
    'm-queue': () => { closeSheet(); player.addToQueue(id); toast('Ajouté à la file d’attente.'); },
    'm-add': () => addToPlaylistSheet([id]),
    'm-attach': () => { closeSheet(); pendingAttachId = id; attachInput.click(); },
    'm-remove': async () => {
      closeSheet();
      const p = lib.playlists.get(playlistId);
      await savePlaylist({ ...p, trackIds: p.trackIds.filter((x) => x !== id) });
      toast(`Retiré de « ${p.name} ».`);
      render({ keepScroll: true });
    },
    'm-delete': () => confirmSheet('Supprimer ce titre ?', `« ${t.title} » sera retiré de toutes tes playlists${t.fileKey ? ' et son fichier supprimé de l’appareil' : ''}.`, 'Supprimer', async () => {
      await deleteTracks([id]);
      toast('Titre supprimé.');
      render({ keepScroll: true });
    }),
  });
}

async function deleteTracks(ids) {
  const set = new Set(ids);
  for (const p of lib.playlists.values()) {
    if (p.trackIds.some((x) => set.has(x))) await savePlaylist({ ...p, trackIds: p.trackIds.filter((x) => !set.has(x)) });
  }
  const fileKeys = ids.map((id) => lib.tracks.get(id)?.fileKey).filter(Boolean);
  const cloudKeys = ids.map((id) => lib.tracks.get(id)).filter((t) => t?.cloudFile).map((t) => t.fileKey);
  await db.deleteMany('files', fileKeys);
  await db.deleteMany('tracks', ids);
  ids.forEach((id) => { lib.tracks.delete(id); cloud.touch('track', id); });
  cloud.removeAudio(cloudKeys);
  reindex();
}

function addToPlaylistSheet(ids) {
  const pls = sortedPlaylists().filter((p) => p.source !== 'spotify' && p.source !== 'deezer').concat(sortedPlaylists().filter((p) => p.source === 'spotify' || p.source === 'deezer'));
  openSheet('Ajouter à une playlist', `
    <div class="menu">
      <button class="menu-item" data-action="p-new">${icon('plus')} Nouvelle playlist</button>
      ${pls.map((p) => `<button class="menu-item" data-action="p-pick" data-id="${esc(p.id)}">${playlistArt(p, 'menu-art')} ${esc(p.name)}</button>`).join('')}
    </div>`, {
    'p-new': () => createPlaylistFlow(ids),
    'p-pick': async (el) => {
      closeSheet();
      const p = lib.playlists.get(el.dataset.id);
      const fresh = ids.filter((x) => !p.trackIds.includes(x));
      await savePlaylist({ ...p, trackIds: [...p.trackIds, ...fresh] });
      toast(fresh.length ? `Ajouté à « ${p.name} ».` : `Déjà dans « ${p.name} ».`);
      render({ keepScroll: true });
    },
  });
}

function createPlaylistFlow(ids = []) {
  promptSheet('Nouvelle playlist', 'Nom', '', 'Créer', async (name) => {
    const p = { id: uid('p'), name, description: '', source: 'local', trackIds: ids, createdAt: Date.now() };
    await savePlaylist(p);
    toast(`Playlist « ${name} » créée.`);
    location.hash = `#/playlist/${p.id}`;
  });
}

function playlistMenu(id) {
  const p = lib.playlists.get(id);
  if (!p) return;
  const origin = p.sourceId?.split(':')[0];
  openSheet(p.name, `
    <div class="menu">
      <button class="menu-item" data-action="pm-rename">${icon('pencil')} Renommer</button>
      ${origin ? `<button class="menu-item" data-action="pm-sync">${icon('refresh')} Mettre à jour depuis ${origin === 'spotify' ? 'Spotify' : 'Deezer'}</button>` : ''}
      <button class="menu-item" data-action="pm-queue">${icon('queue')} Ajouter à la file d’attente</button>
      <button class="menu-item is-danger" data-action="pm-delete">${icon('trash')} Supprimer la playlist</button>
    </div>`, {
    'pm-rename': () => promptSheet('Renommer la playlist', 'Nom', p.name, 'Renommer', async (name) => {
      await savePlaylist({ ...lib.playlists.get(id), name });
      render({ keepScroll: true });
    }),
    'pm-sync': () => { closeSheet(); runImport(() => resync(p)); },
    'pm-queue': () => { closeSheet(); p.trackIds.forEach((t) => player.addToQueue(t)); toast('Ajoutée à la file d’attente.'); },
    'pm-delete': () => confirmSheet('Supprimer la playlist ?', `« ${p.name} » sera supprimée. Les titres restent dans ta bibliothèque.`, 'Supprimer', async () => {
      lib.playlists.delete(id);
      await db.delete('playlists', id);
      cloud.touch('playlist', id);
      toast('Playlist supprimée.');
      location.hash = '#/';
      render();
    }),
  });
}

/* ================= Import ================= */
async function runImport(task) {
  document.body.classList.add('is-importing');
  try {
    await task();
    return true;
  } catch (err) {
    console.error(err);
    toast(err.message || 'L’import a échoué.', { error: true, timeout: 7000 });
    return false;
  } finally {
    document.body.classList.remove('is-importing');
  }
}

async function importFiles(fileList, { playlistId = null, asFolder = false } = {}) {
  const files = [...fileList].filter((f) => f.type.startsWith('audio/') || AUDIO_EXT.test(f.name));
  if (!files.length) return toast('Aucun fichier audio dans la sélection.', { error: true });
  const progress = toast(`Import de ${plural(files.length, 'titre')}…`, { timeout: 0 });
  const existing = new Map([...lib.tracks.values()].filter((t) => t.fileName).map((t) => [`${t.fileName}|${t.fileSize}`, t.id]));
  const ids = [];
  let failed = 0;

  for (const [i, file] of files.entries()) {
    progress.update(`Import ${i + 1} sur ${files.length} : ${file.name}`);
    const dupe = existing.get(`${file.name}|${file.size}`);
    if (dupe) { ids.push(dupe); continue; }
    try {
      const tags = await readTags(file);
      const guess = guessFromFilename(file.name);
      const id = uid('t');
      const fileKey = `f${id}`;
      let coverKey = null;
      if (tags.cover?.size > 200) {
        coverKey = `c${hash(`${tags.artist}|${tags.album}|${tags.cover.size}`)}`;
        if (!lib.covers.has(coverKey)) {
          await db.put('covers', { id: coverKey, blob: tags.cover });
          lib.covers.set(coverKey, URL.createObjectURL(tags.cover));
        }
      }
      const blob = new Blob([file], { type: audioType(file, file.name) });
      const url = URL.createObjectURL(blob);
      const duration = await probeDuration(url);
      URL.revokeObjectURL(url);
      await db.put('files', blob, fileKey);
      const folder = file.webkitRelativePath ? file.webkitRelativePath.split('/').slice(-2, -1)[0] : '';
      const track = {
        id, source: 'local', fileKey, fileName: file.name, fileSize: file.size,
        title: tags.title || guess.title,
        artist: tags.artist || guess.artist || '',
        album: tags.album || folder || '',
        duration: Math.round(duration), coverKey, addedAt: Date.now() + i,
      };
      await saveTrack(track);
      ids.push(id);
    } catch (err) {
      console.error(err);
      failed++;
      if (err.name === 'QuotaExceededError') {
        progress.close();
        toast('Plus assez d’espace sur l’appareil pour importer la suite.', { error: true, timeout: 8000 });
        break;
      }
    }
  }
  reindex();
  navigator.storage?.persist?.();

  if (playlistId && lib.playlists.has(playlistId)) {
    const p = lib.playlists.get(playlistId);
    await savePlaylist({ ...p, trackIds: [...p.trackIds, ...ids.filter((x) => !p.trackIds.includes(x))] });
  } else if (asFolder && ids.length) {
    const name = files[0].webkitRelativePath?.split('/')[0] || 'Dossier importé';
    const p = { id: uid('p'), name, description: '', source: 'local', trackIds: ids, createdAt: Date.now() };
    await savePlaylist(p);
    location.hash = `#/playlist/${p.id}`;
  }
  progress.done(`${plural(ids.length, 'titre')} ajouté${ids.length > 1 ? 's' : ''}${failed ? `, ${failed} illisible${failed > 1 ? 's' : ''}` : ''}.`);
  render({ keepScroll: true });
  return ids;
}

// Importe des fichiers et les rapproche des titres d'une playlist Deezer/Spotify
function completePlaylistFlow(playlistId) {
  const p = lib.playlists.get(playlistId);
  if (!p) return;
  const fullCount = () => p.trackIds.filter((id) => lib.tracks.has(id) && isPlayable(lib.tracks.get(id))).length;
  const missing = p.trackIds.filter((id) => lib.tracks.has(id) && !isPlayable(lib.tracks.get(id)));
  const sample = missing.slice(0, 6).map((id) => lib.tracks.get(id));
  openSheet('Compléter avec mes fichiers', `
    <p class="sheet-text">Choisis tes fichiers audio (ou tout un dossier). Chaque fichier dont le titre et l’artiste correspondent à un morceau de « ${esc(p.name)} » sera lu en entier à sa place.</p>
    <p class="sheet-text">Il manque ${plural(missing.length, 'titre')}, par exemple :</p>
    <ul class="hint-list sheet-missing">${sample.map((t) => `<li>${esc(t.artist)}, ${esc(t.title)}</li>`).join('')}</ul>
    <div class="sheet-actions">
      <button class="btn btn-ghost folder-only" data-action="c-folder">${icon('folder')} Un dossier</button>
      <button class="btn btn-primary" data-action="c-files">Choisir des fichiers</button>
    </div>`, {
    'c-files': () => { closeSheet(); pendingComplete = { id: playlistId, before: fullCount(), fullCount }; fileInput.click(); },
    'c-folder': () => { closeSheet(); pendingComplete = { id: playlistId, before: fullCount(), fullCount }; folderInput.click(); },
  });
}
let pendingComplete = null;

function reportCompletion() {
  if (!pendingComplete) return;
  const { id, before, fullCount } = pendingComplete;
  pendingComplete = null;
  const p = lib.playlists.get(id);
  if (!p) return;
  const gained = fullCount() - before;
  toast(gained > 0
    ? `${plural(gained, 'titre')} de « ${p.name} » ${gained > 1 ? 'passent' : 'passe'} en version complète.`
    : 'Aucun fichier ne correspond aux titres de la playlist. Vérifie les tags titre et artiste, ou associe un fichier depuis le menu d’un titre.', { timeout: 8000 });
}

fileInput.addEventListener('change', () => {
  const pl = pendingPlaylistId;
  pendingPlaylistId = null;
  const files = [...fileInput.files];
  fileInput.value = '';
  if (!files.length) { pendingComplete = null; return; }
  if (pendingComplete) runImport(async () => { await importFiles(files); reportCompletion(); });
  else runImport(() => importFiles(files, { playlistId: pl }));
});

folderInput.addEventListener('change', () => {
  const files = [...folderInput.files];
  folderInput.value = '';
  if (!files.length) { pendingComplete = null; return; }
  if (pendingComplete) runImport(async () => { await importFiles(files); reportCompletion(); });
  else runImport(() => importFiles(files, { asFolder: true }));
});

attachInput.addEventListener('change', async () => {
  const file = attachInput.files[0];
  const t = lib.tracks.get(pendingAttachId);
  attachInput.value = '';
  pendingAttachId = null;
  if (!file || !t) return;
  const fileKey = t.fileKey || `f${t.id}`;
  await db.put('files', new Blob([file], { type: audioType(file, file.name) }), fileKey);
  await saveTrack({ ...t, fileKey, fileName: file.name, fileSize: file.size, cloudFile: false, cloudSkip: undefined });
  reindex();
  toast(`Version complète associée à « ${t.title} ».`);
  render({ keepScroll: true });
});

// Glisser-déposer sur ordinateur
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
  dragDepth++;
  document.body.classList.add('is-dragging');
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove('is-dragging');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('is-dragging');
  if (e.dataTransfer?.files?.length) runImport(() => importFiles(e.dataTransfer.files));
});

function upsertRemote(tracks) {
  const byDeezer = new Map();
  const bySpotify = new Map();
  for (const t of lib.tracks.values()) {
    if (t.deezerId) byDeezer.set(t.deezerId, t);
    if (t.spotifyUri) bySpotify.set(t.spotifyUri, t);
  }
  const now = Date.now();
  const toSave = [];
  const ids = tracks.map((data, i) => {
    const found = (data.deezerId && byDeezer.get(data.deezerId)) || (data.spotifyUri && bySpotify.get(data.spotifyUri));
    const t = found
      ? { ...found, ...data, source: found.source, liked: found.liked, fileKey: found.fileKey }
      : { id: uid('t'), ...data, addedAt: now - i };
    lib.tracks.set(t.id, t);
    toSave.push(t);
    return t.id;
  });
  return db.putMany('tracks', toSave).then(() => {
    toSave.forEach((t) => cloud.touch('track', t.id));
    return [...new Set(ids)];
  });
}

async function saveImportedPlaylist(data, source) {
  if (!data.tracks.length) throw new Error(`« ${data.name} » ne contient aucun titre lisible.`);
  const ids = await upsertRemote(data.tracks);
  const existing = [...lib.playlists.values()].find((p) => p.sourceId === data.sourceId);
  const p = existing
    ? { ...existing, name: data.name, coverUrl: data.coverUrl || existing.coverUrl, trackIds: ids }
    : { id: uid('p'), name: data.name, description: data.description || '', coverUrl: data.coverUrl || null, source, sourceId: data.sourceId, trackIds: ids, createdAt: Date.now() };
  await savePlaylist(p);
  toast(`« ${p.name} » ${existing ? 'mise à jour' : 'importée'} : ${plural(ids.length, 'titre')}.`);
  if (location.hash !== `#/playlist/${p.id}`) location.hash = `#/playlist/${p.id}`;
  else render({ keepScroll: true });
  return p;
}

async function resync(p) {
  const [origin, kind, id] = p.sourceId.split(':');
  if (origin === 'deezer') return saveImportedPlaylist(kind === 'album' ? await deezer.getAlbum(id) : await deezer.getPlaylist(id), 'deezer');
  if (kind === 'liked') return saveImportedPlaylist(await spotify.likedTracks(), 'spotify');
  return saveImportedPlaylist(await spotify.getPlaylist(id), 'spotify');
}

async function importLink(raw) {
  const input = String(raw || '').trim();
  const dz = deezer.parseDeezerLink(input);
  if (dz) {
    if (dz.kind === 'short') throw new Error('Les liens courts Deezer ne peuvent pas être lus. Ouvre le lien dans ton navigateur, puis copie l’adresse complète (deezer.com/…/playlist/…).');
    const loading = toast('Lecture du lien Deezer…', { timeout: 0 });
    try {
      if (dz.kind === 'profile') { loading.close(); return deezerPicker(dz.id); }
      if (dz.kind === 'track') {
        const data = await deezer.getTrack(dz.id);
        await upsertRemote(data.tracks);
        toast(`« ${data.name} » ajouté à ta bibliothèque.`);
        return render({ keepScroll: true });
      }
      return await saveImportedPlaylist(dz.kind === 'album' ? await deezer.getAlbum(dz.id) : await deezer.getPlaylist(dz.id), 'deezer');
    } finally { loading.close(); }
  }

  const sp = spotify.parseSpotifyLink(input);
  if (sp) {
    if (!spotify.isConnected()) throw new Error('Connecte ton compte Spotify (Réglages) pour importer cette playlist.');
    try {
      return await saveImportedPlaylist(await spotify.getPlaylist(sp.id), 'spotify');
    } catch (err) {
      if (err.status === 403 || err.status === 404) throw new Error('Spotify ne partage que le contenu de tes propres playlists. Pour une playlist d’un autre compte, ajoute-la d’abord à ta bibliothèque Spotify ou copie-la.');
      throw err;
    }
  }
  if (/open\.spotify\.com\/(album|track|artist)/.test(input)) throw new Error('Pour Spotify, seules les playlists sont prises en charge.');

  if (/^https?:\/\/\S+$/i.test(input)) {
    const duration = await probeDuration(input);
    if (!duration) throw new Error('Ce lien ne mène pas à un fichier audio lisible. Vérifie qu’il s’agit d’un lien direct (.mp3, .m4a…).');
    const name = decodeURIComponent(new URL(input).pathname.split('/').pop() || 'Titre en ligne');
    const guess = guessFromFilename(name);
    const t = { id: uid('t'), source: 'url', url: input, title: guess.title, artist: guess.artist || new URL(input).hostname, album: '', duration: Math.round(duration), addedAt: Date.now() };
    await saveTrack(t);
    toast(`« ${t.title} » ajouté.`);
    location.hash = '#/all';
    return;
  }
  throw new Error('Lien non reconnu. Colle un lien Deezer, un lien de playlist Spotify ou un lien direct vers un fichier audio.');
}

function pickerSheet(title, items, onImport) {
  openSheet(title, `
    <form class="picker">
      <label class="picker-all"><input type="checkbox" data-pick-all> Tout sélectionner</label>
      <div class="picker-list">
        ${items.map((p) => `
          <label class="picker-item">
            <input type="checkbox" name="pick" value="${esc(p.id)}">
            ${p.cover ? artHtml(p.cover, '', 'menu-art') : monogram(p.name, 'menu-art')}
            <span class="row-main"><span class="row-title">${esc(p.name)}</span><span class="row-sub">${p.count != null ? plural(p.count, 'titre') : ''}</span></span>
          </label>`).join('')}
      </div>
      <div class="sheet-actions">
        <button type="button" class="btn btn-ghost" data-action="sheet-close">Annuler</button>
        <button class="btn btn-primary">Importer la sélection</button>
      </div>
    </form>`);
  const form = $('.picker', sheet);
  $('[data-pick-all]', form).addEventListener('change', (e) => $$('[name=pick]', form).forEach((c) => { c.checked = e.target.checked; }));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const chosen = $$('[name=pick]:checked', form).map((c) => c.value);
    if (!chosen.length) return toast('Sélectionne au moins une playlist.');
    closeSheet();
    runImport(async () => {
      const progress = toast('Import…', { timeout: 0 });
      let done = 0;
      try {
        for (const id of chosen) {
          const item = items.find((x) => String(x.id) === id);
          progress.update(`Import ${++done} sur ${chosen.length} : ${item?.name || ''}`);
          try { await onImport(id); } catch (err) { toast(`${item?.name} : ${err.message}`, { error: true, timeout: 7000 }); }
        }
      } finally { progress.close(); }
    });
  });
}

async function deezerPicker(userId) {
  const { user, playlists } = await deezer.getUserPlaylists(userId);
  if (!playlists.length) throw new Error(`Le profil de ${user} n’a aucune playlist publique.`);
  pickerSheet(`Playlists de ${user}`, playlists, async (id) => saveImportedPlaylist(await deezer.getPlaylist(id), 'deezer'));
}

async function spotifyPicker() {
  await runImport(async () => {
    const playlists = await spotify.myPlaylists();
    if (!playlists.length) throw new Error('Aucune playlist trouvée sur ton compte Spotify.');
    pickerSheet('Tes playlists Spotify', playlists, async (id) => saveImportedPlaylist(await spotify.getPlaylist(id), 'spotify'));
  });
}

async function spotifyLogin() {
  try {
    sessionStorage.setItem('sillon.afterLogin', 'pick');
    await spotify.login();
  } catch (err) {
    toast(err.message, { error: true });
  }
}

/* ================= Stockage, installation, démarrage ================= */
async function updateStorageInfo() {
  const el = $('#storage-info');
  if (!el) return;
  const files = [...lib.tracks.values()].filter((t) => t.fileKey).length;
  let text = `${plural(files, 'fichier audio')} et ${plural(lib.playlists.size, 'playlist')} sur cet appareil.`;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    const persisted = await navigator.storage.persisted?.();
    const mb = (n) => (n / 1048576 >= 1000 ? `${(n / 1073741824).toFixed(1)} Go` : `${Math.round(n / 1048576)} Mo`);
    text += ` ${mb(usage)} utilisés sur ${mb(quota)} disponibles.${persisted ? '' : ' Le navigateur peut libérer cet espace s’il en manque : installe l’app pour le protéger.'}`;
  } catch { /* API indisponible */ }
  el.textContent = text;
}

/* ================= Compte & synchronisation ================= */
let syncState = { state: 'idle' };
let uploadToast = null;

function syncText() {
  if (!cloud.currentUser()) return '';
  const { state, done, total, message } = syncState;
  if (state === 'sync') return 'Synchronisation en cours…';
  if (state === 'upload' && done < total) return `Envoi des fichiers : ${done + 1} sur ${total}`;
  if (state === 'error') return `Synchronisation impossible (${message}). Nouvel essai automatique.`;
  const last = cloud.lastSync();
  return last ? `À jour, dernière synchronisation à ${new Date(last).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}` : 'Pas encore synchronisé.';
}

function onSyncStatus(next) {
  if (next.state === 'warning') { toast(next.message, { timeout: 8000 }); return; }
  syncState = next;
  if (next.state === 'upload') {
    if (next.done < next.total) {
      const text = `Sauvegarde dans ton compte : ${next.done + 1} sur ${next.total}`;
      if (uploadToast) uploadToast.update(text); else uploadToast = toast(text, { timeout: 0 });
    } else if (uploadToast) {
      uploadToast.done('Fichiers sauvegardés dans ton compte.');
      uploadToast = null;
    }
  } else if (next.state === 'error' && uploadToast) {
    uploadToast.close();
    uploadToast = null;
  }
  $$('[data-sync-status]').forEach((el) => { el.textContent = syncText(); });
  $('#account-chip')?.classList.toggle('is-error', next.state === 'error');
  $('#account-chip')?.classList.toggle('is-busy', next.state === 'sync' || next.state === 'upload');
}

function renderAccountChip() {
  const chip = $('#account-chip');
  if (!chip) return;
  chip.hidden = !cloud.isConfigured();
  const u = cloud.currentUser();
  chip.innerHTML = u
    ? `<span class="avatar" aria-hidden="true">${esc((u.email || '?').charAt(0).toUpperCase())}</span>
       <span class="account-text"><span class="account-name">${esc(u.email)}</span><span class="account-sub" data-sync-status>${esc(syncText())}</span></span>`
    : `<span class="avatar" aria-hidden="true">${icon('user')}</span>
       <span class="account-text"><span class="account-name">Se connecter</span><span class="account-sub">Sauvegarde tes musiques</span></span>`;
}

// Tri des clés : jsonb ne conserve pas l'ordre, on compare donc sur une forme stable
function stable(value) {
  return JSON.stringify(value, (_, v) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : v));
}

async function applyRemote(rows) {
  const tracks = [];
  const playlists = [];
  const goneTracks = [];
  const gonePlaylists = [];
  for (const r of rows) {
    const isTrack = r.kind === 'track';
    const map = isTrack ? lib.tracks : lib.playlists;
    if (r.deleted || !r.data) {
      if (map.has(r.id)) (isTrack ? goneTracks : gonePlaylists).push(r.id);
      continue;
    }
    const local = map.get(r.id);
    if (local && stable(local) === stable(r.data)) continue;
    (isTrack ? tracks : playlists).push(r.data);
  }
  if (!tracks.length && !playlists.length && !goneTracks.length && !gonePlaylists.length) return;

  tracks.forEach((t) => lib.tracks.set(t.id, t));
  playlists.forEach((p) => lib.playlists.set(p.id, p));
  if (tracks.length) await db.putMany('tracks', tracks);
  if (playlists.length) await db.putMany('playlists', playlists);
  if (goneTracks.length) {
    await db.deleteMany('files', goneTracks.map((id) => lib.tracks.get(id)?.fileKey).filter(Boolean));
    await db.deleteMany('tracks', goneTracks);
    goneTracks.forEach((id) => lib.tracks.delete(id));
  }
  if (gonePlaylists.length) {
    await db.deleteMany('playlists', gonePlaylists);
    gonePlaylists.forEach((id) => lib.playlists.delete(id));
  }
  reindex();
  await fetchMissingCovers();
  refreshAfterSync();
}

async function fetchMissingCovers() {
  const keys = new Set();
  for (const t of lib.tracks.values()) if (t.coverKey && t.coverCloud && !lib.covers.has(t.coverKey)) keys.add(t.coverKey);
  for (const key of keys) {
    const blob = await cloud.downloadCover(key);
    if (!blob) continue;
    await db.put('covers', { id: key, blob });
    lib.covers.set(key, URL.createObjectURL(blob));
  }
}

let refreshPending = false;
function refreshAfterSync() {
  // On évite de redessiner pendant que l'on tape dans un champ
  if (document.activeElement?.closest?.('#main input, #main textarea') || sheet.open) {
    if (!refreshPending) {
      refreshPending = true;
      document.addEventListener('focusout', () => { refreshPending = false; setTimeout(refreshAfterSync, 50); }, { once: true });
    }
    return;
  }
  render({ keepScroll: true });
  renderPlayer();
}

cloud.configure({
  getTrack: (id) => lib.tracks.get(id),
  getPlaylist: (id) => lib.playlists.get(id),
  allKeys: () => [...[...lib.tracks.keys()].map((id) => ['track', id]), ...[...lib.playlists.keys()].map((id) => ['playlist', id])],
  resetCloudFlags: () => {
    const changed = [];
    for (const t of lib.tracks.values()) {
      if (!t.cloudFile && !t.coverCloud && !t.cloudSkip) continue;
      const next = { ...t, cloudFile: false, coverCloud: false, cloudSkip: undefined };
      lib.tracks.set(t.id, next);
      changed.push(next);
    }
    if (changed.length) db.putMany('tracks', changed);
  },
  tracksToUpload: () => [...lib.tracks.values()].filter((t) => t.fileKey && !t.cloudFile && !t.cloudSkip),
  coversToUpload: () => [...new Set([...lib.tracks.values()].filter((t) => t.coverKey && !t.coverCloud && lib.covers.has(t.coverKey)).map((t) => t.coverKey))],
  patchTrack: async (id, patch) => {
    const t = lib.tracks.get(id);
    if (t) await saveTrack({ ...t, ...patch });
  },
  markCoverUploaded: async (key) => {
    for (const t of [...lib.tracks.values()]) if (t.coverKey === key && !t.coverCloud) await saveTrack({ ...t, coverCloud: true });
  },
  applyRemote,
  status: onSyncStatus,
});

function newPasswordSheet() {
  openSheet('Nouveau mot de passe', `
    <form class="form" data-form="new-password">
      <label class="field"><span class="field-label">Choisis un nouveau mot de passe (6 caractères minimum)</span>
        <input class="input" name="password" type="password" autocomplete="new-password" minlength="6" required></label>
      <div class="sheet-actions"><button class="btn btn-primary">Enregistrer</button></div>
    </form>`);
  $('form', sheet).addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await cloud.updatePassword(new FormData(e.target).get('password'));
      closeSheet();
      toast('Mot de passe modifié.');
    } catch (err) { toast(err.message, { error: true }); }
  });
}

function onAuth(event, u, previous) {
  if (event === 'PASSWORD_RECOVERY') newPasswordSheet();
  if (u && u.id !== previous) {
    cloud.adoptUser();
    if (event === 'SIGNED_IN') toast(`Connecté avec ${u.email}. Synchronisation de ta bibliothèque…`, { timeout: 6000 });
  }
  if (!u && previous) toast('Déconnecté. Tes musiques restent disponibles sur cet appareil.', { timeout: 6000 });
  syncState = { state: 'idle' };
  renderAccountChip();
  if (currentRoute().name === 'settings') render({ keepScroll: true });
}

async function initCloud() {
  if (!cloud.isConfigured()) return;
  const authHash = location.hash;
  const fromEmailLink = /access_token=|error_description=/.test(authHash);
  const u = await cloud.init(onAuth);
  if (fromEmailLink) {
    history.replaceState(null, '', `${location.pathname}${location.search}#/settings`);
    const failure = /error_description=([^&]+)/.exec(authHash);
    if (failure) toast(`Lien invalide ou expiré : ${decodeURIComponent(failure[1].replace(/\+/g, ' '))}`, { error: true, timeout: 9000 });
  }
  renderAccountChip();
  if (u) cloud.adoptUser();
  if (fromEmailLink || currentRoute().name === 'settings') render({ keepScroll: !fromEmailLink });
}

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') cloud.schedule(300); });
window.addEventListener('online', () => cloud.schedule(300));
setInterval(() => { if (document.visibilityState === 'visible') cloud.schedule(0); }, 60000);

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  document.body.classList.add('can-install');
});

async function start() {
  try {
    await loadLibrary();
  } catch (err) {
    main.innerHTML = '<div class="page empty"><p>Le stockage local est indisponible (navigation privée ?). Ouvre Sillon dans une fenêtre normale.</p></div>';
    throw err;
  }
  renderVolume();
  renderPlayer();

  try {
    const me = await spotify.handleRedirect();
    if (me) {
      toast(`Connecté à Spotify : ${me.name}.`);
      if (sessionStorage.getItem('sillon.afterLogin') === 'pick') {
        sessionStorage.removeItem('sillon.afterLogin');
        location.hash = '#/import';
        render();
        spotifyPicker();
        return;
      }
    }
  } catch (err) {
    toast(err.message, { error: true, timeout: 8000 });
  }
  render();
  renderAccountChip();
  initCloud();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker', err));
  }
}

// Toute erreur imprévue est affichée : une panne silencieuse est impossible à diagnostiquer
let lastErrorToast = 0;
function reportUnexpected(message) {
  if (!message || Date.now() - lastErrorToast < 4000) return;
  lastErrorToast = Date.now();
  toast(`Erreur inattendue : ${message}`, { error: true, timeout: 9000 });
}
window.addEventListener('error', (e) => reportUnexpected(e.message));
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason;
  if (reason?.name === 'AbortError' || reason?.name === 'NotAllowedError') return;
  reportUnexpected(reason?.message || String(reason));
});

// Outils de diagnostic : ouvrir le site avec ?debug
if (new URLSearchParams(location.search).has('debug')) window.sillon = { player, lib };

start();
