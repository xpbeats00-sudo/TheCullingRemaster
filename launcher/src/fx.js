// The Culling Remaster launcher: ambient effects shared by the startup screen
// and the launcher - drifting fog and rising embers on a back canvas, larger
// embers on a front (screen-blended) canvas. Ambient.draw(...) once a frame.
(function () {
  "use strict";

  const rand = (a, b) => a + Math.random() * (b - a);

  // A soft blob sprite, tinted per fog layer.
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

  function ember(isFront) {
    const hot = Math.random();
    return {
      x: rand(0, 1), y: rand(1.0, 1.25),
      vy: rand(0.035, 0.11) * (isFront ? 1.4 : 1),
      sway: rand(0.4, 1.6), swayAmp: rand(0.004, 0.02), phase: rand(0, 6.28),
      size: isFront ? rand(1.4, 3.2) : rand(0.6, 2.0),
      life: 0, max: rand(6, 14),
      color: hot < 0.12 ? [180, 110, 255] : hot < 0.55 ? [255, 120, 40] : [255, 50, 30]
    };
  }

  function drawEmbers(ctx, list, dt, t, W, H, isFront) {
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      e.life += dt;
      e.y -= e.vy * dt;
      if (e.y < -0.05 || e.life > e.max) { list[i] = ember(isFront); continue; }
      const x = (e.x + Math.sin(t * e.sway + e.phase) * e.swayAmp) * W;
      const y = e.y * H;
      const fade = Math.min(1, e.life / 1.2) * Math.max(0, 1 - e.life / e.max);
      const flicker = 0.65 + 0.35 * Math.sin(t * 9 + e.phase * 3);
      const [r, g, b] = e.color;
      const s = e.size * (isFront ? 1.5 : 1);
      ctx.fillStyle = `rgba(${r},${g},${b},${0.18 * fade * flicker})`;
      ctx.beginPath(); ctx.arc(x, y, s * 4, 0, 6.283); ctx.fill();
      ctx.fillStyle = `rgba(255,${Math.min(255, g + 90)},${Math.min(255, b + 60)},${0.9 * fade * flicker})`;
      ctx.beginPath(); ctx.arc(x, y, s, 0, 6.283); ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  // density scales the ember counts (1 = startup screen).
  function Ambient(density = 1) {
    const sprites = [blobSprite(120, 10, 22), blobSprite(70, 18, 120), blobSprite(40, 12, 30)];
    this.fog = Array.from({ length: 11 }, (_, i) => ({
      sprite: sprites[i % sprites.length],
      x: rand(-0.2, 1.2), y: rand(0.35, 1.05), size: rand(0.45, 0.95),
      vx: rand(-0.006, 0.006), vy: rand(-0.002, 0.001),
      alpha: rand(0.07, 0.16), phase: rand(0, Math.PI * 2)
    }));
    this.back = Array.from({ length: Math.round(110 * density) }, () => Object.assign(ember(false), { y: rand(0, 1.2) }));
    this.front = Array.from({ length: Math.round(26 * density) }, () => Object.assign(ember(true), { y: rand(0, 1.2) }));
  }

  // fade: 0..1 overall strength (the startup screen fades it in).
  Ambient.prototype.drawBack = function (ctx, dt, t, W, H, fade = 1) {
    for (const f of this.fog) {
      f.x += f.vx * dt; f.y += f.vy * dt;
      if (f.x < -0.5) f.x = 1.5;
      if (f.x > 1.5) f.x = -0.5;
      if (f.y < 0.2) f.y = 1.1;
      const size = f.size * Math.max(W, H) * (1 + 0.06 * Math.sin(t * 0.3 + f.phase));
      ctx.globalAlpha = fade * f.alpha * (0.8 + 0.2 * Math.sin(t * 0.5 + f.phase));
      ctx.drawImage(f.sprite, f.x * W - size / 2, f.y * H - size / 2, size, size);
    }
    ctx.globalAlpha = fade;
    drawEmbers(ctx, this.back, dt, t, W, H, false);
    ctx.globalAlpha = 1;
  };

  Ambient.prototype.drawFront = function (ctx, dt, t, W, H) {
    drawEmbers(ctx, this.front, dt, t, W, H, true);
  };

  // Size a set of canvases to the window (device-pixel aware).
  function fitCanvases(contexts) {
    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    const W = window.innerWidth, H = window.innerHeight;
    for (const ctx of contexts) {
      ctx.canvas.width = Math.round(W * DPR);
      ctx.canvas.height = Math.round(H * DPR);
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    }
    return { W, H };
  }

  window.FX = { Ambient, fitCanvases, rand };
})();
