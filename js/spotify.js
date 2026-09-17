// Connexion Spotify (OAuth PKCE, sans serveur) + lecture via le Web Playback SDK.
// Nécessite un « Client ID » créé sur developer.spotify.com (compte Premium requis depuis 2026).

const AUTH = 'https://accounts.spotify.com';
const API = 'https://api.spotify.com/v1';
const SCOPES = [
  'playlist-read-private', 'playlist-read-collaborative', 'user-library-read',
  'streaming', 'user-read-email', 'user-read-private',
  'user-read-playback-state', 'user-modify-playback-state',
].join(' ');
const KEY = 'sillon.spotify';

const store = {
  read() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } },
  write(patch) {
    const next = { ...store.read(), ...patch };
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* stockage indisponible */ }
    return next;
  },
};

export const redirectUri = () => location.origin + location.pathname;
export const getClientId = () => store.read().clientId || '';
export const setClientId = (clientId) => store.write({ clientId: clientId.trim() });
export const isConnected = () => Boolean(store.read().refreshToken);
export const profile = () => store.read().profile || null;

export function disconnect() {
  const { clientId } = store.read();
  try { localStorage.setItem(KEY, JSON.stringify({ clientId })); } catch { /* ignore */ }
  sdk.player?.disconnect();
  sdk.player = null;
  sdk.deviceId = null;
}

function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function login() {
  const clientId = getClientId();
  if (!clientId) throw new Error('Ajoute d’abord ton Client ID Spotify.');
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(12)));
  sessionStorage.setItem('sillon.pkce', JSON.stringify({ verifier, state }));
  const qs = new URLSearchParams({
    response_type: 'code', client_id: clientId, scope: SCOPES,
    code_challenge_method: 'S256', code_challenge: challenge,
    redirect_uri: redirectUri(), state,
  });
  location.assign(`${AUTH}/authorize?${qs}`);
}

// À appeler au démarrage : termine la connexion si on revient de Spotify.
export async function handleRedirect() {
  const params = new URLSearchParams(location.search);
  if (!params.has('code') && !params.has('error')) return null;
  const saved = JSON.parse(sessionStorage.getItem('sillon.pkce') || '{}');
  sessionStorage.removeItem('sillon.pkce');
  history.replaceState(null, '', redirectUri() + location.hash);
  if (params.get('error')) throw new Error('Connexion Spotify refusée.');
  if (!saved.verifier || saved.state !== params.get('state')) throw new Error('La connexion Spotify a expiré, recommence.');
  const tokens = await tokenRequest({
    grant_type: 'authorization_code', code: params.get('code'),
    redirect_uri: redirectUri(), client_id: getClientId(), code_verifier: saved.verifier,
  });
  saveTokens(tokens);
  const me = await api('/me');
  store.write({ profile: { name: me.display_name || me.id, premium: me.product === 'premium' } });
  return profile();
}

