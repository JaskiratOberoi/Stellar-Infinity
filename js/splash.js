/* =========================================================
   Infinity Laboratory Systems — splash controller
   Exposes window.InfinitySplash so the real app can drive it:
     InfinitySplash.setProgress(0..100, "message")
     InfinitySplash.finish()   -> fills to 100% and fades out
     InfinitySplash.show()     -> replays the splash
   With no external driver it runs a demo loading sequence.
   ========================================================= */

(function () {
  "use strict";

  var splash = document.getElementById("splash");
  var app = document.getElementById("app");
  var bar = document.getElementById("splash-bar");
  var percentEl = document.getElementById("splash-percent");
  var messageEl = document.getElementById("splash-message");
  var canvas = document.getElementById("splash-particles");

  var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- floating particles (cells / molecules / medical crosses) ---------- */

  var ctx = canvas.getContext("2d");
  var particles = [];
  var waves = [];                              // click shockwaves
  var pointer = { x: -1e5, y: -1e5 };          // cursor in canvas coords
  var rafId = null;
  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  var PALETTE = ["#06b6d4", "#0d9488", "#2563eb"];

  function resize() {
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    seedParticles();
  }

  function seedParticles() {
    var count = Math.floor((canvas.width * canvas.height) / (24000 * dpr));
    particles = [];
    for (var i = 0; i < count; i++) {
      var roll = Math.random();
      particles.push({
        // cells under a microscope, hexagonal molecules, medical crosses
        type: roll < 0.62 ? "cell" : roll < 0.86 ? "hex" : "plus",
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        r: (Math.random() * 3.2 + 1.6) * dpr,
        vy: (Math.random() * 0.10 + 0.03) * dpr,   // slow upward drift
        vx: (Math.random() - 0.5) * 0.05 * dpr,
        base: Math.random() * 0.10 + 0.05,          // soft, clinical — keep faint
        tw: Math.random() * Math.PI * 2,
        tws: Math.random() * 0.012 + 0.003,
        rot: Math.random() * Math.PI * 2,
        rots: (Math.random() - 0.5) * 0.006,
        color: PALETTE[Math.floor(Math.random() * PALETTE.length)]
      });
    }
  }

  function drawHex(x, y, r, rot) {
    ctx.beginPath();
    for (var k = 0; k < 6; k++) {
      var a = rot + (k * Math.PI) / 3;
      var px = x + Math.cos(a) * r;
      var py = y + Math.sin(a) * r;
      if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.stroke();
  }

  function frame() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // expanding shockwaves from clicks
    for (var w = waves.length - 1; w >= 0; w--) {
      var wave = waves[w];
      wave.r += 3.4 * dpr;
      var life = 1 - wave.r / (320 * dpr);
      if (life <= 0) { waves.splice(w, 1); continue; }
      ctx.globalAlpha = life * 0.35;
      ctx.beginPath();
      ctx.arc(wave.x, wave.y, wave.r, 0, Math.PI * 2);
      ctx.strokeStyle = "#0d9488";
      ctx.lineWidth = 1.5 * dpr;
      ctx.stroke();
    }

    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      p.tw += p.tws;
      p.rot += p.rots;
      if (!reducedMotion) {
        p.y -= p.vy;
        p.x += p.vx;

        // gentle repulsion from the cursor
        var dx = p.x - pointer.x;
        var dy = p.y - pointer.y;
        var d2 = dx * dx + dy * dy;
        var R = 130 * dpr;
        if (d2 < R * R && d2 > 0.01) {
          var d = Math.sqrt(d2);
          var f = (1 - d / R) * 1.1 * dpr;
          p.x += (dx / d) * f;
          p.y += (dy / d) * f;
        }

        // shockwave band push
        for (var j = 0; j < waves.length; j++) {
          var wv = waves[j];
          var wx = p.x - wv.x, wy = p.y - wv.y;
          var wd = Math.sqrt(wx * wx + wy * wy) || 1;
          if (Math.abs(wd - wv.r) < 30 * dpr) {
            p.x += (wx / wd) * 1.6 * dpr;
            p.y += (wy / wd) * 1.6 * dpr;
          }
        }

        if (p.y < -8) { p.y = canvas.height + 8; p.x = Math.random() * canvas.width; }
        if (p.x < -8) p.x = canvas.width + 8;
        if (p.x > canvas.width + 8) p.x = -8;
      }
      var alpha = p.base + Math.sin(p.tw) * 0.04;
      ctx.globalAlpha = Math.max(0.02, alpha);
      ctx.strokeStyle = p.color;
      ctx.fillStyle = p.color;

      if (p.type === "hex") {
        ctx.lineWidth = 0.9 * dpr;
        drawHex(p.x, p.y, p.r + 2.5 * dpr, p.rot);
      } else if (p.type === "plus") {
        ctx.lineWidth = 1.4 * dpr;
        ctx.lineCap = "round";
        var arm = p.r + 1.5 * dpr;
        ctx.beginPath();
        ctx.moveTo(p.x - arm, p.y); ctx.lineTo(p.x + arm, p.y);
        ctx.moveTo(p.x, p.y - arm); ctx.lineTo(p.x, p.y + arm);
        ctx.stroke();
      } else {
        // cell: body + membrane ring + off-center nucleus
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = Math.max(0.02, alpha * 0.8);
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r + 2.5 * dpr, 0, Math.PI * 2);
        ctx.lineWidth = 0.8 * dpr;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(p.x + p.r * 0.35, p.y - p.r * 0.3, p.r * 0.35, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    rafId = requestAnimationFrame(frame);
  }

  window.addEventListener("resize", resize);

  /* cursor + click interaction on the splash */

  var helixLeft = document.getElementById("helix-left");
  var helixRight = document.getElementById("helix-right");

  splash.addEventListener("pointermove", function (e) {
    pointer.x = e.clientX * dpr;
    pointer.y = e.clientY * dpr;
    // helix parallax — sides drift opposite ways
    var px = (e.clientX / window.innerWidth - 0.5) * 16;
    var py = (e.clientY / window.innerHeight - 0.5) * 12;
    helixLeft.style.setProperty("--hx", px + "px");
    helixLeft.style.setProperty("--hy", py + "px");
    helixRight.style.setProperty("--hx", -px + "px");
    helixRight.style.setProperty("--hy", -py + "px");
  });

  splash.addEventListener("pointerleave", function () {
    pointer.x = -1e5;
    pointer.y = -1e5;
  });

  splash.addEventListener("click", function (e) {
    if (reducedMotion) return;
    waves.push({ x: e.clientX * dpr, y: e.clientY * dpr, r: 0 });
  });

  /* ---------- progress API ---------- */

  var current = 0;
  var demoTimer = null;
  var finished = false;

  function setProgress(value, message) {
    current = Math.max(0, Math.min(100, value));
    bar.style.width = current + "%";
    percentEl.textContent = Math.round(current) + "%";
    if (message) messageEl.textContent = message;
  }

  function finish() {
    if (finished) return;
    finished = true;
    clearTimeout(demoTimer);
    setProgress(100, "Ready");
    setTimeout(hide, 550);
  }

  function hide() {
    splash.classList.add("splash--hidden");
    app.hidden = false;
    // stop the particle loop once the fade completes
    setTimeout(function () {
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    }, 1000);
  }

  function show() {
    finished = false;
    setProgress(0, "Initializing analyzers");
    app.hidden = true;
    splash.classList.remove("splash--hidden");
    if (!rafId) frame();
    runDemo();
  }

  /* ---------- demo sequence (until a real app drives it) ---------- */

  var demoSteps = [
    [10, "Powering hematology analyzers"],
    [24, "Calibrating optical sensors"],
    [38, "Priming reagent lines"],
    [52, "Sequencing genome index"],
    [66, "Running PCR thermal cycle"],
    [80, "Verifying QC baselines"],
    [92, "Preparing patient worklists"],
    [100, null]
  ];

  function runDemo() {
    clearTimeout(demoTimer);
    var i = 0;
    (function step() {
      if (finished || i >= demoSteps.length) return;
      var target = demoSteps[i][0];
      var label = demoSteps[i][1];
      i++;
      if (target >= 100) { finish(); return; }
      setProgress(target, label);
      demoTimer = setTimeout(step, 650 + Math.random() * 500);
    })();
  }

  /* ---------- boot ---------- */

  resize();
  frame();
  runDemo();

  // replay with "R" (demo convenience)
  window.addEventListener("keydown", function (e) {
    if ((e.key === "r" || e.key === "R") && splash.classList.contains("splash--hidden")) {
      show();
    }
  });

  window.InfinitySplash = { setProgress: setProgress, finish: finish, show: show };

  /* ---------- coming-soon card interactivity ---------- */

  var card = document.getElementById("cs-card");
  var title = document.getElementById("cs-title");
  var replayBtn = document.getElementById("cs-replay");

  // split the title into per-letter spans for staggered entry + hover pop
  var text = title.textContent;
  title.textContent = "";
  for (var c = 0; c < text.length; c++) {
    var span = document.createElement("span");
    span.className = "cs__letter";
    span.style.setProperty("--i", c);
    span.textContent = text[c] === " " ? " " : text[c];
    title.appendChild(span);
  }

  // tilt toward the cursor + move the spotlight
  card.addEventListener("pointermove", function (e) {
    if (reducedMotion) return;
    var rect = card.getBoundingClientRect();
    var px = (e.clientX - rect.left) / rect.width;   // 0..1
    var py = (e.clientY - rect.top) / rect.height;
    card.style.setProperty("--ry", ((px - 0.5) * 7).toFixed(2) + "deg");
    card.style.setProperty("--rx", ((0.5 - py) * 7).toFixed(2) + "deg");
    card.style.setProperty("--mx", (px * 100).toFixed(1) + "%");
    card.style.setProperty("--my", (py * 100).toFixed(1) + "%");
  });

  card.addEventListener("pointerleave", function () {
    card.style.setProperty("--rx", "0deg");
    card.style.setProperty("--ry", "0deg");
  });

  // sonar ping where the user clicks
  card.addEventListener("click", function (e) {
    if (reducedMotion) return;
    var rect = card.getBoundingClientRect();
    var ripple = document.createElement("span");
    ripple.className = "cs__ripple";
    ripple.style.left = (e.clientX - rect.left) + "px";
    ripple.style.top = (e.clientY - rect.top) + "px";
    card.appendChild(ripple);
    ripple.addEventListener("animationend", function () { ripple.remove(); });
  });

  replayBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    show();
  });

  /* ---------- DNA helixes (rungs are plain spans, twist done in CSS) ---------- */

  function buildHelix(el, n) {
    if (!el) return;
    for (var h = 0; h < n; h++) {
      var rung = document.createElement("span");
      rung.style.setProperty("--i", h);
      el.appendChild(rung);
    }
  }

  buildHelix(helixLeft, 14);
  buildHelix(helixRight, 14);
  buildHelix(document.getElementById("helix-strip"), 18);

  /* ---------- live vitals (random walk within healthy ranges) ---------- */

  var vitals = { hr: 72, spo2: 98, temp: 36.6 };

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function setVital(key, value) {
    var els = document.querySelectorAll('[data-vital="' + key + '"]');
    for (var v = 0; v < els.length; v++) els[v].textContent = value;
  }

  function tickVitals() {
    vitals.hr = clamp(vitals.hr + (Math.random() * 4 - 2), 64, 84);
    vitals.spo2 = clamp(vitals.spo2 + (Math.random() * 0.8 - 0.4), 95.5, 99.4);
    vitals.temp = clamp(vitals.temp + (Math.random() * 0.08 - 0.04), 36.3, 37.2);
    setVital("hr", Math.round(vitals.hr));
    setVital("spo2", Math.round(vitals.spo2));
    setVital("temp", vitals.temp.toFixed(1));
    // heart icon beats at the displayed rate
    var hearts = document.querySelectorAll(".vital__heart");
    for (var h = 0; h < hearts.length; h++) {
      hearts[h].style.animationDuration = (60 / vitals.hr).toFixed(2) + "s";
    }
  }

  tickVitals();
  setInterval(tickVitals, 1400);
})();
