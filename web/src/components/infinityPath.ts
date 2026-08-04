/**
 * The canonical Infinity path, shared by the loader and the sign-in entrance.
 *
 * It starts and ends at the CROSSOVER (240,120) — the symbol's visual centre —
 * rather than at the left extremity. That matters for the sign-in entrance:
 * the login card implodes into a particle at screen centre, and the veil's
 * stroke head begins its journey from that same point, so one object appears
 * to keep moving. Starting at the left extremity (the obvious way to write a
 * lemniscate) put the seed at the centre and the drawing head 130px to its
 * left — two dots, and a visible break at the handoff.
 *
 * Route: crossover -> right loop (under, then over) -> crossover -> left loop
 * (under, then over) -> home. Drawn inside viewBox "40 58 400 124", whose
 * centre is exactly (240,120).
 */
export const INFINITY_PATH =
  'M240,120 C310,182 420,182 420,120 C420,58 310,58 240,120 ' +
  'C170,182 60,182 60,120 C60,58 170,58 240,120 Z';

/** The viewBox the path is authored in; its centre is the crossover. */
export const INFINITY_VIEWBOX = '40 58 400 124';