async function tokenRequest(body) {
  const res = await fetch(`${AUTH}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || 'Spotify a refusé la connexion.');
  return data;
}

function saveTokens(t) {
  store.write({
    accessToken: t.access_token,
    refreshToken: t.refresh_token || store.read().refreshToken,
    expiresAt: Date.now() + (t.expires_in - 60) * 1000,
  });
}

async function token() {
  const s = store.read();
  if (!s.refreshToken) throw new Error('Connecte-toi à Spotify dans Réglages.');
  if (s.accessToken && Date.now() < s.expiresAt) return s.accessToken;
  saveTokens(await tokenRequest({ grant_type: 'refresh_token', refresh_token: s.refreshToken, client_id: s.clientId }));
  return store.read().accessToken;
}

export async function api(path, options = {}) {
  const res = await fetch(path.startsWith('http') ? path : API + path, {
    ...options,
    headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json', ...options.headers },
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data?.error?.message || `Erreur Spotify (${res.status})`;
    const err = new Error(res.status === 403 ? `Spotify refuse l’accès : ${msg}` : msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function collect(url, max = 5000) {
  const out = [];
  while (url && out.length < max) {
    const page = await api(url);
    out.push(...(page.items || []));
    url = page.next;
  }
  return out;
}

export async function myPlaylists() {
  const items = await collect('/me/playlists?limit=50', 1000);
  return items.filter(Boolean).map((p) => ({
    id: p.id,
    name: p.name,
    count: (p.items || p.tracks)?.total ?? null,
    cover: p.images?.[0]?.url || null,
  }));
}

function mapTrack(t) {
  return {
    source: 'spotify',
    spotifyUri: t.uri,
    title: t.name,
    artist: (t.artists || []).map((a) => a.name).join(', '),
    album: t.album?.name,
    duration: Math.round((t.duration_ms || 0) / 1000),
    coverUrl: t.album?.images?.[0]?.url || null,
    isrc: t.external_ids?.isrc,
    link: t.external_urls?.spotify,
  };
}

export async function getPlaylist(id) {
  const meta = await api(`/playlists/${id}?fields=name,description,images`);
  let rows;
  try {
    rows = await collect(`/playlists/${id}/items?limit=50`);
  } catch (err) {
    if (err.status !== 404) throw err;
    rows = await collect(`/playlists/${id}/tracks?limit=50`); // ancienne API
  }
  const tracks = rows
    .map((r) => r.item || r.track)
    .filter((t) => t && t.type !== 'episode' && t.uri && !t.is_local)
    .map(mapTrack);
  return {
    name: meta.name,
    description: (meta.description || '').replace(/<[^>]+>/g, ''),
    coverUrl: meta.images?.[0]?.url || null,
    sourceId: `spotify:playlist:${id}`,
    tracks,
  };
}

export async function likedTracks() {
  const rows = await collect('/me/tracks?limit=50');
  return { name: 'Titres likés Spotify', description: '', sourceId: 'spotify:liked', tracks: rows.map((r) => r.track || r.item).filter(Boolean).map(mapTrack) };
}

export function parseSpotifyLink(input) {
  const m = input.trim().match(/(?:open\.spotify\.com\/(?:intl-[a-z]+\/)?|spotify:)(playlist)[/:]([A-Za-z0-9]+)/);
  return m ? { kind: m[1], id: m[2] } : null;
}

/* ---------- Lecture (Web Playback SDK, Premium, navigateur ordinateur) ---------- */
const sdk = { player: null, deviceId: null, loading: null };

export const sdkSupported = () => !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

function loadSdk() {
  if (sdk.loading) return sdk.loading;
  sdk.loading = new Promise((resolve, reject) => {
    window.onSpotifyWebPlaybackSDKReady = resolve;
    const s = document.createElement('script');
    s.src = 'https://sdk.scdn.co/spotify-player.js';
    s.onerror = () => { sdk.loading = null; reject(new Error('Lecteur Spotify introuvable.')); };
    document.head.appendChild(s);
  });
  return sdk.loading;
}

export async function ensurePlayer(onState) {
  if (sdk.deviceId) return sdk;
  await loadSdk();
  const player = new window.Spotify.Player({
    name: 'Sillon',
    getOAuthToken: (cb) => token().then(cb).catch(() => cb('')),
    volume: 0.8,
  });
  sdk.deviceId = await new Promise((resolve, reject) => {
    const fail = ({ message }) => reject(new Error(message));
    player.addListener('ready', ({ device_id }) => resolve(device_id));
    player.addListener('initialization_error', fail);
    player.addListener('authentication_error', fail);
    player.addListener('account_error', () => reject(new Error('La lecture Spotify complète demande un compte Premium.')));
    setTimeout(() => reject(new Error('Le lecteur Spotify ne démarre pas.')), 12000);
    player.connect();
  });
  player.addListener('player_state_changed', (state) => onState?.(state));
  sdk.player = player;
  return sdk;
}

export async function playUri(uri, onState) {
  const { deviceId, player } = await ensurePlayer(onState);
  await player.activateElement?.();
  await api(`/me/player/play?device_id=${deviceId}`, { method: 'PUT', body: JSON.stringify({ uris: [uri] }) });
  return player;
}

export const sdkPlayer = () => sdk.player;

/* ---------- Spotify Connect : pilote l'app Spotify du téléphone (Premium) ---------- */
export async function devices() {
  const r = await api('/me/player/devices');
  return r?.devices || [];
}

export async function pickDevice() {
  const list = (await devices()).filter((d) => !d.is_restricted && d.name !== 'Sillon');
  return list.find((d) => d.is_active) || list.find((d) => d.type === 'Smartphone') || list[0] || null;
}

const connect = { deviceId: null };

export async function connectPlay(uri) {
  const device = await pickDevice();
  if (!device) throw new Error('Ouvre l’app Spotify sur ce téléphone, lance n’importe quel titre puis reviens ici.');
  connect.deviceId = device.id;
  await api(`/me/player/play?device_id=${device.id}`, { method: 'PUT', body: JSON.stringify({ uris: [uri] }) });
  return device;
}

// Même interface que le lecteur du SDK
export const connectPlayer = {
  async getCurrentState() {
    const r = await api('/me/player').catch(() => null);
    if (!r?.item) return null;
    return { position: r.progress_ms, duration: r.item.duration_ms, paused: !r.is_playing, uri: r.item.uri };
  },
  async togglePlay() {
    const s = await this.getCurrentState();
    return s && !s.paused ? this.pause() : this.resume();
  },
  pause: () => api('/me/player/pause', { method: 'PUT' }).catch(() => {}),
  resume: () => api(`/me/player/play${connect.deviceId ? `?device_id=${connect.deviceId}` : ''}`, { method: 'PUT' }).catch(() => {}),
  seek: (ms) => api(`/me/player/seek?position_ms=${ms}`, { method: 'PUT' }).catch(() => {}),
  setVolume: (v) => api(`/me/player/volume?volume_percent=${Math.round(v * 100)}`, { method: 'PUT' }).catch(() => {}),
};
