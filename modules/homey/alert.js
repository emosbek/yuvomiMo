/**
 * Full-screen doorbell. The gateway serves this file itself and adds it to
 * every Yuvomi page. It has no imports: module files behind /api/v1 answer
 * 401 until someone is signed in, and the card has to be waiting before that.
 * A ring stays above the photo screensaver and leaves when the server's timer
 * runs out.
 */

const POLL_MS = 2000;
const QUIET_MS = 4000;

function phrases() {
  const lang = String(document.documentElement.lang || navigator.language || 'nb').toLowerCase();
  if (lang.startsWith('de')) {
    return {
      title: 'Es klingelt',
      body: 'Jemand ist an der Tür.',
      dismiss: 'Schließen',
      testBody: 'Das ist ein Test der Karte und der Kamera. Klingel und Gong werden nicht benutzt.',
      noPicture: 'Homey hat kein Bild von dieser Kamera.',
      pictureError: 'Das Kamerabild kam nicht an.',
      streamError: 'Der Videostream hat nicht gestartet.',
    };
  }
  if (lang.startsWith('en')) {
    return {
      title: 'Someone is ringing',
      body: 'There is someone at the door.',
      dismiss: 'Close',
      testBody: 'This is a test of the card and the camera. The doorbell and the chimes are not used.',
      noPicture: 'Homey has no picture from this camera.',
      pictureError: 'The camera picture did not arrive.',
      streamError: 'The video stream did not start.',
    };
  }
  return {
    title: 'Noen ringer på',
    body: 'Det er noen ved døren.',
    dismiss: 'Lukk',
    testBody: 'Dette er en test av kortet og kameraet. Dørklokken og klokkene brukes ikke.',
    noPicture: 'Homey har ikke et bilde fra dette kameraet.',
    pictureError: 'Kamerabildet kom ikke.',
    streamError: 'Videostrømmen startet ikke.',
  };
}

function beep() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  try {
    const ctx = new Ctx();
    const tone = ctx.createOscillator();
    const gain = ctx.createGain();
    tone.frequency.value = 880;
    tone.connect(gain);
    gain.connect(ctx.destination);
    const start = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.15, start + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.7);
    tone.start(start);
    tone.stop(start + 0.75);
    tone.onended = () => ctx.close();
  } catch { /* a kiosk that has never been tapped may refuse sound */ }
}

function overlay() {
  const copy = phrases();
  const host = document.createElement('div');
  host.id = 'homey-doorbell';
  host.style.cssText = 'position:fixed;inset:0;z-index:110000;';
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = [
    '.scrim{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:1.5rem;background:rgba(8,18,28,.94);color:#fff;font:500 1.25rem/1.4 system-ui,sans-serif;text-align:center}',
    '.stack{width:min(92vw,42rem)}',
    'video,img{width:100%;max-height:46vh;object-fit:contain;border-radius:1rem;background:#000;margin:0 0 1rem}',
    'h1{margin:.75rem 0 .5rem;font-size:clamp(2.5rem,8vw,4.5rem);font-weight:650}',
    'p{margin:0 0 1.5rem;font-size:clamp(1.25rem,3vw,2rem)}',
    'button{font:inherit;font-size:1.25rem;padding:.85rem 1.6rem;border:0;border-radius:999px;background:#fff;color:#0B6E99;cursor:pointer}',
    'svg{width:4.5rem;height:4.5rem}',
  ].join('');
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  scrim.setAttribute('role', 'alertdialog');
  scrim.setAttribute('aria-modal', 'true');
  scrim.setAttribute('aria-labelledby', 'homey-doorbell-title');
  const title = document.createElement('h1');
  title.id = 'homey-doorbell-title';
  const body = document.createElement('p');
  body.id = 'homey-doorbell-body';
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.id = 'homey-doorbell-dismiss';
  dismiss.textContent = copy.dismiss;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of [
    'M10.268 21a2 2 0 0 0 3.464 0',
    'M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326',
  ]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  const stack = document.createElement('div');
  stack.className = 'stack';
  const media = document.createElement('div');
  media.id = 'homey-doorbell-media';
  stack.append(media, svg, title, body, dismiss);
  scrim.append(stack);
  root.append(style, scrim);
  return host;
}

export function startDoorbellWatch() {
  if (typeof document === 'undefined') return;
  if (globalThis.__homeyDoorbell) return;
  globalThis.__homeyDoorbell = true;

  let host = null;
  let shownId = '';
  let hideTimer = 0;
  let frameTimer = 0;

  function hide() {
    clearTimeout(hideTimer);
    clearInterval(frameTimer);
    frameTimer = 0;
    host?.remove();
    host = null;
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && host) hide();
  });

  function show(alert) {
    shownId = alert.id;
    const copy = phrases();
    if (!host) {
      host = overlay();
      host.shadowRoot.getElementById('homey-doorbell-dismiss').addEventListener('click', hide);
      host.shadowRoot.querySelector('.scrim').addEventListener('click', (event) => {
        if (event.target === event.currentTarget) hide();
      });
      document.body.append(host);
    }
    const root = host.shadowRoot;
    const fallback = alert.test
      ? (alert.feed === 'none' ? copy.noPicture : copy.testBody)
      : copy.body;
    root.getElementById('homey-doorbell-title').textContent = alert.title || copy.title;
    root.getElementById('homey-doorbell-body').textContent = alert.body || fallback;
    root.getElementById('homey-doorbell-dismiss').textContent = copy.dismiss;
    const slot = root.getElementById('homey-doorbell-media');
    slot.replaceChildren();
    clearInterval(frameTimer);
    frameTimer = 0;
    if (alert.stream) {
      const src = `/api/extensions/homey/stream?id=${encodeURIComponent(alert.id)}`;
      const player = alert.streamKind === 'image' ? document.createElement('img') : document.createElement('video');
      const picture = player.tagName === 'IMG';
      if (picture) player.alt = '';
      else {
        player.autoplay = true;
        player.muted = true;
        player.playsInline = true;
        player.setAttribute('playsinline', '');
      }
      player.addEventListener('error', () => {
        const line = root.getElementById('homey-doorbell-body');
        if (line) line.textContent = picture ? copy.pictureError : copy.streamError;
      });
      if (picture) {
        player.addEventListener('load', () => {
          const line = root.getElementById('homey-doorbell-body');
          if (line && alert.test && alert.feed !== 'none') line.textContent = copy.testBody;
        });
        const paint = () => {
          player.src = `${src}&t=${Date.now()}`;
        };
        paint();
        frameTimer = setInterval(paint, 1000);
      } else {
        player.src = src;
      }
      slot.append(player);
    }
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, Math.max(0, Number(alert.remainingMs) || 0));
    beep();
  }

  async function poll() {
    try {
      const response = await fetch('/api/extensions/homey/alert', {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      if (response.status === 401) return QUIET_MS;
      if (!response.ok) return POLL_MS;
      const data = await response.json();
      const alert = data?.alert;
      if (alert?.id && alert.id !== shownId) show(alert);
      if (!alert) shownId = '';
      return POLL_MS;
    } catch {
      return POLL_MS;
    }
  }

  async function loop() {
    const wait = await poll();
    setTimeout(loop, wait);
  }
  loop();
}

startDoorbellWatch();
