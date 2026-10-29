/* ============================================================
   NOVA — shared runtime
   preloader, cursor, WebGL backdrop, particles, reveals,
   audio, tilt, magnets, accordions, nav, page transitions
   ============================================================ */
(() => {
  'use strict';

  const qs = (sel, root = document) => root.querySelector(sel);
  const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const rand = (min, max) => min + Math.random() * (max - min);
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer = window.matchMedia('(pointer: fine)').matches;

  const pointer = { x: window.innerWidth / 2, y: window.innerHeight / 2 };

  /* ---------------- audio ---------------- */
  const audio = {
    ctx: null,
    master: null,
    ambientNodes: null,
    enabled: false,

    init() {
      if (this.ctx) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.6;
      this.master.connect(this.ctx.destination);
    },

    resume() {
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    },

    tone(opts) {
      if (!this.ctx) return;
      const freq = opts.freq || 440;
      const freqEnd = opts.freqEnd || 0;
      const dur = opts.dur || 0.1;
      const type = opts.type || 'sine';
      const gain = opts.gain || 0.05;
      const delay = opts.delay || 0;
      const t0 = this.ctx.currentTime + delay;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      if (freqEnd) osc.frequency.exponentialRampToValueAtTime(Math.max(freqEnd, 1), t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g);
      g.connect(this.master);
      osc.start(t0);
      osc.stop(t0 + dur + 0.03);
    },

    noise(opts) {
      if (!this.ctx) return;
      const dur = (opts && opts.dur) || 0.3;
      const gain = (opts && opts.gain) || 0.04;
      const filter = (opts && opts.filter) || 1200;
      const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
      const buffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      const biquad = this.ctx.createBiquadFilter();
      biquad.type = 'lowpass';
      biquad.frequency.value = filter;
      const g = this.ctx.createGain();
      const now = this.ctx.currentTime;
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(gain, now + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
      src.connect(biquad);
      biquad.connect(g);
      g.connect(this.master);
      src.start(now);
      src.stop(now + dur);
    },

    hover() { this.tone({ freq: 720, freqEnd: 980, dur: 0.07, type: 'sine', gain: 0.022 }); },

    click() {
      this.tone({ freq: 190, freqEnd: 68, dur: 0.16, type: 'triangle', gain: 0.07 });
      this.noise({ dur: 0.09, gain: 0.03, filter: 1100 });
      this.tone({ freq: 880, freqEnd: 1400, dur: 0.05, type: 'sine', gain: 0.018, delay: 0.01 });
    },

    reveal() { this.tone({ freq: 520, freqEnd: 1040, dur: 0.14, type: 'sine', gain: 0.018 }); },

    startAmbient() {
      if (!this.ctx) this.init();
      if (!this.ctx || this.ambientNodes) return;
      const now = this.ctx.currentTime;
      const out = this.ctx.createGain();
      out.gain.setValueAtTime(0.0001, now);
      out.connect(this.master);

      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 380;
      filter.Q.value = 3;
      filter.connect(out);

      const nodes = [];
      [55, 82.41, 110.5].forEach((freq, i) => {
        const osc = this.ctx.createOscillator();
        osc.type = i === 2 ? 'triangle' : 'sine';
        osc.frequency.value = freq;
        const g = this.ctx.createGain();
        g.gain.value = i === 2 ? 0.12 : 0.28;
        osc.connect(g);
        g.connect(filter);
        osc.start(now);
        nodes.push(osc);
      });

      const lfo = this.ctx.createOscillator();
      lfo.frequency.value = 0.07;
      const lfoGain = this.ctx.createGain();
      lfoGain.gain.value = 150;
      lfo.connect(lfoGain);
      lfoGain.connect(filter.frequency);
      lfo.start(now);
      nodes.push(lfo);

      out.gain.exponentialRampToValueAtTime(0.045, now + 2.5);
      this.ambientNodes = { out, nodes };
    },

    stopAmbient() {
      if (!this.ctx || !this.ambientNodes) return;
      const out = this.ambientNodes.out;
      const nodes = this.ambientNodes.nodes;
      const now = this.ctx.currentTime;
      out.gain.cancelScheduledValues(now);
      out.gain.setValueAtTime(Math.max(out.gain.value, 0.0001), now);
      out.gain.exponentialRampToValueAtTime(0.0001, now + 0.9);
      setTimeout(() => {
        nodes.forEach((n) => { try { n.stop(); } catch (e) {} });
        try { out.disconnect(); } catch (e) {}
      }, 1100);
      this.ambientNodes = null;
    }
  };

  window.addEventListener('pointerdown', () => {
    audio.init();
    audio.resume();
  }, { once: true });

  /* ---------------- preloader ---------------- */
  const pre = qs('#preloader');
  const pctEl = qs('#loadPct');
  const loadBar = qs('#loadBar');
  let pct = 0;
  let bootDone = false;

  function finishBoot() {
    if (bootDone) return;
    bootDone = true;
    if (pctEl) pctEl.textContent = '100';
    if (loadBar) loadBar.style.width = '100%';
    if (pre) pre.classList.add('done');
    document.body.classList.add('loaded');
    setTimeout(() => { if (pre && pre.parentNode) pre.remove(); }, 1000);
  }

  if (pre) {
    const bootTimer = setInterval(() => {
      pct = Math.min(100, pct + rand(4, 12));
      const v = Math.floor(pct);
      if (pctEl) pctEl.textContent = String(v).padStart(3, '0');
      if (loadBar) loadBar.style.width = v + '%';
      if (v >= 100) {
        clearInterval(bootTimer);
        setTimeout(finishBoot, 360);
      }
    }, 85);
    setTimeout(finishBoot, 7000);
  } else {
    finishBoot();
  }

  /* ---------------- cursor ---------------- */
  const cursorEl = qs('.cursor');
  const dotEl = qs('.cursor-dot');
  const ringEl = qs('.cursor-ring');

  if (cursorEl && dotEl && ringEl && finePointer && !reduced) {
    document.body.classList.add('has-cursor');
    cursorEl.style.opacity = '1';
    let rx = pointer.x;
    let ry = pointer.y;

    window.addEventListener('pointermove', (e) => {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      dotEl.style.transform = 'translate3d(' + pointer.x + 'px,' + pointer.y + 'px,0)';
    }, { passive: true });

    window.addEventListener('pointerdown', () => cursorEl.classList.add('is-down'), { passive: true });
    window.addEventListener('pointerup', () => cursorEl.classList.remove('is-down'), { passive: true });

    (function cursorLoop() {
      rx = lerp(rx, pointer.x, 0.16);
      ry = lerp(ry, pointer.y, 0.16);
      ringEl.style.transform = 'translate3d(' + rx + 'px,' + ry + 'px,0)';
      requestAnimationFrame(cursorLoop);
    })();
  } else if (cursorEl) {
    cursorEl.style.display = 'none';
  }

  /* ---------------- webgl backdrop ---------------- */
  const glCanvas = qs('#gl');
  const glState = { scale: 0.75, smx: 0, smy: 0, scroll: 0 };
  let gl = null;
  let glUniforms = null;

  if (glCanvas) {
    try {
      gl = glCanvas.getContext('webgl', { alpha: false, antialias: false, powerPreference: 'high-performance' });
    } catch (err) {
      gl = null;
    }
  }

  const VERT_SRC = 'attribute vec2 aPos; void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }';

  const FRAG_SRC = [
    'precision highp float;',
    'uniform vec2 uRes;',
    'uniform float uTime;',
    'uniform vec2 uMouse;',
    'uniform float uScroll;',
    'float hash(vec2 p){',
    '  p = fract(p * vec2(123.34, 456.21));',
    '  p += dot(p, p + 45.32);',
    '  return fract(p.x * p.y);',
    '}',
    'float noise(vec2 p){',
    '  vec2 i = floor(p);',
    '  vec2 f = fract(p);',
    '  vec2 u = f * f * (3.0 - 2.0 * f);',
    '  float a = hash(i);',
    '  float b = hash(i + vec2(1.0, 0.0));',
    '  float c = hash(i + vec2(0.0, 1.0));',
    '  float d = hash(i + vec2(1.0, 1.0));',
    '  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);',
    '}',
    'float fbm(vec2 p){',
    '  float v = 0.0;',
    '  float a = 0.5;',
    '  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);',
    '  for (int i = 0; i < 5; i++){',
    '    v += a * noise(p);',
    '    p = rot * p * 2.03;',
    '    a *= 0.5;',
    '  }',
    '  return v;',
    '}',
    'void main(){',
    '  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;',
    '  vec2 m = (uMouse - 0.5 * uRes) / uRes.y;',
    '  float t = uTime * 0.075;',
    '  vec2 p = uv * 1.45;',
    '  p += 0.32 * vec2(fbm(p + t), fbm(p - t * 1.2));',
    '  float n = fbm(p * 1.7 + vec2(t * 1.3, -t));',
    '  float n2 = fbm(p * 3.1 - vec2(t * 0.9, t * 0.5));',
    '  vec3 col = vec3(0.016, 0.024, 0.04);',
    '  col += vec3(0.0, 0.85, 0.66) * pow(n, 2.4) * 0.50;',
    '  col += vec3(0.32, 0.16, 1.0) * pow(n2, 3.0) * 0.55;',
    '  float md = length(uv - m);',
    '  float glow = smoothstep(0.6, 0.0, md);',
    '  col += vec3(0.0, 0.7, 0.55) * glow * 0.16;',
    '  float band = smoothstep(0.5, 0.0, abs(uv.y + 0.15));',
    '  col += vec3(0.9, 0.08, 0.35) * band * 0.045;',
    '  float vig = smoothstep(1.65, 0.1, length(uv * vec2(0.92, 1.12)));',
    '  col *= vig;',
    '  col += (hash(gl_FragCoord.xy + uTime) - 0.5) * 0.018;',
    '  col += uScroll * 0.004;',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  function sizeGl() {
    const w = Math.max(1, Math.floor(window.innerWidth * glState.scale));
    const h = Math.max(1, Math.floor(window.innerHeight * glState.scale));
    if (glCanvas.width !== w || glCanvas.height !== h) {
      glCanvas.width = w;
      glCanvas.height = h;
      if (gl) gl.viewport(0, 0, w, h);
    }
  }

  function compileShader(type, src) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('shader error:', gl.getShaderInfoLog(shader));
      return null;
    }
    return shader;
  }

  if (gl && !reduced) {
    sizeGl();
    glState.smx = glCanvas.width / 2;
    glState.smy = glCanvas.height / 2;

    const vs = compileShader(gl.VERTEX_SHADER, VERT_SRC);
    const fs = compileShader(gl.FRAGMENT_SHADER, FRAG_SRC);
    const program = gl.createProgram();

    if (vs && fs) {
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
    }

    if (!vs || !fs || !gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('program error:', gl.getProgramInfoLog(program));
      glCanvas.style.display = 'none';
      document.body.classList.add('no-webgl');
      gl = null;
    } else {
      gl.useProgram(program);
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const aPos = gl.getAttribLocation(program, 'aPos');
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

      glUniforms = {
        res: gl.getUniformLocation(program, 'uRes'),
        time: gl.getUniformLocation(program, 'uTime'),
        mouse: gl.getUniformLocation(program, 'uMouse'),
        scroll: gl.getUniformLocation(program, 'uScroll')
      };

      (function glFrame(now) {
        sizeGl();
        const mx = pointer.x / Math.max(window.innerWidth, 1) * glCanvas.width;
        const my = pointer.y / Math.max(window.innerHeight, 1) * glCanvas.height;
        glState.smx = lerp(glState.smx, mx, 0.05);
        glState.smy = lerp(glState.smy, my, 0.05);

        gl.uniform2f(glUniforms.res, glCanvas.width, glCanvas.height);
        gl.uniform1f(glUniforms.time, now * 0.001);
        gl.uniform2f(glUniforms.mouse, glState.smx, glState.smy);
        gl.uniform1f(glUniforms.scroll, glState.scroll);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        requestAnimationFrame(glFrame);
      })(performance.now());
    }
  } else if (glCanvas) {
    glCanvas.style.display = 'none';
    document.body.classList.add('no-webgl');
  }

  /* ---------------- particles ---------------- */
  const fxCanvas = qs('#fx');
  let vw = 1;
  let vh = 1;
  let dust = [];
  const sparks = [];

  if (fxCanvas) {
    const fx = fxCanvas.getContext('2d');
    const palette = ['#00ffc3', '#7b5cff', '#ff3d81', '#eaf2ef'];

    function seedDust() {
      const count = clamp(Math.round((vw * vh) / 22000), 30, 105);
      dust = [];
      for (let i = 0; i < count; i++) {
        dust.push({
          x: Math.random() * vw,
          y: Math.random() * vh,
          vx: rand(-0.18, 0.18),
          vy: rand(-0.14, 0.14),
          r: rand(0.6, 2.1),
          a: rand(0.15, 0.5),
          c: palette[(Math.random() * 3) | 0]
        });
      }
    }

    function sizeFx() {
      vw = Math.max(1, window.innerWidth);
      vh = Math.max(1, window.innerHeight);
      const fdpr = Math.min(window.devicePixelRatio || 1, 2);
      fxCanvas.width = Math.floor(vw * fdpr);
      fxCanvas.height = Math.floor(vh * fdpr);
      fxCanvas.style.width = vw + 'px';
      fxCanvas.style.height = vh + 'px';
      fx.setTransform(fdpr, 0, 0, fdpr, 0, 0);
      seedDust();
    }
    sizeFx();

    function burst(x, y) {
      for (let i = 0; i < 20; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = rand(1.4, 6.2);
        const life = rand(18, 34);
        sparks.push({
          x, y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - 1.1,
          life, max: life,
          c: palette[(Math.random() * palette.length) | 0]
        });
      }
    }

    let fxPrev = performance.now();

    (function drawFx(now) {
      const dt = clamp((now - fxPrev) / 16.666, 0.25, 2.5);
      fxPrev = now;
      fx.clearRect(0, 0, vw, vh);
      fx.globalCompositeOperation = 'lighter';

      for (let i = 0; i < dust.length; i++) {
        const p = dust[i];
        p.x += p.vx * dt;
        p.y += p.vy * dt;

        const dx = p.x - pointer.x;
        const dy = p.y - pointer.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < 22500 && d2 > 0.01) {
          const d = Math.sqrt(d2);
          const force = (1 - d / 150) * 0.9;
          p.x += (dx / d) * force * dt;
          p.y += (dy / d) * force * dt;
        }

        if (p.x < -20) p.x = vw + 20;
        if (p.x > vw + 20) p.x = -20;
        if (p.y < -20) p.y = vh + 20;
        if (p.y > vh + 20) p.y = -20;

        fx.beginPath();
        fx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        fx.fillStyle = p.c;
        fx.globalAlpha = p.a;
        fx.fill();
      }
      fx.globalAlpha = 1;

      for (let i = 0; i < dust.length; i++) {
        for (let j = i + 1; j < dust.length; j++) {
          const a = dust[i];
          const b = dust[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < 12100) {
            const alpha = (1 - Math.sqrt(d2) / 110) * 0.16;
            fx.strokeStyle = 'rgba(0,255,195,' + alpha.toFixed(3) + ')';
            fx.lineWidth = 0.6;
            fx.beginPath();
            fx.moveTo(a.x, a.y);
            fx.lineTo(b.x, b.y);
            fx.stroke();
          }
        }
      }

      for (let i = sparks.length - 1; i >= 0; i--) {
        const s = sparks[i];
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        s.vy += 0.05 * dt;
        s.vx *= 0.985;
        s.vy *= 0.985;
        s.life -= dt;
        if (s.life <= 0) { sparks.splice(i, 1); continue; }
        const k = s.life / s.max;
        fx.globalAlpha = k;
        fx.strokeStyle = s.c;
        fx.lineWidth = 1.4;
        fx.beginPath();
        fx.moveTo(s.x, s.y);
        fx.lineTo(s.x - s.vx * 2.2, s.y - s.vy * 2.2);
        fx.stroke();
      }

      fx.globalAlpha = 1;
      fx.globalCompositeOperation = 'source-over';
      requestAnimationFrame(drawFx);
    })(performance.now());

    window.addEventListener('pointerdown', (e) => {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      burst(e.clientX, e.clientY);
    }, { passive: true });

    window.addEventListener('resize', () => {
      clearTimeout(sizeFx._t);
      sizeFx._t = setTimeout(sizeFx, 160);
    });
  }

  /* ---------------- hero text split ---------------- */
  qsa('.hero-title .line').forEach((line) => {
    const text = line.textContent.trim();
    line.textContent = '';
    let index = 0;
    for (const ch of text) {
      if (ch === ' ') {
        line.appendChild(document.createTextNode(' '));
        continue;
      }
      const span = document.createElement('span');
      span.className = 'char';
      span.textContent = ch;
      span.style.setProperty('--d', (index * 26) + 'ms');
      line.appendChild(span);
      index++;
    }
  });

  /* ---------------- reveals + counters ---------------- */
  qsa('.stagger').forEach((parent) => {
    Array.from(parent.children).forEach((child, i) => {
      child.classList.add('reveal');
      child.style.transitionDelay = (i * 90) + 'ms';
    });
  });

  function animateCount(el) {
    const target = parseFloat(el.dataset.count || '0');
    const duration = 1500;
    const start = performance.now();
    (function step(now) {
      const t = clamp((now - start) / duration, 0, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = String(Math.round(target * eased));
      if (t < 1) requestAnimationFrame(step);
    })(start);
  }

  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const el = entry.target;
      el.classList.add('in');
      if (el.dataset.count !== undefined && el.dataset.counted !== '1') {
        el.dataset.counted = '1';
        animateCount(el);
      }
      io.unobserve(el);
    });
  }, { threshold: 0.16, rootMargin: '0px 0px -6% 0px' });

  qsa('.reveal').forEach((el) => io.observe(el));
  qsa('[data-count]').forEach((el) => io.observe(el));

  /* ---------------- hover / click fx ---------------- */
  const interactiveSel = 'a,button,.card,.project,.member,.chip';
  let lastHover = null;

  document.addEventListener('pointerover', (e) => {
    const el = e.target.closest(interactiveSel);
    if (!el || el === lastHover) return;
    lastHover = el;
    if (cursorEl) cursorEl.classList.add('is-hover');
    if (audio.enabled) audio.hover();
  });

  document.addEventListener('pointerout', (e) => {
    const el = e.target.closest(interactiveSel);
    if (!el) return;
    if (el.contains(e.relatedTarget)) return;
    if (el === lastHover) lastHover = null;
    if (cursorEl) cursorEl.classList.remove('is-hover');
  });

  document.addEventListener('click', (e) => {
    const el = e.target.closest(interactiveSel);
    if (el && audio.enabled) audio.click();
  });

  /* ---------------- tilt + magnet ---------------- */
  if (!reduced) {
    qsa('[data-tilt]').forEach((card) => {
      card.addEventListener('pointermove', (e) => {
        if (e.pointerType !== 'mouse') return;
        const r = card.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width - 0.5;
        const py = (e.clientY - r.top) / r.height - 0.5;
        card.style.transform = 'perspective(900px) rotateX(' + (-py * 7).toFixed(2) + 'deg) rotateY(' + (px * 9).toFixed(2) + 'deg) translateY(-6px)';
      });
      card.addEventListener('pointerleave', () => { card.style.transform = ''; });
    });

    qsa('.magnet').forEach((el) => {
      el.addEventListener('pointermove', (e) => {
        if (e.pointerType !== 'mouse') return;
        const r = el.getBoundingClientRect();
        const dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
        const dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
        el.style.transform = 'translate(' + (dx * 7).toFixed(2) + 'px,' + (dy * 5).toFixed(2) + 'px)';
      });
      el.addEventListener('pointerleave', () => { el.style.transform = ''; });
    });
  }

  /* ---------------- sound toggle ---------------- */
  const soundBtn = qs('#soundToggle');

  function setSound(on) {
    audio.init();
    audio.resume();
    audio.enabled = on;
    if (!soundBtn) return;
    soundBtn.textContent = on ? 'Sound on' : 'Sound off';
    soundBtn.classList.toggle('on', on);
    soundBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (on) {
      audio.startAmbient();
      audio.reveal();
    } else {
      audio.stopAmbient();
    }
  }
  if (soundBtn) soundBtn.addEventListener('click', () => setSound(!audio.enabled));

  /* ---------------- accordions ---------------- */
  qsa('.acc-item').forEach((item) => {
    const trigger = qs('.acc-trigger', item);
    const panel = qs('.acc-panel', item);
    if (!trigger || !panel) return;

    function setOpen(open) {
      item.classList.toggle('open', open);
      trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
      panel.style.maxHeight = open ? panel.scrollHeight + 'px' : '0px';
    }

    trigger.addEventListener('click', () => setOpen(!item.classList.contains('open')));

    if (item.classList.contains('open')) {
      setOpen(true);
    } else {
      panel.style.maxHeight = '0px';
    }
  });

  window.addEventListener('resize', () => {
    qsa('.acc-item.open').forEach((item) => {
      const panel = qs('.acc-panel', item);
      if (panel) panel.style.maxHeight = panel.scrollHeight + 'px';
    });
  });

  /* ---------------- nav / scroll ---------------- */
  const navEl = qs('#nav');
  const progressBar = qs('#bar');
  const heroInner = qs('.hero-inner');
  let scrollQueued = false;

  function onScroll() {
    const y = window.scrollY || window.pageYOffset || 0;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    glState.scroll = max > 0 ? clamp(y / max, 0, 1) : 0;
    if (progressBar) progressBar.style.width = (glState.scroll * 100).toFixed(2) + '%';
    if (navEl) navEl.classList.toggle('scrolled', y > 30);

    if (heroInner) {
      const shift = Math.min(y * 0.16, 140);
      heroInner.style.transform = 'translate3d(0,' + shift.toFixed(2) + 'px,0)';
      heroInner.style.opacity = clamp(1 - y / 720, 0, 1).toFixed(3);
    }
    scrollQueued = false;
  }

  window.addEventListener('scroll', () => {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(onScroll);
  }, { passive: true });
  onScroll();

  /* ---------------- mobile menu ---------------- */
  const menuBtn = qs('#menuBtn');
  if (menuBtn) {
    menuBtn.addEventListener('click', () => {
      const open = document.body.classList.toggle('menu-open');
      menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    qsa('.drawer a').forEach((a) => {
      a.addEventListener('click', () => document.body.classList.remove('menu-open'));
    });
  }

  /* ---------------- active route ---------------- */
  const here = window.location.pathname.replace(/\/+$/, '') || '/';
  qsa('.nav-links a[data-page], .drawer a[data-page]').forEach((a) => {
    const target = a.getAttribute('href').replace(/\/+$/, '') || '/';
    if (target === here) a.classList.add('active');
  });

  /* ---------------- page transitions ---------------- */
  const transitionEl = qs('.page-transition');
  if (transitionEl && !reduced) {
    document.addEventListener('click', (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = e.target.closest('a[href]');
      if (!link) return;
      if (link.target === '_blank' || link.hasAttribute('download')) return;
      const href = link.getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) return;
      const url = new URL(href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && !url.hash) return;
      e.preventDefault();
      document.body.classList.add('leaving');
      setTimeout(() => { window.location.href = url.href; }, 220);
    });
    window.addEventListener('pageshow', () => document.body.classList.remove('leaving'));
  }

  /* ---------------- footer year ---------------- */
  qsa('[data-year]').forEach((el) => { el.textContent = String(new Date().getFullYear()); });

  /* ---------------- resize ---------------- */
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    pointer.x = clamp(pointer.x, 0, window.innerWidth);
    pointer.y = clamp(pointer.y, 0, window.innerHeight);
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (gl) sizeGl(); }, 160);
  });

  /* ---------------- expose for page scripts ---------------- */
  window.NOVA = { audio, reduced, pointer };
})();
