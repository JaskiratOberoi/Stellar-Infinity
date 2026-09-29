/**
 * Media sends through whatsapp-web.js fail on the WhatsApp Web builds rolled
 * out from 2026-09-17 with "Data passed to getter must include an id property
 * (it's how we memoize) but got undefined": the media model is spread into
 * the outgoing message and carries its private `__x_id: undefined` with it,
 * which the new Msg model rejects. Text still sends; every PDF failed.
 *
 * The fix, as the community patched it (wwebjs/whatsapp-web.js#201922,
 * rmyndharis/OpenWA#1670): delete `__x_id` from the message after it is
 * built. Anchored on the comment that follows the construction.
 *
 * Run at image build (see Dockerfile). Fails the build if the anchor moved.
 * Drop this once a whatsapp-web.js release carries the fix.
 */
const fs = require('fs');
const path = require('path');

const ANCHOR = "        // Bot's won't reply if canonicalUrl is set (linking)";
const FIX = "        // Infinity: see whatsapp/patch-wweb-media-id.cjs\n        delete message.__x_id;\n";

const file = process.argv[2] || path.join(__dirname, 'node_modules', 'whatsapp-web.js', 'src', 'util', 'Injected', 'Utils.js');
const raw = fs.readFileSync(file, 'utf8');
if (raw.includes('delete message.__x_id')) { console.log('[patch-wweb-media] Already present'); process.exit(0); }
if (!raw.includes(ANCHOR)) { console.error('[patch-wweb-media] Anchor not found; whatsapp-web.js changed.'); process.exit(1); }
fs.writeFileSync(file, raw.replace(ANCHOR, () => FIX + ANCHOR), 'utf8');
console.log('[patch-wweb-media] Patched', file);
