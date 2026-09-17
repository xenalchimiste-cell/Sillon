// API publique Deezer (sans compte). Le serveur n'envoie pas d'en-têtes CORS,
// on passe donc par JSONP, que l'API supporte officiellement.

let counter = 0;

function jsonp(path, params = {}) {
  return new Promise((resolve, reject) => {
    const cb = `__dz${Date.now()}${counter++}`;
    const qs = new URLSearchParams({ ...params, output: 'jsonp', callback: cb });
    const script = document.createElement('script');
    const cleanup = () => { delete window[cb]; script.remove(); clearTimeout(timer); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Deezer ne répond pas. Vérifie ta connexion.')); }, 15000);
    window[cb] = (data) => {
      cleanup();
      if (data && data.error) reject(new Error(deezerError(data.error)));
      else resolve(data);
    };
    script.onerror = () => { cleanup(); reject(new Error('Deezer est injoignable.')); };
    script.src = `https://api.deezer.com/${path}?${qs}`;
    document.head.appendChild(script);
  });
}

function deezerError(err) {
  if (err.code === 800) return 'Introuvable sur Deezer. La playlist est peut-être privée.';
  if (err.code === 4) return 'Trop de requêtes vers Deezer, réessaie dans quelques secondes.';
  return err.message || 'Erreur Deezer';
}

async function paged(path, max = 2000) {
  const items = [];
  let index = 0;
  while (items.length < max) {
    const page = await jsonp(path, { index, limit: 100 });
    items.push(...(page.data || []));
    if (!page.next || !page.data?.length) break;
    index += page.data.length;
  }
  return items;
}

export function parseDeezerLink(input) {
  const s = input.trim();
  if (/link\.deezer\.com|deezer\.page\.link|dzr\.page\.link/.test(s)) return { kind: 'short' };
  const m = s.match(/deezer\.com\/(?:[a-z]{2}\/)?(playlist|album|profile|user|track)\/(\d+)/i);
  if (m) return { kind: m[1].toLowerCase() === 'user' ? 'profile' : m[1].toLowerCase(), id: m[2] };
  if (/^\d{3,}$/.test(s)) return { kind: 'playlist', id: s };
  return null;
}

export function mapTrack(t, albumFallback) {
  const album = t.album || albumFallback || {};
  return {
    source: 'deezer',
    deezerId: t.id,
    title: t.title_short && t.title_version ? `${t.title_short} ${t.title_version}` : t.title,
    artist: t.artist?.name,
    album: album.title,
    duration: t.duration || 0,
    coverUrl: album.cover_xl || album.cover_big || album.cover_medium || null,
    isrc: t.isrc,
    link: t.link,
  };
}

export async function getPlaylist(id) {
  const meta = await jsonp(`playlist/${id}`);
  const tracks = await paged(`playlist/${id}/tracks`, meta.nb_tracks || 2000);
  return {
    name: meta.title,
    description: meta.description || '',
    coverUrl: meta.picture_xl || meta.picture_big,
    sourceId: `deezer:playlist:${id}`,
    tracks: tracks.filter((t) => t.readable !== false).map((t) => mapTrack(t)),
  };
}

export async function getAlbum(id) {
  const meta = await jsonp(`album/${id}`);
  const tracks = await paged(`album/${id}/tracks`);
  return {
    name: meta.title,
    description: meta.artist?.name || '',
    coverUrl: meta.cover_xl || meta.cover_big,
    sourceId: `deezer:album:${id}`,
    tracks: tracks.map((t) => mapTrack(t, meta)),
  };
}

export async function getTrack(id) {
  const t = await jsonp(`track/${id}`);
  return { name: t.title, tracks: [mapTrack(t)] };
}

export async function getUserPlaylists(userId) {
  const user = await jsonp(`user/${userId}`);
  const lists = await paged(`user/${userId}/playlists`, 500);
  return {
    user: user.name,
    playlists: lists.map((p) => ({
      id: p.id,
      name: p.title,
      count: p.nb_tracks,
      cover: p.picture_medium,
      loved: p.is_loved_track,
    })),
  };
}
