// File d'attente + lecture. Deux moteurs : <audio> (fichiers et liens)
// et le SDK Spotify. Le choix de la source est délégué à `resolve(track)`.
import * as spotify from './spotify.js';

// Son muet de 0,1 s : sert à « débloquer » le lecteur audio pendant un toucher (iPhone)
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

export class Player extends EventTarget {
  constructor({ getTrack, resolve, artFor }) {
    super();
    this.artFor = artFor;
    this.getTrack = getTrack;
    this.resolve = resolve;
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.queue = [];
    this.order = [];      // indices de lecture (mélangés ou non)
    this.pos = -1;        // position dans order
    this.shuffle = false;
    this.repeat = 'off';  // off | all | one
    this.engine = 'audio';
    this.mode = null;     // full | spotify | connect
    this.playing = false;
    this.loadingToken = 0;
    this.spState = null;
    this.volume = Number(localStorage.getItem('sillon.volume') ?? 0.9);
    this.audio.volume = this.volume;

    const a = this.audio;
    this.silentUrl = silentWavUrl();
    const isSilent = () => a.src === this.silentUrl;
    a.addEventListener('play', () => { if (!isSilent()) this.setPlaying(true); });
    a.addEventListener('pause', () => { if (!isSilent()) this.setPlaying(false); });
    a.addEventListener('timeupdate', () => { if (!isSilent()) this.emit('time'); });
    a.addEventListener('durationchange', () => { if (!isSilent()) this.emit('time'); });
    a.addEventListener('ended', () => { if (!isSilent()) this.onEnded(); });
    a.addEventListener('error', () => {
      if (this.engine !== 'audio' || !a.getAttribute('src') || isSilent()) return;
      const unsupported = a.error?.code === 4;
      this.emit('error', {
        message: unsupported
          ? 'Ce format audio n’est pas lu par ce navigateur. Sur iPhone, préfère le MP3 ou le M4A (le FLAC, l’OGG et l’Opus ne passent pas partout).'
          : 'Impossible de lire ce titre.',
      });
      this.skipAfterError();
    });

    setInterval(() => this.pollSpotify(), 1000);
    this.setupMediaSession();
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  // À appeler pendant un toucher : Safari n'autorise ensuite la lecture sur cet élément
  // même si le fichier met du temps à être prêt (lecture en mémoire, téléchargement).
  unlock() {
    const a = this.audio;
    if (this.unlocked || this.unlocking) return;
    if (a.getAttribute('src') && a.src !== this.silentUrl) return;
    this.unlocking = true;
    a.src = this.silentUrl;
    a.play()
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

  playList(ids, startId) {
    this.queue = [...ids];
    const start = Math.max(0, startId ? ids.indexOf(startId) : 0);
    this.buildOrder(start);
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

  playNext(id) {
    if (this.pos < 0) return this.playList([id]);
    this.queue.push(id);
    this.order.splice(this.pos + 1, 0, this.queue.length - 1);
    this.emit('change');
  }

  addToQueue(id) {
    if (this.pos < 0) return this.playList([id]);
    this.queue.push(id);
    this.order.push(this.queue.length - 1);
    this.emit('change');
  }

  jumpTo(offset) {
    this.pos = this.pos + 1 + offset;
    return this.load();
  }

  toggleShuffle() {
    this.shuffle = !this.shuffle;
    if (this.pos >= 0) this.buildOrder(this.order[this.pos]);
    this.emit('change');
  }

  cycleRepeat() {
    this.repeat = { off: 'all', all: 'one', one: 'off' }[this.repeat];
    this.emit('change');
  }

  async load(autoplay = true) {
    const track = this.current;
    if (!track) return;
    const token = ++this.loadingToken;
    this.emit('change');
    this.emit('loading', { loading: true });
    let source;
    let failure = null;
    try {
      source = await this.resolve(track);
    } catch (err) {
      source = null;
      failure = err.message;
      console.warn(err);
    }
    if (token !== this.loadingToken) return;
    this.emit('loading', { loading: false });

    if (!source) {
      this.emit('error', { message: failure || `Aucune source pour « ${track.title} ».` });
      return this.skipAfterError();
    }
    // Titre sans version complète disponible : on passe au suivant
    if (source.type === 'skip') {
      this.skipped = (this.skipped || 0) + 1;
      if (this.skipped >= this.order.length || !(this.pos < this.order.length - 1 || this.repeat === 'all')) {
        this.skipped = 0;
        this.stopAudio();
        this.setPlaying(false);
        this.emit('error', { message: 'Aucun titre suivant n’est disponible en version complète.' });
        return;
      }
      return this.next();
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
      if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = source.revoke ? source.url : null;
      this.audio.src = source.url;
      if (autoplay) {
        try { await this.audio.play(); } catch (err) {
          if (err.name === 'NotAllowedError') {
            // Le navigateur exige un toucher : le titre est prêt, il suffit d'appuyer sur lecture
            this.setPlaying(false);
            this.emit('blocked');
          } else if (err.name !== 'AbortError') {
            this.setPlaying(false);
          }
        }
      }
    }
    this.errorStreak = 0;
    this.emit('change');
    this.emit('track', { track });
  }

  skipAfterError() {
    this.errorStreak = (this.errorStreak || 0) + 1;
    this.setPlaying(false);
    if (this.errorStreak < 4 && this.pos < this.order.length - 1) setTimeout(() => this.next(), 600);
  }

  stopAudio() {
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
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
    if (!this.audio.getAttribute('src')) return this.load();
    if (this.audio.paused) this.audio.play().catch(() => {});
    else this.audio.pause();
  }

  next(fromEnd = false) {
    if (this.pos < 0) return;
    if (this.pos < this.order.length - 1) this.pos++;
    else if (this.repeat === 'all') this.pos = 0;
    else {
      if (fromEnd) { this.setPlaying(false); this.emit('change'); }
      return;
    }
    return this.load();
  }

  prev() {
    if (this.pos < 0) return;
    if (this.position > 3 || this.pos === 0) return this.seek(0);
    this.pos--;
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
    this.audio.volume = this.volume;
    if (this.via !== 'connect') spotify.sdkPlayer()?.setVolume(this.volume);
    try { localStorage.setItem('sillon.volume', String(this.volume)); } catch { /* ignore */ }
    this.emit('volume');
  }

  onEnded() {
    if (this.repeat === 'one') {
      this.seek(0);
      return this.engine === 'audio' ? this.audio.play() : this.remote()?.resume();
    }
    this.next(true);
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
