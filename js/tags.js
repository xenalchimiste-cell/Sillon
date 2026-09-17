// Lecture des métadonnées embarquées : ID3 (mp3), FLAC, MP4/M4A.
// Retourne { title, artist, album, cover: Blob|null } — champs absents = undefined.

const latin1 = new TextDecoder('latin1');
const utf8 = new TextDecoder('utf-8');
const utf16le = new TextDecoder('utf-16le');
const utf16be = new TextDecoder('utf-16be');

async function bytes(blob, start, end) {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

function clean(s) {
  return (s || '').replace(/\u0000+/g, ' ').replace(/^\uFEFF/, '').trim() || undefined;
}

export async function readTags(file) {
  try {
    const head = await bytes(file, 0, 12);
    const sig = latin1.decode(head.slice(0, 4));
    if (sig.startsWith('ID3')) return await readID3(file);
    if (sig === 'fLaC') return await readFLAC(file);
    if (latin1.decode(head.slice(4, 8)) === 'ftyp') return await readMP4(file);
  } catch (err) {
    console.warn('Tags illisibles', file.name, err);
  }
  return {};
}

/* ---------- ID3v2 ---------- */
function synchsafe(b, o) {
  return ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
}

function decodeText(enc, data) {
  if (enc === 0) return latin1.decode(data);
  if (enc === 3) return utf8.decode(data);
  if (enc === 2) return utf16be.decode(data);
  // enc 1 : UTF-16 avec BOM
  if (data[0] === 0xfe && data[1] === 0xff) return utf16be.decode(data.slice(2));
  if (data[0] === 0xff && data[1] === 0xfe) return utf16le.decode(data.slice(2));
  return utf16le.decode(data);
}

function findTerminator(data, start, enc) {
  const wide = enc === 1 || enc === 2;
  for (let i = start; i < data.length; i++) {
    if (wide) {
      if (data[i] === 0 && data[i + 1] === 0 && (i - start) % 2 === 0) return i;
    } else if (data[i] === 0) return i;
  }
  return data.length;
}

async function readID3(file) {
  const header = await bytes(file, 0, 10);
  const version = header[3];
  const size = synchsafe(header, 6);
  const tag = await bytes(file, 10, 10 + size);
  const out = {};
  let pos = 0;
  if (header[5] & 0x40) { // en-tête étendu
    const ext = version === 4 ? synchsafe(tag, 0) : (tag[0] << 24 | tag[1] << 16 | tag[2] << 8 | tag[3]) + 4;
    pos = ext;
  }
  const idLen = version === 2 ? 3 : 4;
  const headLen = version === 2 ? 6 : 10;
  const map = version === 2
    ? { TT2: 'title', TP1: 'artist', TAL: 'album', PIC: 'cover' }
    : { TIT2: 'title', TPE1: 'artist', TALB: 'album', APIC: 'cover' };

  while (pos + headLen < tag.length) {
    const id = latin1.decode(tag.slice(pos, pos + idLen));
    if (!/^[A-Z0-9]+$/.test(id)) break;
    let frameSize;
    if (version === 2) frameSize = (tag[pos + 3] << 16) | (tag[pos + 4] << 8) | tag[pos + 5];
    else if (version === 4) frameSize = synchsafe(tag, pos + 4);
    else frameSize = ((tag[pos + 4] << 24) | (tag[pos + 5] << 16) | (tag[pos + 6] << 8) | tag[pos + 7]) >>> 0;
    const data = tag.slice(pos + headLen, pos + headLen + frameSize);
    pos += headLen + frameSize;
    const key = map[id];
    if (!key || !data.length) continue;

    if (key === 'cover') {
      if (out.cover) continue;
      const enc = data[0];
      let i = 1;
      let mime = 'image/jpeg';
      if (version === 2) {
        mime = latin1.decode(data.slice(1, 4)).toLowerCase() === 'png' ? 'image/png' : 'image/jpeg';
        i = 4;
      } else {
        const end = data.indexOf(0, 1);
        mime = latin1.decode(data.slice(1, end)) || mime;
        if (!mime.includes('/')) mime = 'image/' + mime.toLowerCase();
        i = end + 1;
      }
      i += 1; // type d'image
      const descEnd = findTerminator(data, i, enc);
      i = descEnd + (enc === 1 || enc === 2 ? 2 : 1);
      out.cover = new Blob([data.slice(i)], { type: mime });
    } else {
      out[key] = clean(decodeText(data[0], data.slice(1)));
    }
  }
  return out;
}

/* ---------- FLAC ---------- */
async function readFLAC(file) {
  const out = {};
  let pos = 4;
  for (let guard = 0; guard < 64; guard++) {
    const h = await bytes(file, pos, pos + 4);
    if (h.length < 4) break;
    const last = h[0] & 0x80;
    const type = h[0] & 0x7f;
    const len = (h[1] << 16) | (h[2] << 8) | h[3];
    if (type === 4 || (type === 6 && !out.cover)) {
      const b = await bytes(file, pos + 4, pos + 4 + len);
      const dv = new DataView(b.buffer);
      if (type === 4) {
        let o = 0;
        const vendorLen = dv.getUint32(o, true); o += 4 + vendorLen;
        const count = dv.getUint32(o, true); o += 4;
        for (let i = 0; i < count && o < b.length; i++) {
          const l = dv.getUint32(o, true); o += 4;
          const entry = utf8.decode(b.slice(o, o + l)); o += l;
          const eq = entry.indexOf('=');
          const k = entry.slice(0, eq).toUpperCase();
          const v = clean(entry.slice(eq + 1));
          if (k === 'TITLE' && !out.title) out.title = v;
          if (k === 'ARTIST' && !out.artist) out.artist = v;
          if (k === 'ALBUM' && !out.album) out.album = v;
        }
      } else {
        let o = 4;
        const mimeLen = dv.getUint32(o); o += 4;
        const mime = latin1.decode(b.slice(o, o + mimeLen)); o += mimeLen;
        const descLen = dv.getUint32(o); o += 4 + descLen + 16;
        const dataLen = dv.getUint32(o); o += 4;
        out.cover = new Blob([b.slice(o, o + dataLen)], { type: mime || 'image/jpeg' });
      }
    }
    pos += 4 + len;
    if (last) break;
  }
  return out;
}

/* ---------- MP4 / M4A ---------- */
async function readMP4(file) {
  // Trouve l'atome moov au premier niveau (il peut être en fin de fichier)
  let pos = 0;
  let moov = null;
  while (pos < file.size) {
    const h = await bytes(file, pos, pos + 16);
    const dv = new DataView(h.buffer);
    let size = dv.getUint32(0);
    const type = latin1.decode(h.slice(4, 8));
    if (size === 1) size = Number(dv.getBigUint64(8));
    if (size === 0) size = file.size - pos;
    if (size < 8) break;
    if (type === 'moov') { moov = await bytes(file, pos, pos + size); break; }
    pos += size;
  }
  if (!moov) return {};

  const out = {};
  const walk = (b, start, end, path) => {
    const dv = new DataView(b.buffer, b.byteOffset);
    let o = start;
    while (o + 8 <= end) {
      const size = dv.getUint32(o);
      const type = latin1.decode(b.slice(o + 4, o + 8));
      if (size < 8 || o + size > end) break;
      const inner = o + 8;
      if (['moov', 'udta', 'ilst'].includes(type)) walk(b, inner, o + size, path.concat(type));
      else if (type === 'meta') walk(b, inner + 4, o + size, path.concat(type));
      else if (path[path.length - 1] === 'ilst') {
        // l'atome enfant « data » contient la valeur
        const dSize = dv.getUint32(inner);
        const dType = latin1.decode(b.slice(inner + 4, inner + 8));
        if (dType === 'data') {
          const flags = dv.getUint32(inner + 8) & 0xffffff;
          const payload = b.slice(inner + 16, inner + dSize);
          const key = { '\u00a9nam': 'title', '\u00a9ART': 'artist', 'aART': 'artist', '\u00a9alb': 'album' }[type];
          if (key && !out[key]) out[key] = clean(utf8.decode(payload));
          if (type === 'covr' && !out.cover) out.cover = new Blob([payload], { type: flags === 14 ? 'image/png' : 'image/jpeg' });
        }
      }
      o += size;
    }
  };
  walk(moov, 0, moov.length, []);
  return out;
}

// « Artiste - Titre.mp3 » → { artist, title }
export function guessFromFilename(name) {
  const base = name.replace(/\.[a-z0-9]+$/i, '').replace(/_/g, ' ').replace(/^\d{1,3}[\s.\-]+/, '').trim();
  const parts = base.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
  return { title: base };
}

export function probeDuration(url) {
  return new Promise((resolve) => {
    const a = new Audio();
    a.preload = 'metadata';
    const finish = (d) => { a.removeAttribute('src'); a.load(); resolve(Number.isFinite(d) ? d : 0); };
    const t = setTimeout(() => finish(0), 5000);
    a.onloadedmetadata = () => { clearTimeout(t); finish(a.duration); };
    a.onerror = () => { clearTimeout(t); finish(0); };
    a.src = url;
  });
}
