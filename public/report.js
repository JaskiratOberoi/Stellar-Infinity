/*
 * Where the printed QR lands. One document, fetched with the token in the URL.
 *
 * It does not download on load, on purpose: phone cameras open this in an
 * in-app browser, several of which drop a programmatic download silently and
 * leave the reader on a blank page believing the report does not exist. A
 * button they press is a download the browser treats as user-initiated, which
 * is the case those browsers actually handle.
 */
const id = decodeURIComponent(location.pathname.split('/').pop() || '');
const token = new URLSearchParams(location.search).get('t') || '';

const $ = (s) => document.querySelector(s);
$('#rid').textContent = id;
document.title = `Report ${id}`;

const alertBox = $('#alert');
const button = $('#dl');
const done = $('#done');

function fail(message) {
  alertBox.textContent = message;
  alertBox.hidden = false;
}

if (!token) {
  fail('This link is incomplete. Please scan the QR code on your report again.');
  button.disabled = true;
}

button.addEventListener('click', async () => {
  button.disabled = true;
  alertBox.hidden = true;
  const label = button.textContent;
  button.textContent = 'Preparing…';
  try {
    const res = await fetch(`/api/public/${encodeURIComponent(id)}/pdf?t=${encodeURIComponent(token)}`);
    // The server answers 404 for a bad token and an unknown id alike, so this
    // message cannot be more specific than the server was willing to be.
    if (!res.ok) throw new Error('This report link could not be opened. It may have been mistyped. Please scan the QR code again or contact the laboratory named on your report.');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Report-${id}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    done.hidden = false;
    button.textContent = 'Download again';
  } catch (e) {
    fail(e instanceof Error ? e.message : 'The report could not be downloaded.');
    button.textContent = label;
  } finally {
    button.disabled = false;
  }
});
