// Compte et sauvegarde en ligne (Supabase) : titres, playlists, fichiers audio et pochettes.
// Chaque modification locale est notée dans une « boîte d'envoi », poussée vers le compte,
// puis les changements faits sur les autres appareils sont récupérés.
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { db } from './db.js';

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
const BUCKET = 'sillon';
const MAX_FILE = 50 * 1024 * 1024; // limite du plan gratuit Supabase
const OUTBOX = 'sillon.outbox';
const CURSOR = 'sillon.cursor';
const SYNC_USER = 'sillon.syncUser';
const LAST_SYNC = 'sillon.lastSync';

let client = null;
let user = null;
let hooks = null;
let timer = 0;
let running = false;
let again = false;

const readJSON = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const writeJSON = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* stockage plein */ } };

export const isConfigured = () => Boolean(SUPABASE_URL && SUPABASE_KEY);
export const isReady = () => Boolean(client);
export const currentUser = () => user;
export const lastSync = () => Number(localStorage.getItem(LAST_SYNC)) || 0;

/* ---------- Initialisation & comptes ---------- */
export async function init(onAuth) {
  if (!isConfigured()) return null;
  try {
    const { createClient } = await import(SDK_URL);
    client = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' },
    });
  } catch (err) {
    console.warn('Supabase indisponible', err);
    return null;
  }
  client.auth.onAuthStateChange((event, session) => {
    const previous = user?.id || null;
    user = session?.user || null;
    // Ne jamais attendre d'appel Supabase dans ce rappel : on repasse par la boucle d'événements
    setTimeout(() => onAuth(event, user, previous), 0);
  });
  const { data } = await client.auth.getSession();
  user = data.session?.user || null;
  return user;
}

function needClient() {
  if (!client) throw new Error('La sauvegarde en ligne est indisponible. Vérifie ta connexion internet.');
}

function friendly(error) {
  const code = error?.code || '';
  const map = {
    invalid_credentials: 'E-mail ou mot de passe incorrect.',
    user_already_exists: 'Un compte existe déjà avec cet e-mail. Connecte-toi.',
    email_exists: 'Un compte existe déjà avec cet e-mail. Connecte-toi.',
    email_not_confirmed: 'Confirme d’abord ton adresse : clique sur le lien reçu par e-mail.',
    weak_password: 'Mot de passe trop faible : au moins 6 caractères.',
    over_email_send_rate_limit: 'Trop d’e-mails envoyés. Réessaie dans quelques minutes.',
    over_request_rate_limit: 'Trop de tentatives. Réessaie dans quelques minutes.',
    validation_failed: 'Adresse e-mail invalide.',
  };
  if (map[code]) return new Error(map[code]);
  if (/fetch|network/i.test(error?.message || '')) return new Error('Impossible de joindre le serveur. Vérifie ta connexion internet.');
  return new Error(error?.message || 'Une erreur est survenue.');
}

const siteUrl = () => location.origin + location.pathname;

export async function signUp(email, password) {
  needClient();
  const { data, error } = await client.auth.signUp({ email, password, options: { emailRedirectTo: siteUrl() } });
  if (error) throw friendly(error);
  // Supabase renvoie un compte sans identités si l'e-mail est déjà pris (confirmation activée)
  if (data.user && data.user.identities?.length === 0) throw friendly({ code: 'user_already_exists' });
  return { needsConfirmation: !data.session };
}

export async function signIn(email, password) {
  needClient();
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw friendly(error);
}

export async function signOut() {
  needClient();
  clearTimeout(timer);
  const { error } = await client.auth.signOut();
  if (error) throw friendly(error);
}

export async function resetPassword(email) {
  needClient();
  const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: siteUrl() });
  if (error) throw friendly(error);
}

export async function updatePassword(password) {
  needClient();
  const { error } = await client.auth.updateUser({ password });
  if (error) throw friendly(error);
}

/* ---------- Boîte d'envoi ---------- */
export function configure(h) { hooks = h; }

export function touch(kind, id) {
  const box = readJSON(OUTBOX, {});
  const key = `${kind}:${id}`;
  box[key] = (box[key] || 0) + 1;
  writeJSON(OUTBOX, box);
  schedule();
}

export function schedule(delay = 1500) {
  if (!user || !client) return;
  clearTimeout(timer);
  timer = setTimeout(run, delay);
}

// Après connexion : si ce compte n'a jamais été synchronisé ici, on fusionne tout
export function adoptUser() {
  if (!user) return;
  if (localStorage.getItem(SYNC_USER) !== user.id) {
    localStorage.setItem(SYNC_USER, user.id);
    localStorage.removeItem(CURSOR);
    hooks.resetCloudFlags();
    const box = readJSON(OUTBOX, {});
    for (const [kind, id] of hooks.allKeys()) box[`${kind}:${id}`] = (box[`${kind}:${id}`] || 0) + 1;
    writeJSON(OUTBOX, box);
  }
  schedule(0);
}

