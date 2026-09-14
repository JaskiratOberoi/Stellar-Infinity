# Report Seal

Upload a laboratory report PDF. Get it back with:

- the **NABL accreditation symbol** with the certificate number beneath it, laid out the way accredited reports usually carry it: a small copy to the left of each accredited parameter's name in the results table, and a full-size one at the foot of every page beside the QR;
- a **QR code** that opens a signed download link for that exact sealed file;
- **"Page X of Y"** on every sheet.

Nothing inside the report is re-typeset. The symbols, the QR and the numbers are drawn over the existing pages; the text, fonts and layout are untouched, and the upload is kept beside the sealed copy.

The flow on the page: drop the PDF, and its text is read to find the lines shaped like result rows (a name at the left, a figure to its right). Those come back as a checklist, ticked; untick anything that is not accredited, adjust the positions and sizes if the defaults are not right, and press **Seal report**.

## Run it

```bash
npm install
npm start          # http://localhost:8080
```

`npm run sample` writes a stand-in report to `data/sample-report.pdf` to try it on. `npm test` runs the unit tests. `npm run dev` restarts on edits.

With Docker:

```bash
docker build -t report-seal .
docker run -p 8080:8080 -v report-seal-data:/app/data -e PUBLIC_BASE_URL=https://reports.example.org report-seal
```

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8080` | Listen port. |
| `DATA_DIR` | `./data` | Where sealed reports and the signing secret are kept. |
| `PUBLIC_BASE_URL` | *(from each request's host)* | The origin baked into every QR. **Set this in production**: a QR printed with `http://localhost:8080` in it never works from a phone. |
| `TOKEN_SECRET` | *(generated once into `DATA_DIR/secret`)* | Signs the download tokens. Changing it invalidates every QR already printed. |
| `MAX_UPLOAD_MB` | `25` | Upload size limit. |

## How it works

**Finding the parameter names** (`lib/analyze.mjs`) uses pdf.js to read every text run and its position, groups runs into lines by baseline, and flags a line as a likely result row when its leftmost run starts with a letter, is not one of the usual labels (Patient, Collected, Method, Dr., …) and there is a figure in a run to its right. It is a proposal for a person to confirm, not a verdict, which is why the page shows it as a checklist. A scanned PDF has no text; it still gets the foot mark and the QR.

**Stamping** (`lib/stamp.mjs`) uses pdf-lib. Each page is measured in its *visual* frame (the CropBox as turned by the page's `/Rotate`), the stamp positions are worked out there, and mapped back to raw page coordinates at the last moment. So a landscape scan or a rotated attachment gets its stamp in the same corner, the right way up. The row mark goes to the left of the parameter name, in the gutter, centred on its line; if the name sits at the very paper edge it goes after the name instead. The symbol PNG and the QR PNG are embedded once per document and drawn on each page that wants them, so a fifty-page report carries one copy of each, not fifty. Encrypted PDFs are refused rather than corrupted.

**Links** (`lib/links.mjs`). A sealed report gets a ten-character id (no 0/O/1/I, so it can be read off paper). The QR encodes `PUBLIC_BASE_URL/r/<id>?t=<token>`, where the token is the first 24 base64url characters of an HMAC-SHA256 over the id under the server secret. Holding one report's token tells you nothing about any other id, so the id space cannot be walked. The check is constant-time, and with no secret configured nothing ever verifies. The token is not a session and does not expire: anyone holding the printed report, or a photograph of it, can fetch it. That is the point of the QR, but state it to whoever prints these.

**The download page** (`/r/<id>`) is the same static page for every id and does not auto-download: phone cameras open links in in-app browsers that silently drop programmatic downloads, and a button the reader presses is a download those browsers actually handle. The public routes answer `404` for every failure, so a bad token, an unknown id and a missing file are indistinguishable from outside.

## HTTP surface

| Route | Purpose |
|---|---|
| `GET /` | The sealing page. |
| `POST /api/upload` | Body: the PDF with `Content-Type: application/pdf`; optional `X-File-Name`. Stores it for two hours and returns `uploadId`, `pages` and `lines` (each with `page`, `text`, `x`, `y`, `w`, `h`, `likely`). |
| `POST /api/seal` (JSON) | `{ "uploadId", "options": { cert, mark, markPages, markSize, rowSize, qr, qrPages, qrSize, caption, numbers, margin }, "rows": [ { page, x, y, w, h } ] }`. Seals the stored upload with the small mark beside each row given. Returns JSON with `id`, `publicUrl`, `downloadUrl`, `viewUrl`, `qrImageUrl`. |
| `POST /api/seal?cert=&mark=…` (PDF) | One shot: the PDF as the body, options in the query, no row marks. Same response. Defaults and valid values are in `DEFAULTS` in `lib/stamp.mjs` and at `GET /api/defaults`. |
| `GET /r/:id?t=` | Where the QR lands. |
| `GET /api/public/:id/pdf?t=[&inline=1]` | The sealed PDF. |
| `GET /api/public/:id/qr.png?t=` | The QR as printed. |
| `GET /api/health` | Liveness, plus the configured public base and upload limit. |

```bash
curl -X POST 'http://localhost:8080/api/seal?cert=MC-0000&mark=header-right' \
  -H 'content-type: application/pdf' --data-binary @data/sample-report.pdf
```

## Deploying

- There is no sign-in. Anyone who can reach `POST /api/seal` can seal a document, so put the sealing page behind the access control the deployment already has (a VPN, or a reverse proxy with authentication). Only `/r/*` and `/api/public/*` are meant to face the open internet.
- Serve it over HTTPS. The token is in the URL; the pages send `Referrer-Policy: no-referrer` so it is not leaked to third parties, but the transport still has to be private.
- Back up `DATA_DIR`. It holds every sealed file and the secret that makes printed QRs work.
- Consider rate-limiting `/api/public/*` at the proxy; tokens are unguessable, but a busy scanner is still a busy scanner.

## Use of the accreditation symbol

The symbol may only be used as NABL's rules for accredited laboratories allow, on reports within the accredited scope. This tool places it where you ask; it does not check that you are entitled to.
