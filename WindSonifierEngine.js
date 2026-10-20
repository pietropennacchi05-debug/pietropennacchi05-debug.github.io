/**
 * WindSonifierEngine.js
 * Motore audio 3D ottimizzato per iOS / Bluefy
 * Utilizza ArrayBuffer + decodeAudioData per risolvere i bug MP3 su iPhone
 */

export class WindSonifierEngine {
  constructor() {
    this.audioCtx = null;
    this.audioBuffer = null;
    this.sourceNode = null;
    this.gainNode = null;
    this.pannerNode = null;

    this.isPlaying = false;
    this.isInitialized = false;
    this.lastDegrees = null;

    // Rate Limiter per evitare il blocco del thread su iOS
    this.lastAudioUpdate = 0;
    this.minUpdateIntervalMs = 40; // Max ~25 aggiornamenti al secondo
  }

  /**
   * Inizializza l'AudioContext e sblocca l'Audio Session di iOS
   */
  async init() {
    if (this.isInitialized) return;

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.audioCtx = new AudioContextClass({ latencyHint: 'interactive' });

    // Sblocco Audio Session su iOS con impulso silenzioso
    const buffer = this.audioCtx.createBuffer(1, 1, 22050);
    const dummySource = this.audioCtx.createBufferSource();
    dummySource.buffer = buffer;
    dummySource.connect(this.audioCtx.destination);
    dummySource.start(0);

    // Controllo Guadagno (Volume)
    this.gainNode = this.audioCtx.createGain();
    this.gainNode.gain.setValueAtTime(0, this.audioCtx.currentTime);

    // Panner 3D Spaziale (HRTF)
    this.pannerNode = this.audioCtx.createPanner();
    this.pannerNode.panningModel = 'HRTF';
    this.pannerNode.distanceModel = 'inverse';
    this.pannerNode.refDistance = 1;
    this.pannerNode.maxDistance = 10000;
    this.pannerNode.rolloffFactor = 1;

    // Connessione catena: Gain -> Panner 3D -> Output
    this.gainNode.connect(this.pannerNode);
    this.pannerNode.connect(this.audioCtx.destination);

    // Salva i nodi globalmente per evitare Garbage Collection da parte di iOS WebKit
    window._iosAudioKeepAlive = {
      ctx: this.audioCtx,
      gain: this.gainNode,
      panner: this.pannerNode
    };

    this.isInitialized = true;
  }

  /**
   * Carica e decodifica il file MP3/WAV direttamente in memoria RAM
   */
  async loadAudioFile(file) {
    if (!this.isInitialized) {
      await this.init();
    }

    if (this.isPlaying) {
      this.pause();
    }

    // Lettura del file binario come ArrayBuffer
    const arrayBuffer = await file.arrayBuffer();

    // Decodifica PCM compatibile iOS WebKit
    return new Promise((resolve, reject) => {
      this.audioCtx.decodeAudioData(
        arrayBuffer,
        (decodedBuffer) => {
          this.audioBuffer = decodedBuffer;
          resolve();
        },
        (error) => {
          reject(new Error("Errore nella decodifica del file audio MP3/M4A"));
        }
      );
    });
  }

  /**
   * Avvia la riproduzione del buffer decodificato
   */
  async play() {
    if (!this.audioCtx || !this.audioBuffer) return;

    if (this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
    }

    if (this.isPlaying) {
      this.pause();
    }

    // Creazione del nodo sorgente da Buffer (massima stabilità su iOS)
    this.sourceNode = this.audioCtx.createBufferSource();
    this.sourceNode.buffer = this.audioBuffer;
    this.sourceNode.loop = true; // Riproduzione in loop continuo
    this.sourceNode.connect(this.gainNode);

    this.sourceNode.start(0);
    this.isPlaying = true;

    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'playing';
    }
  }

  /**
   * Mette in pausa/ferma l'audio
   */
  pause() {
    if (this.sourceNode && this.isPlaying) {
      try {
        this.sourceNode.stop();
        this.sourceNode.disconnect();
      } catch (e) {
        // Ignora eventuali errori se già fermato
      }
      this.isPlaying = false;
    }
  }

  /**
   * Algoritmo di Sonificazione Vento 3D
   */
  processWindData(degrees, speedMs) {
    if (!this.isInitialized || !this.audioCtx) return null;

    const nowMs = performance.now();
    if (nowMs - this.lastAudioUpdate < this.minUpdateIntervalMs) {
      return null;
    }
    this.lastAudioUpdate = nowMs;

    const speedKnots = speedMs * 1.94384;
    const baseGain = Math.min(1.0, Math.max(0.0, speedKnots / 40.0));

    let deltaAngle = 0;
    if (this.lastDegrees !== null) {
      let diff = Math.abs(degrees - this.lastDegrees);
      if (diff > 180) diff = 360 - diff;
      deltaAngle = diff;
    }
    this.lastDegrees = degrees;

    const rotationBoost = Math.min(0.35, (deltaAngle / 45.0) * 0.25);
    const boostedGain = Math.min(1.0, baseGain + rotationBoost);

    const currentTime = this.audioCtx.currentTime;

    this.gainNode.gain.cancelScheduledValues(currentTime);
    this.gainNode.gain.setTargetAtTime(boostedGain, currentTime, 0.04);
    this.gainNode.gain.setTargetAtTime(baseGain, currentTime + 0.08, 0.30);

    const rad = degrees * (Math.PI / 180);
    const radius = 2;
    const x = parseFloat((radius * Math.sin(rad)).toFixed(2));
    const y = 0;
    const z = parseFloat((-radius * Math.cos(rad)).toFixed(2));

    if (this.pannerNode.positionX.setTargetAtTime) {
      this.pannerNode.positionX.setTargetAtTime(x, currentTime, 0.05);
      this.pannerNode.positionY.setTargetAtTime(y, currentTime, 0.05);
      this.pannerNode.positionZ.setTargetAtTime(z, currentTime, 0.05);
    } else {
      this.pannerNode.positionX.setValueAtTime(x, currentTime);
      this.pannerNode.positionY.setValueAtTime(y, currentTime);
      this.pannerNode.positionZ.setValueAtTime(z, currentTime);
    }

    return { speedKnots, x, z };
  }
}