// « Effacer cet appareil » : on oublie l'état local, la bibliothèque reviendra du compte
export function forgetDevice() {
  localStorage.removeItem(OUTBOX);
  localStorage.removeItem(CURSOR);
}

/* ---------- Synchronisation ---------- */
export async function run() {
  if (!user || !client || !hooks) return;
  if (running) { again = true; return; }
  running = true;
  try {
    hooks.status({ state: 'sync' });
    await pushRows();
    await uploadFiles();
    await pushRows();
    await pull();
    localStorage.setItem(LAST_SYNC, String(Date.now()));
    hooks.status({ state: 'idle' });
  } catch (err) {
    console.warn('Synchronisation', err);
    const offline = !navigator.onLine || /fetch|network/i.test(err?.message || '');
    hooks.status({ state: 'error', message: offline ? 'pas de connexion internet' : (err?.message || 'erreur inconnue') });
  } finally {
    running = false;
    if (again) { again = false; schedule(300); }
  }
}

async function pushRows() {
  const box = readJSON(OUTBOX, {});
  const keys = Object.keys(box);
  if (!keys.length) return;
  const rows = keys.map((key) => {
    const i = key.indexOf(':');
    const kind = key.slice(0, i);
    const id = key.slice(i + 1);
    const data = kind === 'track' ? hooks.getTrack(id) : hooks.getPlaylist(id);
    return { user_id: user.id, kind, id, data: data || null, deleted: !data };
  });
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await client.from('library').upsert(rows.slice(i, i + 200), { onConflict: 'user_id,kind,id' });
    if (error) throw error;
  }
  // On retire seulement ce qui n'a pas été modifié pendant l'envoi
  const now = readJSON(OUTBOX, {});
  keys.forEach((key) => { if (now[key] === box[key]) delete now[key]; });
  writeJSON(OUTBOX, now);
}

async function uploadFiles() {
  const tracks = hooks.tracksToUpload();
  const total = tracks.length;
  let done = 0;
  for (const t of tracks) {
    const blob = await db.get('files', t.fileKey);
    if (!blob) continue;
    if (blob.size > MAX_FILE) {
      await hooks.patchTrack(t.id, { cloudSkip: 'too-big' });
      hooks.status({ state: 'warning', message: `« ${t.title} » dépasse 50 Mo et reste uniquement sur cet appareil.` });
      continue;
    }
    hooks.status({ state: 'upload', done, total, title: t.title });
    const { error } = await client.storage.from(BUCKET).upload(`${user.id}/audio/${t.fileKey}`, blob, {
      upsert: true, contentType: blob.type || 'audio/mpeg', cacheControl: '31536000',
    });
    if (error) throw error;
    await hooks.patchTrack(t.id, { cloudFile: true });
    done++;
  }
  if (total) hooks.status({ state: 'upload', done: total, total });

  for (const key of hooks.coversToUpload()) {
    const record = await db.get('covers', key);
    if (!record?.blob) continue;
    const { error } = await client.storage.from(BUCKET).upload(`${user.id}/covers/${key}`, record.blob, {
      upsert: true, contentType: record.blob.type || 'image/jpeg', cacheControl: '31536000',
    });
    if (error) throw error;
    await hooks.markCoverUploaded(key);
  }
}

async function pull() {
  const cursor = localStorage.getItem(CURSOR) || '1970-01-01T00:00:00Z';
  const size = 1000;
  let from = 0;
  let latest = cursor;
  for (;;) {
    const { data, error } = await client.from('library')
      .select('kind,id,data,deleted,updated_at')
      .gt('updated_at', cursor)
      .order('updated_at', { ascending: true })
      .range(from, from + size - 1);
    if (error) throw error;
    if (!data.length) break;
    latest = data[data.length - 1].updated_at;
    const pending = readJSON(OUTBOX, {});
    const incoming = data.filter((r) => !pending[`${r.kind}:${r.id}`]);
    if (incoming.length) await hooks.applyRemote(incoming);
    if (data.length < size) break;
    from += size;
  }
  localStorage.setItem(CURSOR, latest);
}

/* ---------- Fichiers ---------- */
export async function downloadAudio(fileKey) {
  if (!user || !client) return null;
  const { data, error } = await client.storage.from(BUCKET).download(`${user.id}/audio/${fileKey}`);
  return error ? null : data;
}

export async function downloadCover(key) {
  if (!user || !client) return null;
  const { data, error } = await client.storage.from(BUCKET).download(`${user.id}/covers/${key}`);
  return error ? null : data;
}

export async function removeAudio(fileKeys) {
  if (!user || !client || !fileKeys.length) return;
  await client.storage.from(BUCKET).remove(fileKeys.map((k) => `${user.id}/audio/${k}`)).catch(() => {});
}
