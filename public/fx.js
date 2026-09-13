'use strict';

// Celebration effects. One shared canvas pinned over the page, plus a couple
// of DOM overlays for the big moments.
//
// Everything here checks prefers-reduced-motion and degrades to a still,
// readable version rather than simply vanishing — a player who dislikes motion
// should still be told they won.

const Fx = (() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let canvas = null;
  let ctx = null;
  let particles = [];
  let raf = null;

  function ensureCanvas() {
    if (canvas) return;
    canvas = document.createElement('canvas');
    canvas.id = 'fxCanvas';
    document.body.appendChild(canvas);
    ctx = canvas.getContext('2d');
    resize();
    addEventListener('resize', resize);
  }

  function resize() {
    if (!canvas) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
    canvas.style.width = innerWidth + 'px';
    canvas.style.height = innerHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function css(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  // ---- particles -----------------------------------------------------------

  // Confetti rains from above; coins are thrown from the middle toward the
  // viewer, growing as they come, then settle at the bottom of the screen.
  function burst({ count = 150, coins = 0, origin = null, palette = null } = {}) {
    ensureCanvas();
    const pink = css('--vice-pink', '#ff2ec4');
    const teal = css('--vice-teal', '#00ffc2');
    const gold = '#ffd23f';
    const colors = palette || [pink, pink, teal, teal, gold, '#f5eaff'];

    const n = reduced ? Math.min(28, count) : count;
    const cx = origin ? origin.x : innerWidth / 2;
    const cy = origin ? origin.y : innerHeight / 2;

    for (let i = 0; i < n; i++) {
      particles.push({
        kind: 'confetti',
        x: Math.random() * innerWidth,
        y: -20 - Math.random() * innerHeight * 0.35,
        w: 6 + Math.random() * 6,
        h: 4 + Math.random() * 8,
        vy: 2.4 + Math.random() * 3.4,
        vx: -1.6 + Math.random() * 3.2,
        rot: Math.random() * Math.PI,
        vr: -0.22 + Math.random() * 0.44,
        color: colors[(Math.random() * colors.length) | 0],
        life: 0,
        maxLife: 170 + Math.random() * 70
      });
    }

    const coinCount = reduced ? Math.min(10, coins) : coins;
    for (let i = 0; i < coinCount; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 2 + Math.random() * 6;
      particles.push({
        kind: 'coin',
        x: cx,
        y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 3,
        z: 0.25 + Math.random() * 0.4,
        vz: 0.012 + Math.random() * 0.02,
        spin: Math.random() * Math.PI,
        vspin: 0.15 + Math.random() * 0.2,
        settled: false,
        life: 0,
        maxLife: 240 + Math.random() * 80
      });
    }

    if (!raf) tick();
  }

  function drawCoin(p) {
    const r = 9 * p.z;
    // A coin seen edge-on is an ellipse; spinning it just squashes the width.
    const squash = Math.abs(Math.cos(p.spin));
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.scale(Math.max(0.08, squash), 1);
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    const grad = ctx.createLinearGradient(-r, -r, r, r);
    grad.addColorStop(0, '#ffe98a');
    grad.addColorStop(0.45, '#ffc72c');
    grad.addColorStop(1, '#b8790a');
    ctx.fillStyle = grad;
    ctx.shadowColor = '#ffc72c';
    ctx.shadowBlur = 12 * p.z;
    ctx.fill();
    ctx.lineWidth = Math.max(1, 1.6 * p.z);
    ctx.strokeStyle = 'rgba(255,246,200,.85)';
    ctx.stroke();
    ctx.restore();
  }

  function tick() {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    let alive = false;
    const floor = innerHeight - 14;

    for (const p of particles) {
      p.life++;
      if (p.life > p.maxLife) continue;
      alive = true;
      const fade = p.life > p.maxLife - 40 ? (p.maxLife - p.life) / 40 : 1;

      if (p.kind === 'confetti') {
        p.x += p.vx; p.y += p.vy; p.rot += p.vr;
        ctx.save();
        ctx.globalAlpha = Math.max(0, fade);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.shadowColor = p.color;
        ctx.shadowBlur = 8;
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      } else {
        if (!p.settled) {
          p.x += p.vx; p.y += p.vy;
          p.vy += 0.28;                 // gravity
          p.z = Math.min(1.6, p.z + p.vz);
          p.spin += p.vspin;
          if (p.x < 12 || p.x > innerWidth - 12) p.vx *= -0.7;   // bounce off frame
          if (p.y >= floor) { p.y = floor; p.settled = true; p.vspin = 0; }
        }
        ctx.globalAlpha = Math.max(0, fade);
        drawCoin(p);
        ctx.globalAlpha = 1;
      }
    }

    if (alive) {
      raf = requestAnimationFrame(tick);
    } else {
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      particles = [];
      raf = null;
    }
  }

  // ---- overlays ------------------------------------------------------------

  // Full-screen announcement. Used sparingly: an eight-letter word, a
  // milestone, a personal best. If it fires often it stops meaning anything.
  function banner(title, sub = '', { ms = 1800, tone = 'gold' } = {}) {
    ensureCanvas();
    const el = document.createElement('div');
    el.className = `fx-banner tone-${tone}`;
    el.innerHTML = '<div class="fx-banner-inner"><div class="fx-title"></div><div class="fx-sub"></div></div>';
    el.querySelector('.fx-title').textContent = title;
    el.querySelector('.fx-sub').textContent = sub;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('on'));
    setTimeout(() => {
      el.classList.remove('on');
      setTimeout(() => el.remove(), 400);
    }, ms);
    return el;
  }

  function flash(color = null) {
    if (reduced) return;
    const el = document.createElement('div');
    el.className = 'fx-flash';
    if (color) el.style.background = color;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('on'));
    setTimeout(() => el.remove(), 460);
  }

  // A number that flies from where it was earned to where it is counted --
  // so a player sees *why* the clock jumped.
  function flyTo(text, fromEl, toEl, { tone = 'teal' } = {}) {
    if (!fromEl || !toEl || reduced) return;
    const a = fromEl.getBoundingClientRect();
    const b = toEl.getBoundingClientRect();
    const el = document.createElement('div');
    el.className = `fx-fly tone-${tone}`;
    el.textContent = text;
    el.style.left = (a.left + a.width / 2) + 'px';
    el.style.top = (a.top + a.height / 2) + 'px';
    document.body.appendChild(el);
    requestAnimationFrame(() => {
      el.style.transform =
        `translate(-50%,-50%) translate(${b.left + b.width / 2 - a.left - a.width / 2}px, ${b.top + b.height / 2 - a.top - a.height / 2}px) scale(.7)`;
      el.style.opacity = '0';
    });
    setTimeout(() => el.remove(), 900);
  }

  // Rolls a number up rather than snapping it. Slot machines do this because
  // watching a total climb is more satisfying than seeing it appear.
  function countUp(el, from, to, ms = 600) {
    if (reduced || from === to) { el.textContent = String(to); return; }
    const start = performance.now();
    const step = t => {
      const k = Math.min(1, (t - start) / ms);
      const eased = 1 - Math.pow(1 - k, 3);
      el.textContent = String(Math.round(from + (to - from) * eased));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ---- the escalation ladder ----------------------------------------------

  // Smashes a marker up through a stack of rows, one at a time, calling back
  // on each so the sound lands on the same frame as the hit. `rows` is an
  // array of elements ordered worst-to-best; `stopAt` is the index to land on.
  function climb(rows, stopAt, { onStep = null, onDone = null, stepMs = 320 } = {}) {
    if (!rows.length) { onDone && onDone(); return; }
    if (reduced) {
      rows.forEach((r, i) => r.classList.toggle('smashed', i < stopAt));
      if (rows[stopAt]) rows[stopAt].classList.add('landed');
      onDone && onDone();
      return;
    }

    // Climbs from the bottom of the board upward, shattering each score the
    // run actually beat, and stops where it genuinely placed. Rows above the
    // landing are left untouched -- those are the ones still to beat, and
    // dimming them would be telling the player a lie about what they did.
    let i = 0;
    const stepOnce = () => {
      if (i >= stopAt) {
        const target = rows[stopAt];
        if (target) {
          target.classList.add('landed');
          target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
        onDone && onDone();
        return;
      }
      rows[i].classList.add('smashed');
      debris(rows[i]);
      onStep && onStep(i, i);
      i++;
      setTimeout(stepOnce, stepMs);
    };
    stepOnce();
  }

  // Glowing shards thrown off a row as the climb shatters it.
  function debris(row) {
    ensureCanvas();
    const r = row.getBoundingClientRect();
    const gold = '#ffd23f';
    const pink = css('--vice-pink', '#ff2ec4');
    for (let i = 0; i < 14; i++) {
      particles.push({
        kind: 'confetti',
        x: r.left + Math.random() * r.width,
        y: r.top + r.height / 2,
        w: 3 + Math.random() * 5,
        h: 2 + Math.random() * 4,
        vy: -3 - Math.random() * 3,
        vx: -3 + Math.random() * 6,
        rot: Math.random() * Math.PI,
        vr: -0.4 + Math.random() * 0.8,
        color: Math.random() > 0.5 ? gold : pink,
        life: 0,
        maxLife: 50 + Math.random() * 30
      });
    }
    if (!raf) tick();
  }

  return { burst, banner, flash, flyTo, countUp, climb, reduced };
})();

window.Fx = Fx;
