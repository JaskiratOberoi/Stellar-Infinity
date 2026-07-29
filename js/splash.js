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

  /* ---------- floating particles (cells / molecules) ---------- */

  var ctx = canvas.getContext("2d");
  var particles = [];
  var rafId = null;
  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  var PALETTE = ["#06b6d4", "#0d9488", "#2563eb"];

  function resize() {
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    seedParticles();
  }

  function seedParticles() {
    var count = Math.floor((canvas.width * canvas.height) / (26000 * dpr));
    particles = [];
    for (var i = 0; i < count; i++) {
      particles.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        r: (Math.random() * 3.2 + 1.2) * dpr,
        vy: (Math.random() * 0.10 + 0.03) * dpr,   // slow upward drift
        vx: (Math.random() - 0.5) * 0.05 * dpr,
        base: Math.random() * 0.10 + 0.05,          // soft, clinical — keep faint
        tw: Math.random() * Math.PI * 2,
        tws: Math.random() * 0.012 + 0.003,
        color: PALETTE[Math.floor(Math.random() * PALETTE.length)]
      });
    }
  }

  function frame() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      p.tw += p.tws;
      if (!reducedMotion) {
        p.y -= p.vy;
        p.x += p.vx;
        if (p.y < -6) { p.y = canvas.height + 6; p.x = Math.random() * canvas.width; }
        if (p.x < -6) p.x = canvas.width + 6;
        if (p.x > canvas.width + 6) p.x = -6;
      }
      var alpha = p.base + Math.sin(p.tw) * 0.04;
      ctx.globalAlpha = Math.max(0.02, alpha);
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.fill();
      // thin ring — reads as a cell under a microscope
      ctx.globalAlpha = Math.max(0.02, alpha * 0.8);
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r + 2.5 * dpr, 0, Math.PI * 2);
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 0.8 * dpr;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    rafId = requestAnimationFrame(frame);
  }

  window.addEventListener("resize", resize);

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
    [12, "Initializing analyzers"],
    [30, "Syncing sample registry"],
    [50, "Loading assay panels"],
    [72, "Verifying QC baselines"],
    [90, "Preparing worklists"],
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
})();
