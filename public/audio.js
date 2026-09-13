'use strict';

// Every sound in Rambler is synthesised in the browser. Nothing is downloaded,
// nothing is licensed, and the container works with no internet — which is the
// whole point of a self-hosted arcade.
//
// Browsers refuse to make noise until the user has interacted with the page, so
// nothing here works before arm() is called from a real click or tap.

const Sound = (() => {
  let ctx = null;
  let master = null;
  let armed = false;
  let muted = localStorage.getItem('rambler.muted') === 'yes';

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  function arm() {
    if (armed) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.85;
    master.connect(ctx.destination);
    armed = true;
  }

  function ready() {
    if (!armed || !ctx) return false;
    if (ctx.state === 'suspended') ctx.resume();
    return !muted;
  }

  function setMuted(value) {
    muted = value;
    localStorage.setItem('rambler.muted', value ? 'yes' : 'no');
    if (master) master.gain.setTargetAtTime(value ? 0 : 0.85, ctx.currentTime, 0.02);
    if (value) stopRiser(), stopHeartbeat();
  }

  const now = () => ctx.currentTime;

  // ---- building blocks -----------------------------------------------------

  function env(node, { attack = 0.005, decay = 0.2, peak = 0.3, at = now() }) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(peak, at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
    node.connect(g);
    g.connect(master);
    return g;
  }

  function tone({ freq, type = 'sine', at = now(), attack = 0.005, decay = 0.2, peak = 0.3, sweepTo = null, detune = 0 }) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, at);
    o.detune.value = detune;
    if (sweepTo) o.frequency.exponentialRampToValueAtTime(sweepTo, at + attack + decay);
    env(o, { attack, decay, peak, at });
    o.start(at);
    o.stop(at + attack + decay + 0.05);
    return o;
  }

  // Short burst of filtered noise — the raw material for anything percussive.
  function noise({ at = now(), decay = 0.2, peak = 0.4, type = 'lowpass', freq = 900, q = 1 }) {
    const len = Math.max(0.05, decay + 0.1);
    const buf = ctx.createBuffer(1, ctx.sampleRate * len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filt = ctx.createBiquadFilter();
    filt.type = type;
    filt.frequency.setValueAtTime(freq, at);
    filt.Q.value = q;
    src.connect(filt);
    env(filt, { attack: 0.003, decay, peak, at });
    src.start(at);
    src.stop(at + len);
    return { src, filt };
  }

  // FM bell. Two oscillators, one modulating the other's frequency — the
  // classic way to get a metallic ring without a sample.
  function bell({ freq = 900, at = now(), decay = 0.6, peak = 0.25, ratio = 2.4, index = 380 }) {
    const carrier = ctx.createOscillator();
    const mod = ctx.createOscillator();
    const modGain = ctx.createGain();

    carrier.frequency.setValueAtTime(freq, at);
    mod.frequency.setValueAtTime(freq * ratio, at);
    modGain.gain.setValueAtTime(index, at);
    modGain.gain.exponentialRampToValueAtTime(1, at + decay);

    mod.connect(modGain);
    modGain.connect(carrier.frequency);
    env(carrier, { attack: 0.002, decay, peak, at });

    carrier.start(at); mod.start(at);
    carrier.stop(at + decay + 0.1); mod.stop(at + decay + 0.1);
  }

  // ---- the sounds ----------------------------------------------------------

  // Word accepted. Pitch climbs with length, so a seven-letter word sounds
  // like an achievement without anything having to say so.
  function word(length) {
    if (!ready()) return;
    const step = Math.min(8, Math.max(3, length)) - 3;
    const base = 520 * Math.pow(2, step / 12 * 2);
    tone({ freq: base, type: 'triangle', decay: 0.12, peak: 0.22 });
    tone({ freq: base * 1.5, type: 'sine', at: now() + 0.04, decay: 0.16, peak: 0.15 });
  }

  function reject() {
    if (!ready()) return;
    tone({ freq: 180, type: 'square', decay: 0.14, peak: 0.12, sweepTo: 90 });
  }

  function coin(at = null) {
    if (!ready()) return;
    const t = at || now();
    bell({ freq: 1480, at: t, decay: 0.22, peak: 0.14, ratio: 1.6, index: 200 });
    bell({ freq: 2100, at: t + 0.05, decay: 0.3, peak: 0.1, ratio: 1.6, index: 160 });
  }

  // Cash register: two bells over a noise chuff.
  function kaching() {
    if (!ready()) return;
    const t = now();
    noise({ at: t, decay: 0.09, peak: 0.25, type: 'bandpass', freq: 2600, q: 2 });
    bell({ freq: 1180, at: t + 0.02, decay: 0.45, peak: 0.22, ratio: 1.4, index: 260 });
    bell({ freq: 1760, at: t + 0.09, decay: 0.55, peak: 0.2, ratio: 1.4, index: 240 });
  }

  // The board is about to grow. A heavy, slow thump that speeds up — the
  // rhythm does the work, not the volume.
  let heartTimer = null;
  let heartRate = 620;
  function startHeartbeat() {
    if (!ready() || heartTimer || reduced) return;
    heartRate = 620;
    const beat = () => {
      const t = now();
      tone({ freq: 108, type: 'sine', at: t, attack: 0.008, decay: 0.16, peak: 0.5, sweepTo: 62 });
      tone({ freq: 96, type: 'sine', at: t + 0.17, attack: 0.008, decay: 0.2, peak: 0.34, sweepTo: 55 });
      heartRate = Math.max(300, heartRate - 26);
      heartTimer = setTimeout(beat, heartRate);
    };
    beat();
  }
  function stopHeartbeat() {
    clearTimeout(heartTimer);
    heartTimer = null;
  }

  // A Shepard tone: stacked octaves each sliding upward, fading in at the
  // bottom and out at the top. It climbs forever and never arrives, which is
  // exactly the "unresolved anticipation" the brief asked for.
  let riser = null;
  function startRiser(seconds = 10) {
    if (!ready() || riser || reduced) return;
    const t = now();
    const voices = [];
    const LAYERS = 4;
    const bus = ctx.createGain();
    bus.gain.setValueAtTime(0.0001, t);
    bus.gain.exponentialRampToValueAtTime(0.2, t + 0.6);
    bus.connect(master);

    for (let i = 0; i < LAYERS; i++) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      const g = ctx.createGain();
      const filt = ctx.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.value = 2600;

      const offset = i / LAYERS;
      const base = 110 * Math.pow(2, offset * 4);
      o.frequency.setValueAtTime(base, t);
      o.frequency.exponentialRampToValueAtTime(base * 8, t + seconds);

      // Fade each layer in as it starts low and out as it gets high, so no
      // single voice is ever audibly "the one that ran off the top".
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.09, t + seconds * (0.5 - offset * 0.1));
      g.gain.linearRampToValueAtTime(0.0001, t + seconds);

      o.connect(filt); filt.connect(g); g.connect(bus);
      o.start(t);
      o.stop(t + seconds + 0.2);
      voices.push(o);
    }
    riser = { voices, bus, endsAt: t + seconds };
  }
  function stopRiser() {
    if (!riser) return;
    try {
      riser.bus.gain.setTargetAtTime(0.0001, now(), 0.08);
      for (const v of riser.voices) v.stop(now() + 0.3);
    } catch { /* already stopped */ }
    riser = null;
  }

  // The grid grows. Everything the riser was promising, delivered at once.
  function bassDrop() {
    if (!ready()) return;
    stopRiser();
    stopHeartbeat();
    const t = now();
    tone({ freq: 150, type: 'sine', at: t, attack: 0.01, decay: 0.9, peak: 0.75, sweepTo: 32 });
    tone({ freq: 75, type: 'triangle', at: t, attack: 0.01, decay: 1.1, peak: 0.5, sweepTo: 28 });
    noise({ at: t, decay: 0.45, peak: 0.35, type: 'lowpass', freq: 420 });
    noise({ at: t + 0.02, decay: 0.9, peak: 0.14, type: 'highpass', freq: 5200 });
    bell({ freq: 660, at: t + 0.06, decay: 0.7, peak: 0.16, ratio: 3.1, index: 420 });
  }

  // One rung of the leaderboard climb: a heavy crush, then a ding a step
  // higher than the last. Called once per tier, in time with the animation.
  function crush(step = 0) {
    if (!ready()) return;
    const t = now();
    noise({ at: t, decay: 0.26, peak: 0.6, type: 'lowpass', freq: 260 + step * 40, q: 0.7 });
    tone({ freq: 130, type: 'square', at: t, attack: 0.004, decay: 0.16, peak: 0.42, sweepTo: 48 });
    noise({ at: t + 0.03, decay: 0.3, peak: 0.18, type: 'bandpass', freq: 1900, q: 1.4 });
    bell({ freq: 700 * Math.pow(2, step / 12), at: t + 0.07, decay: 0.4, peak: 0.2, ratio: 2.2, index: 300 });
  }

  // Brass-ish fanfare: detuned saws through a filter that opens fast.
  function fanfare() {
    if (!ready()) return;
    const t = now();
    const notes = [392, 523.25, 659.25, 784];
    notes.forEach((f, i) => {
      const at = t + i * 0.11;
      [0, -8, 8].forEach(d => {
        tone({ freq: f, type: 'sawtooth', at, attack: 0.02, decay: i === notes.length - 1 ? 1.1 : 0.3, peak: 0.13, detune: d });
      });
    });
    for (let i = 0; i < 7; i++) {
      bell({ freq: 2100 + i * 90, at: t + 0.42 + i * 0.07, decay: 0.35, peak: 0.12, ratio: 1.5, index: 220 });
    }
    setTimeout(kaching, 520);
  }

  function tick(urgent = false) {
    if (!ready()) return;
    tone({ freq: urgent ? 1400 : 900, type: 'square', decay: 0.05, peak: urgent ? 0.16 : 0.07 });
  }

  function grow() { bassDrop(); }

  return {
    arm, ready: () => armed,
    get muted() { return muted; },
    setMuted,
    word, reject, coin, kaching, tick,
    startHeartbeat, stopHeartbeat,
    startRiser, stopRiser,
    bassDrop, grow, crush, fanfare
  };
})();

window.Sound = Sound;
