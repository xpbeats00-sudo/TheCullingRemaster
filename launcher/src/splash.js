// The Culling Remaster launcher: startup screen.
// Two canvases of effects around the art: fog and embers behind the mask
// (fx-back), sparks, lightning and foreground embers over everything
// (fx-front, screen-blended). A fixed timeline drives the intro; any key or
// click skips to the settled screen, and again continues once ready.
(function () {
  "use strict";

  const stage = document.getElementById("splash");
  const back = document.getElementById("fx-back").getContext("2d");
  const front = document.getElementById("fx-front").getContext("2d");
  const maskWrap = document.querySelector(".mask-wrap");
  const logoWrap = document.querySelector(".logo-wrap");
  const tagline = document.querySelector(".tagline");
  const flash = document.querySelector(".flash");
  const boot = document.querySelector(".boot");
  const bootStatus = document.querySelector(".boot-status");
  const bootPct = document.querySelector(".boot-pct");
  const bootFill = document.querySelector(".boot-fill");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const TAGLINE = "Survive. Fight. Be the last.";
  let W = 0, H = 0, DPR = 1;

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    for (const ctx of [back, front]) {
      ctx.canvas.width = Math.round(W * DPR);
      ctx.canvas.height = Math.round(H * DPR);
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    }
  }
  window.addEventListener("resize", resize);
  resize();

  const rand = (a, b) => a + Math.random() * (b - a);

  // ---------------------------------------------------------------- fog
  // A soft blob sprite, tinted per layer, drifting slowly across the stage.
  function blobSprite(r, g, b) {
    const c = document.createElement("canvas");
    c.width = c.height = 256;
    const x = c.getContext("2d");
    const grad = x.createRadialGradient(128, 128, 0, 128, 128, 128);
    grad.addColorStop(0, `rgba(${r},${g},${b},1)`);
    grad.addColorStop(0.45, `rgba(${r},${g},${b},0.35)`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    x.fillStyle = grad;
    x.fillRect(0, 0, 256, 256);
    return c;
  }
  const FOG_SPRITES = [blobSprite(120, 10, 22), blobSprite(70, 18, 120), blobSprite(40, 12, 30)];
  const fog = Array.from({ length: 11 }, (_, i) => ({
    sprite: FOG_SPRITES[i % FOG_SPRITES.length],
    x: rand(-0.2, 1.2), y: rand(0.35, 1.05),
    size: rand(0.45, 0.95),
    vx: rand(-0.006, 0.006), vy: rand(-0.002, 0.001),
    alpha: rand(0.07, 0.16),
    phase: rand(0, Math.PI * 2)
  }));

  // ---------------------------------------------------------------- embers
  function ember(front) {
    const hot = Math.random();
    return {
      x: rand(0, 1), y: rand(1.0, 1.25),
      vy: rand(0.035, 0.11) * (front ? 1.4 : 1),
      sway: rand(0.4, 1.6), swayAmp: rand(0.004, 0.02), phase: rand(0, 6.28),
      size: front ? rand(1.4, 3.2) : rand(0.6, 2.0),
      life: 0, max: rand(6, 14),
      color: hot < 0.12 ? [180, 110, 255] : hot < 0.55 ? [255, 120, 40] : [255, 50, 30]
    };
  }
  const embersBack = Array.from({ length: 110 }, () => Object.assign(ember(false), { y: rand(0, 1.2) }));
  const embersFront = Array.from({ length: 26 }, () => Object.assign(ember(true), { y: rand(0, 1.2) }));

  function drawEmbers(ctx, list, dt, t, isFront) {
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      e.life += dt;
      e.y -= e.vy * dt;
      const x = (e.x + Math.sin(t * e.sway + e.phase) * e.swayAmp) * W;
      const y = e.y * H;
      const fade = Math.min(1, e.life / 1.2) * Math.max(0, 1 - e.life / e.max);
      const flicker = 0.65 + 0.35 * Math.sin(t * 9 + e.phase * 3);
      if (e.y < -0.05 || e.life > e.max) { list[i] = ember(isFront); continue; }
      const [r, g, b] = e.color;
      const s = e.size * (isFront ? 1.5 : 1);
      ctx.fillStyle = `rgba(${r},${g},${b},${0.18 * fade * flicker})`;
      ctx.beginPath(); ctx.arc(x, y, s * 4, 0, 6.283); ctx.fill();
      ctx.fillStyle = `rgba(255,${Math.min(255, g + 90)},${Math.min(255, b + 60)},${0.9 * fade * flicker})`;
      ctx.beginPath(); ctx.arc(x, y, s, 0, 6.283); ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  // ---------------------------------------------------------------- sparks
  const sparks = [];
  function burst(cx, cy, n) {
    for (let i = 0; i < n; i++) {
      const a = rand(0, Math.PI * 2);
      const v = rand(260, 1100);
      sparks.push({ x: cx, y: cy, px: cx, py: cy, vx: Math.cos(a) * v, vy: Math.sin(a) * v * 0.6 - rand(0, 200),
        life: 0, max: rand(0.5, 1.4), hue: Math.random() < 0.2 ? 275 : rand(2, 28) });
    }
  }
  function drawSparks(ctx, dt) {
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      s.life += dt;
      if (s.life > s.max) { sparks.splice(i, 1); continue; }
      s.px = s.x; s.py = s.y;
      s.vx *= Math.pow(0.12, dt); s.vy = s.vy * Math.pow(0.12, dt) + 900 * dt;
      s.x += s.vx * dt; s.y += s.vy * dt;
      const k = 1 - s.life / s.max;
      ctx.strokeStyle = `hsla(${s.hue},100%,${55 + 30 * k}%,${k})`;
      ctx.lineWidth = 1 + 1.6 * k;
      ctx.beginPath(); ctx.moveTo(s.px, s.py); ctx.lineTo(s.x, s.y); ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  // ---------------------------------------------------------------- lightning
  const bolts = [];
  function boltPath(x0, y0, x1, y1, rough) {
    const pts = [[x0, y0]];
    const steps = 18;
    for (let i = 1; i < steps; i++) {
      const k = i / steps;
      pts.push([x0 + (x1 - x0) * k + rand(-rough, rough) * (1 - k * 0.5), y0 + (y1 - y0) * k + rand(-rough, rough) * 0.25]);
    }
    pts.push([x1, y1]);
    return pts;
  }
  function strike(x1, y1, strength) {
    const x0 = x1 + rand(-W * 0.2, W * 0.2);
    const main = boltPath(x0, -20, x1, y1, W * 0.035);
    const branches = [];
    for (let i = 0; i < 4; i++) {
      const p = main[Math.floor(rand(4, main.length - 3))];
      branches.push(boltPath(p[0], p[1], p[0] + rand(-W * 0.12, W * 0.12), p[1] + rand(H * 0.06, H * 0.2), W * 0.015));
    }
    bolts.push({ paths: [main].concat(branches), life: 0, max: 0.38, strength });
  }
  function drawBolts(ctx, dt) {
    ctx.globalCompositeOperation = "lighter";
    for (let i = bolts.length - 1; i >= 0; i--) {
      const b = bolts[i];
      b.life += dt;
      if (b.life > b.max) { bolts.splice(i, 1); continue; }
      // Two flickers over its life.
      const k = b.life / b.max;
      const on = (k < 0.25 || (k > 0.45 && k < 0.7)) ? 1 : 0.25;
      b.paths.forEach((path, j) => {
        const w = j === 0 ? 3 : 1.4;
        for (const [width, color] of [[w * 7, `rgba(150,70,255,${0.18 * on * b.strength})`],
                                      [w * 2.5, `rgba(255,90,90,${0.45 * on * b.strength})`],
                                      [w, `rgba(255,245,245,${0.95 * on * b.strength})`]]) {
          ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = "round";
          ctx.beginPath(); ctx.moveTo(path[0][0], path[0][1]);
          for (let p = 1; p < path.length; p++) ctx.lineTo(path[p][0], path[p][1]);
          ctx.stroke();
        }
      });
    }
    ctx.globalCompositeOperation = "source-over";
  }

  // ---------------------------------------------------------------- loop
  let last = performance.now();
  let startT = last;
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const t = (now - startT) / 1000;
    const intro = Math.min(1, t / 1.5);

    back.clearRect(0, 0, W, H);
    back.globalAlpha = intro;
    for (const f of fog) {
      f.x += f.vx * dt; f.y += f.vy * dt;
      if (f.x < -0.5) f.x = 1.5; if (f.x > 1.5) f.x = -0.5;
      if (f.y < 0.2) f.y = 1.1;
      const size = f.size * Math.max(W, H) * (1 + 0.06 * Math.sin(t * 0.3 + f.phase));
      back.globalAlpha = intro * f.alpha * (0.8 + 0.2 * Math.sin(t * 0.5 + f.phase));
      back.drawImage(f.sprite, f.x * W - size / 2, f.y * H - size / 2, size, size);
    }
    back.globalAlpha = intro;
    drawEmbers(back, embersBack, dt, t, false);
    back.globalAlpha = 1;

    front.clearRect(0, 0, W, H);
    drawEmbers(front, embersFront, dt, t, true);
    drawSparks(front, dt);
    drawBolts(front, dt);

    if (!reducedMotion) requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------- timeline
  const timers = [];
  const at = (ms, fn) => timers.push(setTimeout(fn, ms));
  let phase = "intro";          // intro -> booting -> ready -> leaving

  function logoCenter() {
    const r = logoWrap.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  }

  function hit() {
    const [cx, cy] = logoCenter();
    strike(cx + rand(-W * 0.05, W * 0.05), cy - H * 0.05, 1);
    flash.classList.remove("go"); void flash.offsetWidth; flash.classList.add("go");
    maskWrap.classList.add("in", "recede");
    logoWrap.classList.add("in");
    stage.classList.add("lit");
    stage.classList.remove("shake"); void stage.offsetWidth; stage.classList.add("shake");
    setTimeout(() => burst(cx, cy, 160), 120);
  }

  function typeTagline(instant) {
    tagline.innerHTML = "";
    const text = document.createElement("span");
    const caret = document.createElement("span");
    caret.className = "caret";
    tagline.append(text, caret);
    if (instant) { text.textContent = TAGLINE; return; }
    let i = 0;
    const step = () => { text.textContent = TAGLINE.slice(0, ++i); if (i < TAGLINE.length) timers.push(setTimeout(step, 46)); };
    step();
  }

  // Boot progress: the launcher drives it through window.launcher when it
  // exists (file checks, update); the browser preview simulates the steps.
  function setProgress(p, label) {
    const pct = Math.round(Math.max(0, Math.min(1, p)) * 100);
    bootFill.style.width = pct + "%";
    bootPct.textContent = pct + "%";
    if (label) bootStatus.textContent = label;
    if (pct >= 100) setReady();
  }
  function setReady() {
    if (phase === "ready" || phase === "leaving") return;
    phase = "ready";
    boot.classList.add("ready");
  }
  function simulateBoot() {
    const steps = [[0.18, "Checking game files"], [0.46, "Verifying Remaster patch"],
                   [0.72, "Contacting xplab.shop"], [0.9, "Loading profile"], [1, "Ready"]];
    steps.forEach(([p, label], i) => at(i * 520, () => setProgress(p, label)));
  }
  function startBoot() {
    if (phase !== "intro") return;
    phase = "booting";
    boot.classList.add("in");
    if (window.launcher && window.launcher.onProgress) {
      window.launcher.onProgress(setProgress);
    } else {
      simulateBoot();
    }
  }

  function scheduleGlitch() {
    timers.push(setTimeout(() => {
      logoWrap.classList.remove("glitch"); void logoWrap.offsetWidth; logoWrap.classList.add("glitch");
      if (Math.random() < 0.35) strike(rand(W * 0.1, W * 0.9), rand(H * 0.25, H * 0.55), 0.35);
      scheduleGlitch();
    }, rand(3800, 7200)));
  }

  function skipIntro() {
    timers.splice(0).forEach(clearTimeout);
    maskWrap.classList.add("in", "recede");
    logoWrap.classList.add("in");
    stage.classList.add("lit");
    typeTagline(true);
    startBoot();
    scheduleGlitch();
  }

  function leave() {
    phase = "leaving";
    timers.splice(0).forEach(clearTimeout);
    stage.classList.add("leaving");
    setTimeout(() => {
      if (window.launcher && window.launcher.splashDone) window.launcher.splashDone();
      else location.reload();          // browser preview: play it again
    }, 700);
  }

  function onInput(e) {
    if (e.type === "keydown" && (e.repeat || e.key === "Tab")) return;
    if (phase === "intro") skipIntro();
    else if (phase === "ready") leave();
  }
  window.addEventListener("keydown", onInput);
  window.addEventListener("pointerdown", onInput);

  requestAnimationFrame((now) => { last = startT = now; frame(now); });
  if (reducedMotion) {
    skipIntro();
  } else {
    at(500, () => maskWrap.classList.add("in"));
    at(1200, () => strike(rand(W * 0.15, W * 0.35), H * 0.5, 0.4));
    at(2300, hit);
    at(3000, () => typeTagline(false));
    at(3400, startBoot);
    at(4200, scheduleGlitch);
  }

  // For the launcher's main process (and debugging).
  window.Splash = { setProgress, setReady };
})();
