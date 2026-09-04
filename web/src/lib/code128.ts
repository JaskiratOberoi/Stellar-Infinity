/**
 * A dependency-free Code 128 encoder, enough to draw a scannable barcode for a
 * SID on the printed report. The LIS prints the same symbology on its sheets,
 * so a scanner at the bench reads either report the same way.
 *
 * Subset B covers ASCII 32–126, which is all a SID ever holds (digits, and the
 * odd letter). Characters outside that range are dropped rather than mis-encoded.
 *
 * An all-digit SID — which is nearly every SID — is encoded in subset C, two
 * digits per symbol, so a nine-digit SID is eight symbols instead of eleven.
 * The symbol stands on its side in the report header, and its length is the
 * header block's height: shorter here is what keeps a long SID from growing
 * the block on every page. An odd digit count opens in B for its first digit
 * and switches to C for the rest, as the standard allows.
 */

// The 107 element-width patterns, indexed by symbol value. Each is a run of
// module widths, bar/space alternating and starting with a bar. Index 106 (the
// stop) carries the extra terminating bar, so it is seven elements, not six.
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];

const CODE_C = 99;
const START_B = 104;
const START_C = 105;
const STOP = 106;

/** A single black bar: its left edge and width, in modules. */
export interface Bar { x: number; w: number; }

/** The bars for a Code 128-B symbol, plus the total module width (quiet zones
 *  included). Returns null when nothing encodable is left after filtering. */
export function code128(text: string, quiet = 10): { bars: Bar[]; width: number } | null {
  const chars = [...(text ?? '')].filter((c) => {
    const n = c.charCodeAt(0);
    return n >= 32 && n <= 126;
  });
  if (chars.length === 0) return null;

  const codes: number[] = [];
  if (chars.every((c) => c >= '0' && c <= '9')) {
    // Subset C: a symbol per digit pair. An odd count spends one subset-B
    // symbol on the leading digit, then switches.
    let i = 0;
    if (chars.length % 2 === 1) {
      codes.push(START_B, chars[0].charCodeAt(0) - 32, CODE_C);
      i = 1;
    } else {
      codes.push(START_C);
    }
    for (; i < chars.length; i += 2) codes.push(Number(chars[i] + chars[i + 1]));
  } else {
    codes.push(START_B);
    for (const c of chars) codes.push(c.charCodeAt(0) - 32);
  }

  // The check symbol: start value plus each following symbol weighted by its
  // position, mod 103 — a subset shift counts as a symbol like any other.
  let checksum = codes[0];
  for (let k = 1; k < codes.length; k++) checksum += codes[k] * k;
  codes.push(checksum % 103);
  codes.push(STOP);

  const bars: Bar[] = [];
  let x = quiet; // opening quiet zone
  let isBar = true;
  for (const code of codes) {
    for (const ch of PATTERNS[code]) {
      const w = Number(ch);
      if (isBar) bars.push({ x, w });
      x += w;
      isBar = !isBar;
    }
  }
  return { bars, width: x + quiet }; // closing quiet zone
}
