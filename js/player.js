// File d'attente + lecture. Deux moteurs : <audio> (fichiers et liens)
// et le SDK Spotify. Le choix de la source est délégué à `resolve(track)`.
//
// Le moteur audio utilise deux lecteurs (« platines ») pour enchaîner les titres en fondu :
// le suivant est préparé à l'avance, démarre sur la platine libre et monte pendant que
// l'autre descend.
import * as spotify from './spotify.js';

// Son muet de 0,1 s : sert à « débloquer » les lecteurs audio pendant un toucher (iPhone)
function silentWavUrl() {
  const rate = 8000;
  const samples = 800;
  const buf = new ArrayBuffer(44 + samples);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + samples, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  str(36, 'data'); v.setUint32(40, samples, true);
  for (let i = 0; i < samples; i++) v.setUint8(44 + i, 128);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

// Sur iPhone, le volume d'un <audio> n'est pas réglable : pas de fondu possible
const CAN_FADE = (() => { const a = new Audio(); a.volume = 0.5; return a.volume === 0.5; })();
const SWITCH_FADE_OUT = 280; // changement de titre manuel
const SWITCH_FADE_IN = 420;

export class Player extends EventTarget {
  constructor({ getTrack, resolve, artFor, crossfade, canPlay }) {
    super();
    this.canPlay = canPlay || (() => true);
    this.artFor = artFor;
    this.getTrack = getTrack;
    this.resolve = resolve;
    this.crossfadeSeconds = crossfade || (() => 0);
    this.canFade = CAN_FADE;
    this.queue = [];
    this.order = [];      // indices de lecture (mélangés ou non)
    this.pos = -1;        // position dans order
    this.shuffle = false;
    this.repeat = 'off';  // off | all | one
    this.engine = 'audio';
    this.mode = null;     // full | spotify | connect
    this.playing = false;
    this.direction = 1;   // 1 : titre suivant, -1 : précédent (pour les animations)
    this.loadingToken = 0;
    this.spState = null;
    this.preload = null;
    this.volume = Number(localStorage.getItem('sillon.volume') ?? 0.9);
    this.silentUrl = silentWavUrl();

    this.decks = [this.createDeck(), this.createDeck()];
    this.active = 0;

    setInterval(() => this.pollSpotify(), 1000);
    this.setupMediaSession();
  }

  createDeck() {
    const a = new Audio();
    a.preload = 'auto';
    a.volume = this.volume;
    const isActive = () => a === this.audio && a.src !== this.silentUrl;
    a.addEventListener('play', () => { if (isActive()) this.setPlaying(true); });
    a.addEventListener('pause', () => { if (isActive()) this.setPlaying(false); });
    a.addEventListener('timeupdate', () => {
      if (!isActive()) return;
      this.emit('time');
      this.checkCrossfade();
    });
    a.addEventListener('durationchange', () => { if (isActive()) this.emit('time'); });
    a.addEventListener('ended', () => { if (isActive()) this.onEnded(); });
    a.addEventListener('error', () => {
      if (!isActive() || this.engine !== 'audio' || !a.getAttribute('src')) return;
      const unsupported = a.error?.code === 4;
      this.emit('error', {
        message: unsupported
          ? 'Ce format audio n’est pas lu par ce navigateur. Sur iPhone, préfère le MP3 ou le M4A (le FLAC, l’OGG et l’Opus ne passent pas partout).'
          : 'Impossible de lire ce titre.',
      });
      this.skipAfterError();
    });
    return a;
  }

  get audio() { return this.decks[this.active]; }
  get spare() { return this.decks[1 - this.active]; }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  // À appeler pendant un toucher : Safari n'autorise ensuite la lecture sur ces éléments
  // même si le fichier met du temps à être prêt (lecture en mémoire, téléchargement).
  unlock() {
    if (this.unlocked || this.unlocking) return;
    const idle = this.decks.filter((a) => !a.getAttribute('src') || a.src === this.silentUrl);
    if (!idle.length) { this.unlocked = true; return; }
    this.unlocking = true;
    Promise.all(idle.map((a) => { a.src = this.silentUrl; return a.play(); }))
      .then(() => { this.unlocked = true; })
      .catch(() => {}) // pas un geste valable (ex. début d'un toucher) : on réessaiera au suivant
      .finally(() => { this.unlocking = false; });
  }

  get current() { return this.pos >= 0 ? this.getTrack(this.queue[this.order[this.pos]]) : null; }
  get upcoming() { return this.order.slice(this.pos + 1).map((i) => this.queue[i]); }

  get position() {
    if (this.engine === 'spotify') {
      const s = this.spState;
      if (!s) return 0;
      return (s.position + (s.paused ? 0 : Date.now() - s.at)) / 1000;
    }
    return this.audio.currentTime || 0;
  }

  get duration() {
    if (this.engine === 'spotify') return (this.spState?.duration || 0) / 1000;
    const d = this.audio.duration;
    return Number.isFinite(d) && d > 0 ? d : (this.current?.duration || 0);
  }

  setPlaying(v) {
    if (this.playing === v) return;
    this.playing = v;
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = v ? 'playing' : 'paused';
    this.emit('change');
  }

  /* ---------- File d'attente ---------- */
  playList(ids, startId) {
    this.queue = [...ids];
    const start = Math.max(0, startId ? ids.indexOf(startId) : 0);
    this.buildOrder(start);
    this.direction = 1;
    return this.load();
  }

  // Construit l'ordre de lecture et place la position sur `first`
  buildOrder(first) {
    if (this.shuffle) {
      const idx = this.queue.map((_, i) => i).filter((i) => i !== first);
      for (let i = idx.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [idx[i], idx[j]] = [idx[j], idx[i]];
      }
      this.order = [first, ...idx];
      this.pos = 0;
    } else {
      this.order = this.queue.map((_, i) => i);
      this.pos = first;
    }
  }

  queueChanged() {
    this.emit('change');
    this.preloadNext();
  }

  playNext(id) {
    if (this.pos < 0) return this.playList([id]);
    this.queue.push(id);
    this.order.splice(this.pos + 1, 0, this.queue.length - 1);
    this.queueChanged();
  }

  addToQueue(id) {
    if (this.pos < 0) return this.playList([id]);
    this.queue.push(id);
    this.order.push(this.queue.length - 1);
    this.queueChanged();
  }

  jumpTo(offset) {
    this.pos = this.pos + 1 + offset;
    this.direction = 1;
    return this.load();
  }

  toggleShuffle() {
    this.shuffle = !this.shuffle;
    if (this.pos >= 0) this.buildOrder(this.order[this.pos]);
    this.queueChanged();
  }

  cycleRepeat() {
    this.repeat = { off: 'all', all: 'one', one: 'off' }[this.repeat];
    this.queueChanged();
  }

  // Prochain titre lisible (les titres sans source sont sautés sans être chargés)
  nextIndex() {
    if (this.pos < 0) return -1;
    const n = this.order.length;
    for (let step = 1; step < n || (step === n && this.repeat === 'all'); step++) {
      const i = this.pos + step;
      if (i >= n && this.repeat !== 'all') break;
      const idx = i % n;
      if (idx === this.pos && step < n) continue;
      if (this.canPlay(this.getTrack(this.queue[this.order[idx]]))) return idx;
    }
    return -1;
  }

  prevIndex() {
    for (let i = this.pos - 1; i >= 0; i--) {
      if (this.canPlay(this.getTrack(this.queue[this.order[i]]))) return i;
    }
    return -1;
  }

  /* ---------- Préchargement du titre suivant ---------- */
  preloadNext() {
    const i = this.nextIndex();
    const id = i >= 0 ? this.queue[this.order[i]] : null;
    if (this.preload?.id === id) return;
    this.dropPreload();
    if (!id) return;
    const track = this.getTrack(id);
    if (!track) return;
    this.preload = { id, promise: Promise.resolve().then(() => this.resolve(track)).catch(() => null) };
  }

  // Préchargement devenu inutile (file modifiée) : on libère le fichier en mémoire
  dropPreload() {
    const p = this.preload;
    this.preload = null;
    p?.promise.then((s) => { if (s?.revoke) URL.revokeObjectURL(s.url); });
  }

  async takePreloaded(track) {
    const p = this.preload;
    if (!p || p.id !== track.id) return null;
    this.preload = null;
    return p.promise;
  }

  /* ---------- Fondus ---------- */
  // Rampe de volume basée sur le temps réel (fonctionne aussi écran verrouillé)
  ramp(deck, to, ms, done) {
    clearInterval(deck.rampTimer);
    const from = deck.gain ?? 1;
    const start = performance.now();
    const step = () => {
      const t = Math.min(1, (performance.now() - start) / ms);
      const eased = t * t * (3 - 2 * t);
      deck.gain = from + (to - from) * eased;
      deck.volume = Math.max(0, Math.min(1, this.volume * deck.gain));
      if (t >= 1) {
        clearInterval(deck.rampTimer);
        deck.rampTimer = 0;
        done?.();
      }
    };
    if (!ms || !this.canFade) { deck.gain = to; deck.volume = this.volume * to; done?.(); return; }
    step();
    deck.rampTimer = setInterval(step, 30);
  }

  fadeOutAndStop(deck, ms) {
    if (deck.paused || !this.canFade) { deck.pause(); return; }
    this.ramp(deck, 0, ms, () => { if (deck !== this.audio) deck.pause(); });
  }

  checkCrossfade() {
    const seconds = this.crossfadeSeconds();
    if (!seconds || !this.canFade || this.engine !== 'audio' || this.repeat === 'one' || this.autoAdvancing) return;
    const a = this.audio;
    const d = a.duration;
    if (!Number.isFinite(d) || d < seconds * 2 + 5 || a.paused) return;
    if (d - a.currentTime > seconds + 20) return;
    this.preloadNext();
    if (a.currentTime >= d - seconds && this.nextIndex() >= 0) {
      this.autoAdvancing = true;
      this.next(true, 'crossfade');
    }
  }

  /* ---------- Chargement ---------- */
  async load(transition = 'switch') {
    const track = this.current;
    if (!track) return;
    const token = ++this.loadingToken;
    this.emit('change');
    let source;
    let failure = null;
    this.emit('loading', { loading: true });
    try {
      source = (await this.takePreloaded(track)) || (await this.resolve(track));
    } catch (err) {
      source = null;
      failure = err.message;
      console.warn(err);
    }
    if (token !== this.loadingToken) { if (source?.revoke) URL.revokeObjectURL(source.url); return; }
    this.emit('loading', { loading: false });
    this.autoAdvancing = false;

    if (!source) {
      this.emit('error', { message: failure || `Aucune source pour « ${track.title} ».` });
      return this.skipAfterError();
    }
    // Titre sans version complète disponible : on passe au suivant
    if (source.type === 'skip') {
      this.skipped = (this.skipped || 0) + 1;
      if (this.skipped >= this.order.length || this.nextIndex() < 0) {
        this.skipped = 0;
        this.stopAudio();
        this.setPlaying(false);
        this.emit('error', { message: 'Aucun titre suivant n’est disponible en version complète.' });
        return;
      }
      return this.next(false, transition);
    }
    this.skipped = 0;

    this.updateMediaSession(track);
    if (source.type === 'spotify') {
      this.stopAudio();
      this.engine = 'spotify';
      this.via = source.via;
      this.mode = source.via === 'connect' ? 'connect' : 'spotify';
      this.expectedUri = source.uri;
      this.spState = { position: 0, duration: track.duration * 1000, paused: false, at: Date.now() };
      try {
        if (source.via === 'connect') {
          const device = await spotify.connectPlay(source.uri);
          this.deviceName = device.name;
        } else {
          await spotify.playUri(source.uri, (s) => this.onSpotifyState(s));
        }
        this.setPlaying(true);
      } catch (err) {
        if (token !== this.loadingToken) return;
        this.engine = 'audio';
        this.emit('error', { message: err.message });
        return this.skipAfterError();
      }
    } else {
      this.pauseSpotify();
      this.engine = 'audio';
      this.mode = source.mode;
      await this.startOnSpare(source, transition);
    }
    this.errorStreak = 0;
    this.emit('change');
    this.emit('track', { track });
    this.preloadNext();
  }

  // Démarre la source sur la platine libre, puis fond l'ancienne
  async startOnSpare(source, transition) {
    const old = this.audio;
    const deck = this.spare;
    const oldAudible = !old.paused && old.getAttribute('src') && old.src !== this.silentUrl;
    const crossfade = transition === 'crossfade' ? this.crossfadeSeconds() * 1000 : 0;

    clearInterval(deck.rampTimer);
    if (deck.objectUrl && deck.objectUrl !== source.url) URL.revokeObjectURL(deck.objectUrl);
    deck.objectUrl = source.revoke ? source.url : null;
    deck.src = source.url;
    this.active = this.decks.indexOf(deck);

    const fadeIn = oldAudible && this.canFade ? (crossfade || SWITCH_FADE_IN) : 0;
    deck.gain = fadeIn ? 0 : 1;
    deck.volume = this.volume * deck.gain;

    try {
      await deck.play();
    } catch (err) {
      if (err.name === 'NotAllowedError' && oldAudible) {
        // Démarrage refusé en arrière-plan : on réutilise le lecteur déjà en cours
        this.active = this.decks.indexOf(old);
        clearInterval(old.rampTimer);
        old.src = source.url;
        old.objectUrl = deck.objectUrl;
        deck.objectUrl = null;
        deck.removeAttribute('src');
        old.gain = 1;
        old.volume = this.volume;
        try { await old.play(); return; } catch { /* on tombe sur le cas général */ }
      }
      if (err.name === 'NotAllowedError') {
        this.setPlaying(false);
        this.emit('blocked');
      } else if (err.name !== 'AbortError') {
        this.setPlaying(false);
      }
      if (oldAudible) old.pause();
      return;
    }
    if (oldAudible) this.fadeOutAndStop(old, crossfade || SWITCH_FADE_OUT);
    else if (old !== deck) old.pause();
    if (fadeIn) this.ramp(deck, 1, fadeIn);
  }

  skipAfterError() {
    this.errorStreak = (this.errorStreak || 0) + 1;
    this.autoAdvancing = false;
    this.setPlaying(false);
    if (this.errorStreak < 4 && this.pos < this.order.length - 1) setTimeout(() => this.next(), 600);
  }

  stopAudio() {
    this.decks.forEach((a) => {
      clearInterval(a.rampTimer);
      a.pause();
      a.removeAttribute('src');
      a.load();
    });
  }

  // Lecteur Spotify en cours : SDK (navigateur) ou Connect (app Spotify)
  remote() {
    return this.via === 'connect' ? spotify.connectPlayer : spotify.sdkPlayer();
  }

  pauseSpotify() {
    if (this.engine === 'spotify') this.remote()?.pause();
  }

  toggle() {
    if (!this.current) return;
    if (this.engine === 'spotify') {
      this.remote()?.togglePlay();
      if (this.via === 'connect' && this.spState) {
        Object.assign(this.spState, { position: this.position * 1000, paused: this.playing, at: Date.now() });
        this.setPlaying(!this.playing);
      }
      return;
    }
    const a = this.audio;
    if (!a.getAttribute('src') || a.src === this.silentUrl) return this.load();
    if (a.paused) {
      clearInterval(a.rampTimer);
      a.gain = 1;
      a.volume = this.volume;
      a.play().catch(() => {});
    } else {
      this.spare.pause(); // coupe aussi un fondu en cours
      a.pause();
    }
  }

  next(fromEnd = false, transition = 'switch') {
    const i = this.nextIndex();
    if (i < 0) {
      if (fromEnd) { this.autoAdvancing = false; this.setPlaying(false); this.emit('change'); }
      return;
    }
    this.pos = i;
    this.direction = 1;
    return this.load(transition);
  }

  prev() {
    if (this.pos < 0) return;
    const i = this.prevIndex();
    if (this.position > 3 || i < 0) return this.seek(0);
    this.pos = i;
    this.direction = -1;
    return this.load();
  }

  seek(sec) {
    if (this.engine === 'spotify') {
      this.remote()?.seek(Math.round(sec * 1000));
      if (this.spState) Object.assign(this.spState, { position: sec * 1000, at: Date.now() });
    } else if (Number.isFinite(this.audio.duration)) {
      this.audio.currentTime = Math.min(sec, this.audio.duration - 0.1);
    }
    this.emit('time');
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    this.decks.forEach((a) => { a.volume = Math.max(0, Math.min(1, this.volume * (a.gain ?? 1))); });
    if (this.via !== 'connect') spotify.sdkPlayer()?.setVolume(this.volume);
    try { localStorage.setItem('sillon.volume', String(this.volume)); } catch { /* ignore */ }
    this.emit('volume');
  }

  onEnded() {
    if (this.repeat === 'one') {
      this.seek(0);
      return this.engine === 'audio' ? this.audio.play() : this.remote()?.resume();
    }
    if (this.autoAdvancing) return; // le fondu enchaîné a déjà lancé le suivant
    this.next(true, 'gapless');
  }

  onSpotifyState(s) {
    if (!s || this.engine !== 'spotify') return;
    const prev = this.spState;
    this.spState = { position: s.position, duration: s.duration, paused: s.paused, at: Date.now() };
    this.setPlaying(!s.paused);
    // Fin de titre : Spotify repasse en pause à 0, ou enchaîne sur un autre titre (lecture auto)
    const nearEnd = prev && prev.duration - prev.position < 4000;
    if (prev && !prev.paused && s.paused && s.position === 0 && nearEnd) this.onEnded();
    else if (this.via === 'connect' && s.uri && s.uri !== this.expectedUri && nearEnd) this.onEnded();
  }

  async pollSpotify() {
    if (this.engine !== 'spotify' || !this.playing) return;
    this.pollTick = (this.pollTick || 0) + 1;
    if (this.via === 'connect' && this.pollTick % 2) { this.emit('time'); return; }
    const s = await this.remote()?.getCurrentState();
    if (s) this.onSpotifyState(s);
    this.emit('time');
  }

  setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const set = (action, fn) => { try { ms.setActionHandler(action, fn); } catch { /* non supporté */ } };
    set('play', () => this.toggle());
    set('pause', () => this.toggle());
    set('previoustrack', () => this.prev());
    set('nexttrack', () => this.next());
    set('seekto', (e) => this.seek(e.seekTime));
    set('seekbackward', () => this.seek(Math.max(0, this.position - 10)));
    set('seekforward', () => this.seek(this.position + 10));
    this.addEventListener('time', () => {
      const d = this.duration;
      if (!d || !ms.setPositionState) return;
      try { ms.setPositionState({ duration: d, position: Math.min(this.position, d), playbackRate: 1 }); } catch { /* ignore */ }
    });
  }

  updateMediaSession(track) {
    if (!('mediaSession' in navigator)) return;
    const src = this.artFor?.(track);
    const art = src ? [{ src, sizes: '512x512' }] : [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }];
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title || 'Sans titre',
      artist: track.artist || '',
      album: track.album || '',
      artwork: art,
    });
  }
}
