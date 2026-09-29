/**
 * Taken from X:\Listec Automation\build\patch-wweb-pairing-defer.js, where the
 * lab's existing WhatsApp bots needed it: whatsapp-web.js fires
 * requestPairingCode without awaiting it, and when WhatsApp Web is still
 * mid-navigation that throws "Execution context was destroyed" and no pairing
 * code ever appears. This awaits it after a short delay instead.
 *
 * Run at image build (see Dockerfile). Fails the build if the library changed
 * shape, so an upgrade cannot silently lose phone-number pairing.
 */
const fs = require('fs');
const path = require('path');

const INJECT = `                this.requestPairingCode(pairWithPhoneNumber.phoneNumber, pairWithPhoneNumber.showNotification, pairWithPhoneNumber.intervalMs);`;
const INJECT_PAT = `                await new Promise((r) => setTimeout(r, 2000));
                try {
                    await this.requestPairingCode(
                        pairWithPhoneNumber.phoneNumber,
                        pairWithPhoneNumber.showNotification,
                        pairWithPhoneNumber.intervalMs
                    );
                } catch (listecPairingErr) {
                    console.error('[whatsapp-web.js] requestPairingCode failed', listecPairingErr);
                }`;

const clientPath = process.argv[2] || path.join(__dirname, 'node_modules', 'whatsapp-web.js', 'src', 'Client.js');
const raw = fs.readFileSync(clientPath, 'utf8');
if (raw.includes('listecPairingErr')) { console.log('[patch-wweb] Already applied'); process.exit(0); }
if (!raw.includes(INJECT)) { console.error('[patch-wweb] Expected snippet not found; whatsapp-web.js changed.'); process.exit(1); }
fs.writeFileSync(clientPath, raw.replace(INJECT, INJECT_PAT), 'utf8');
console.log('[patch-wweb] Patched', clientPath);
