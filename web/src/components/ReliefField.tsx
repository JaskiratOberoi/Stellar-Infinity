import { useEffect, useRef } from 'react';

/**
 * RELIEF — a topography that will not hold still.
 *
 * A dot matrix laid on a ground plane, each point lifted by a rolling fractal
 * (fBm) heightfield and projected in perspective, so it reads as terrain
 * drifting toward the viewer. Inspired by the WebGL "Relief" study at
 * mercury-hazel-seven.vercel.app, rebuilt on a plain 2D canvas — the project's
 * runtime deps are React and the router, and a login backdrop is not worth a
 * WebGL/Three dependency and the bundle it drags in.
 *
 * It reads the brand tokens off the document so it recolours with the theme,
 * and freezes to a single painted frame under prefers-reduced-motion — a
 * ceaselessly rolling background is exactly the motion that setting asks to be
 * spared. aria-hidden throughout: this is weather, not content.
 */

/* Deterministic value noise — a sin-hash lattice with smoothstep interpolation,
 * summed over four octaves. Good enough to look like terrain, cheap enough to
 * evaluate thousands of times a frame. */
function makeNoise() {
  const hash = (x: number, y: number) => {
    const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return n - Math.floor(n);
  };
  const vnoise = (x: number, y: number) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
  };
  return (x: number, y: number) => {
    let f = 0, amp = 0.5, freq = 1;
    for (let o = 0; o < 4; o++) { f += amp * vnoise(x * freq, y * freq); freq *= 2; amp *= 0.5; }
    return f; // ~[0,1)
  };
}

type RGB = [number, number, number];

/** Read a CSS colour token off the root and resolve it to RGB via the canvas. */
function tokenRgb(probe: CanvasRenderingContext2D, name: string, fallback: RGB): RGB {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!raw) return fallback;
  try {
    probe.fillStyle = '#000';
    probe.fillStyle = raw;
    probe.fillRect(0, 0, 1, 1);
    const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
    return [r, g, b];
  } catch {
    return fallback;
  }
}

const mix = (a: RGB, b: RGB, t: number): RGB =>
  [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export function ReliefField() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const noise = makeNoise();

    // Palette, resampled whenever the theme flips. `dark` decides how bright the
    // dots ride over their ground and how far the horizon fades.
    let cyan: RGB, teal: RGB, blue: RGB, dark: boolean;
    const readPalette = () => {
      cyan = tokenRgb(ctx, '--cyan', [34, 211, 238]);
      teal = tokenRgb(ctx, '--teal', [45, 212, 191]);
      blue = tokenRgb(ctx, '--blue', [96, 165, 250]);
      dark = document.documentElement.classList.contains('dark')
          || document.body.classList.contains('dark');
    };
    readPalette();
    const themeObserver = new MutationObserver(readPalette);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

    let W = 0, H = 0, dpr = 1;
    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = window.innerWidth;
      H = window.innerHeight;
      canvas.width = Math.floor(W * dpr);
      canvas.height = Math.floor(H * dpr);
      canvas.style.width = W + 'px';
      canvas.style.height = H + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    // ── the field ────────────────────────────────────────────────────────
    const COLS = 140;   // points across
    const ROWS = 96;    // points in depth
    const SPAN = 34;    // world half-width
    const Z_NEAR = 6;
    const Z_FAR = 36;
    const CAM_Y = 5.6;  // camera height over the plane — high enough that the
                        // near troughs stay on screen instead of flying off
    const AMP = 1.9;    // height amplitude
    const NOISE_XY = 0.16;
    const ROLL = 0.6;   // world units per second the terrain advects forward

    const draw = (t: number) => {
      const focal = H * 0.92;
      const cx = W / 2;
      const cy = H * 0.46;              // horizon a touch above centre

      ctx.clearRect(0, 0, W, H);
      ctx.globalCompositeOperation = dark ? 'lighter' : 'source-over';

      // Far rows first so nearer, larger dots paint over them.
      for (let r = ROWS - 1; r >= 0; r--) {
        const z = Z_NEAR + (Z_FAR - Z_NEAR) * (r / (ROWS - 1));
        const depth = (z - Z_NEAR) / (Z_FAR - Z_NEAR);   // 0 near … 1 far
        const zPhase = z - t * ROLL;                     // advection = rolling
        for (let c = 0; c < COLS; c++) {
          const x = -SPAN + (2 * SPAN) * (c / (COLS - 1));
          const h = noise(x * NOISE_XY, zPhase * NOISE_XY);   // ~[0,1)
          const y = AMP * (h - 0.5) * 2;                       // centre on 0

          const sx = cx + focal * x / z;
          const sy = cy + focal * (CAM_Y - y) / z;
          if (sy < -20 || sy > H + 20 || sx < -20 || sx > W + 20) continue;

          // Height 0..1 for colour + brightness; peaks are brightest.
          const hn = Math.min(1, Math.max(0, h));
          // teal in the troughs → cyan on the crests, with blue mixed by depth
          // so the far field cools out toward the horizon.
          let col = mix(mix(teal, cyan, hn), blue, depth * 0.5);
          // The sparse warm crest, echoing Relief's amber — only the very tops.
          if (hn > 0.86) col = mix(col, [240, 180, 90], (hn - 0.86) / 0.14 * 0.7);

          const near = 1 - depth;
          const alpha = (dark ? 0.22 : 0.3) + near * (dark ? 0.72 : 0.5) * (0.4 + hn * 0.6);
          const size = Math.max(0.7, (focal / z) * 0.03 * (0.7 + hn * 0.7));

          ctx.fillStyle = `rgba(${col[0] | 0},${col[1] | 0},${col[2] | 0},${alpha.toFixed(3)})`;
          ctx.fillRect(sx - size / 2, sy - size / 2, size, size);
        }
      }
      ctx.globalCompositeOperation = 'source-over';
    };

    let raf = 0;
    let start = 0;
    const loop = (now: number) => {
      if (!start) start = now;
      draw((now - start) / 1000);
      raf = requestAnimationFrame(loop);
    };

    if (still) {
      draw(0); // one frozen frame — no motion, but the texture still lands
    } else {
      raf = requestAnimationFrame(loop);
    }

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      themeObserver.disconnect();
    };
  }, []);

  return <canvas ref={ref} className="login__relief" aria-hidden="true" />;
}
