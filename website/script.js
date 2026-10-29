// ---------- where the downloads live ----------
//
// The release workflow (.github/workflows/release.yml) uploads installers with
// these exact names, so "latest/download/<name>" always points at the newest
// version. Set REPO to your GitHub "owner/name" before publishing.

const REPO = 'RadheyMugdal/desktop-pet';
const VERSION = '0.3.0';
const FILES = {
  windows: 'DesktopPet-windows-x64-setup.exe',
  mac: 'DesktopPet-macos-universal.dmg',
  appimage: 'DesktopPet-linux-x86_64.AppImage',
  deb: 'DesktopPet-linux-amd64.deb',
};
const releases = `https://github.com/${REPO}/releases`;
const fileUrl = (key) => `${releases}/latest/download/${FILES[key]}`;

// ---------- sprites ----------
//
// <div class="sprite" data-sheet data-frames data-fps data-scale [data-row data-cols data-rows]>
// A sheet without data-cols is a single strip of `frames` frames.

const FRAME = 32;

function setupSprite(el) {
  const d = el.dataset;
  const frameSize = Number(d.frameSize || FRAME);
  const scale = Number(d.scale || 1);
  const frames = Number(d.frames || 1);
  const fps = Number(d.fps || 1);
  const cols = Number(d.cols || frames);
  const rows = Number(d.rows || 1);
  const cell = frameSize * scale;

  el.style.width = el.style.height = `${cell}px`;
  el.style.backgroundImage = d.sheet ? `url("${d.sheet}")` : 'none';
  el.style.backgroundSize = `${cols * cell}px ${rows * cell}px`;
  el.style.backgroundPositionY = `${-Number(d.row || 0) * cell}px`;
  el.style.imageRendering = frameSize > 32 ? 'auto' : '';
  el.style.setProperty('--frames', frames);
  el.style.setProperty('--to', `${-frames * cell}px`);
  el.style.setProperty('--dur', `${frames / fps}s`);
  if (frames === 1) el.style.backgroundPositionX = `${-Number(d.col || 0) * cell}px`;
}

/** Change a sprite's data-* and restart its animation (so layered sprites stay in step). */
function updateSprite(el, changes) {
  Object.assign(el.dataset, changes);
  el.style.animation = 'none';
  setupSprite(el);
  void el.offsetWidth;
  el.style.animation = '';
}

document.querySelectorAll('.sprite').forEach(setupSprite);

// ---------- nav ----------

const nav = document.querySelector('.nav');
addEventListener('scroll', () => nav.classList.toggle('scrolled', scrollY > 8), { passive: true });

// ---------- the miniature desktop (Tabby) ----------

const screen = document.getElementById('screen');
const mini = document.getElementById('mini-pet');
const miniSprite = document.getElementById('mini-sprite');
const miniFx = document.getElementById('mini-fx');
const hint = document.getElementById('hint');
const clock = document.getElementById('clock');

const TASKBAR = 30;
const PET = 108;

const looks = {
  sit: { sheet: 'assets/tabby/sit.png', frameSize: '360', frames: '28', cols: '28', fps: '4' },
  nap: { sheet: 'assets/tabby/sleep.png', frameSize: '360', frames: '8', cols: '8', fps: '3' },
  happy: { sheet: 'assets/tabby/happy.png', frameSize: '360', frames: '8', cols: '8', fps: '8' },
  walk_right: { sheet: 'assets/tabby/walk_right.png', frameSize: '360', frames: '8', cols: '8', fps: '8' },
  walk_left: { sheet: 'assets/tabby/walk_left.png', frameSize: '360', frames: '8', cols: '8', fps: '8' },
  held: { sheet: 'assets/tabby/held.png', frameSize: '360', frames: '8', cols: '8', fps: '4' },
  yawn: { sheet: 'assets/tabby/yawn.png', frameSize: '360', frames: '8', cols: '8', fps: '6' },
};

const kit = { x: 0, y: -PET, vy: 0, home: 1, state: 'fall', since: 0, drag: null, dir: 1 };
let zTimer = null;
let happyTimer = null;

const bounds = () => ({ w: screen.clientWidth, h: screen.clientHeight });
const groundY = () => bounds().h - TASKBAR - PET;
const homeX = () => kit.home * (bounds().w - PET - 18);

function look(name) {
  updateSprite(miniSprite, looks[name]);
}

function placeKit() {
  mini.style.translate = `${Math.round(kit.x)}px ${Math.round(kit.y)}px`;
  const hx = Math.min(Math.max(kit.x - 70, 8), bounds().w - 180);
  hint.style.left = `${hx}px`;
  hint.style.top = `${Math.max(kit.y - 34, 8)}px`;
}

function spawn(cls, text) {
  const s = document.createElement('span');
  if (cls) s.className = cls;
  s.textContent = text;
  s.style.left = `${35 + Math.random() * 25}%`;
  s.style.setProperty('--dx', `${Math.random() * 24 - 12}px`);
  s.addEventListener('animationend', () => s.remove());
  miniFx.appendChild(s);
}

function setState(state) {
  kit.state = state;
  kit.since = performance.now();
  clearInterval(zTimer);
  clearTimeout(happyTimer);
  if (state === 'nap') {
    look('nap');
    zTimer = setInterval(() => spawn('z', 'z'), 1300);
  } else if (state === 'yawn') {
    look('yawn');
  } else if (state === 'happy') {
    look('happy');
    happyTimer = setTimeout(() => {
      if (kit.state === 'happy') setState('sit');
    }, 1500);
  } else if (state === 'drag') {
    look('held');
  } else if (state === 'walk') {
    look(kit.dir >= 0 ? 'walk_right' : 'walk_left');
  } else {
    look('sit');
  }
}

function startWalk(target) {
  kit.walkTo = target;
  kit.dir = target >= kit.x ? 1 : -1;
  setState('walk');
}

function bump(cls) {
  mini.classList.remove(cls);
  void mini.offsetWidth;
  mini.classList.add(cls);
}

function petKitten() {
  hint.classList.add('gone');
  spawn('', '♥');
  setTimeout(() => spawn('', '♥'), 180);
  setState('happy');
  bump('happy');
}

let last = performance.now();
function frame(t) {
  const dt = Math.min((t - last) / 1000, 0.05);
  last = t;

  if (kit.state === 'fall') {
    kit.vy += 2200 * dt;
    kit.y += kit.vy * dt;
    if (kit.y >= groundY()) {
      kit.y = groundY();
      kit.vy = 0;
      setState('sit');
      bump('land');
    }
    placeKit();
  } else if (kit.state === 'walk') {
    const target = kit.walkTo;
    const step = kit.dir * 42 * dt;
    kit.x = Math.abs(target - kit.x) <= Math.abs(step) ? target : kit.x + step;
    if (kit.x === target) {
      setState('sit');
    }
    placeKit();
  } else if (kit.state !== 'drag') {
    const held = (t - kit.since) / 1000;
    if (kit.state === 'sit' && held > 6) {
      const r = Math.random();
      if (r < 0.28) {
        setState('yawn');
      } else if (r < 0.56) {
        setState('nap');
      } else {
        const dest = Math.min(Math.max(homeX() + (Math.random() * 2 - 1) * 80, 8), bounds().w - PET - 8);
        startWalk(dest);
      }
    } else if (kit.state === 'yawn' && held > 3) {
      setState('sit');
    } else if (kit.state === 'nap' && held > 7) {
      setState('sit');
    }
  }
  requestAnimationFrame(frame);
}

mini.addEventListener('pointerdown', (e) => {
  mini.setPointerCapture(e.pointerId);
  const r = screen.getBoundingClientRect();
  kit.drag = { sx: e.clientX, sy: e.clientY, ox: e.clientX - r.left - kit.x, oy: e.clientY - r.top - kit.y, moved: false };
});
mini.addEventListener('pointermove', (e) => {
  const d = kit.drag;
  if (!d) return;
  if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 4) {
    d.moved = true;
    hint.classList.add('gone');
    setState('drag');
    mini.classList.add('dragging');
  }
  if (!d.moved) return;
  const r = screen.getBoundingClientRect();
  kit.x = Math.min(Math.max(e.clientX - r.left - d.ox, 0), bounds().w - PET);
  kit.y = Math.min(Math.max(e.clientY - r.top - d.oy, -20), groundY());
  placeKit();
});
mini.addEventListener('pointerup', () => {
  const d = kit.drag;
  kit.drag = null;
  if (!d) return;
  if (!d.moved) return petKitten();
  mini.classList.remove('dragging');
  kit.home = kit.x / (bounds().w - PET - 18);
  kit.vy = 0;
  setState('fall');
});
mini.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    petKitten();
  }
});

addEventListener('resize', () => {
  kit.x = Math.min(kit.x, bounds().w - PET);
  if (kit.state !== 'fall' && kit.state !== 'drag') kit.y = groundY();
  placeKit();
});

function tickClock() {
  clock.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
tickClock();
setInterval(tickClock, 15000);

// Drop in once the screen has slid into place.
kit.x = homeX();
placeKit();
setTimeout(() => {
  kit.x = homeX();
  setState('fall');
  requestAnimationFrame((t) => {
    last = t;
    requestAnimationFrame(frame);
  });
}, 650);

// ---------- kitten card ----------

const kittenSprite = document.getElementById('kitten-sprite');
document.querySelector('.chips[data-target="kitten"]')?.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  chip.parentElement.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === chip));
  updateSprite(kittenSprite, { sheet: chip.dataset.sheet, frames: chip.dataset.frames, fps: chip.dataset.fps });
});

// ---------- tabby card ----------

const tabbySprite = document.getElementById('tabby-sprite');
document.querySelector('.chips[data-target="tabby"]')?.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  chip.parentElement.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === chip));
  updateSprite(tabbySprite, { sheet: chip.dataset.sheet, frames: chip.dataset.frames, fps: chip.dataset.fps });
});

// ---------- cat dress-up ----------

const CAT_ACTIONS = [
  ['Sitting', { row: 0, frames: 1, fps: 1 }],
  ['Walking', { row: 6, frames: 8, fps: 10 }],
  ['Washing', { row: 36, frames: 9, fps: 8 }],
  ['Yawning', { row: 32, frames: 8, fps: 8 }],
  ['Scratching', { row: 39, frames: 11, fps: 10 }],
  ['Meowing', { row: 28, frames: 3, fps: 5 }],
  ['Swatting', { row: 47, frames: 7, fps: 12 }],
  ['Hind legs', { row: 52, frames: 4, fps: 6 }],
  ['Hissing', { row: 42, frames: 2, fps: 4 }],
  ['Sleeping', { row: 13, frames: 2, fps: 1.5 }],
];
const CAT_COLORS = [
  ['ginger', 'Ginger', '#c8642f'],
  ['white', 'White', '#ece8ee'],
  ['black', 'Black', '#4b4a56'],
];
const CAT_OUTFITS = [
  ['', 'None'],
  ['pink-bow', 'Pink bow'],
  ['red-bow', 'Red bow'],
  ['gold-bow', 'Gold bow'],
  ['pink-ribbon', 'Pink ribbon'],
  ['blue-ribbon', 'Blue ribbon'],
  ['green-ribbon', 'Green ribbon'],
  ['red-heart-glasses', 'Heart glasses'],
  ['gold-heart-glasses', 'Gold glasses'],
  ['halo', 'Halo'],
  ['wings', 'Wings'],
  ['cupid', 'Cupid'],
];

const catSprite = document.getElementById('cat-sprite');
const catOutfit = document.getElementById('cat-outfit');
const cat = { action: CAT_ACTIONS[0][1], color: 'ginger', outfit: '' };

function drawCat() {
  const a = { row: String(cat.action.row), frames: String(cat.action.frames), fps: String(cat.action.fps) };
  updateSprite(catSprite, { ...a, sheet: `assets/cat/colors/${cat.color}.png` });
  updateSprite(catOutfit, { ...a, sheet: cat.outfit ? `assets/cat/outfits/${cat.outfit}.png` : '' });
}

function chipGroup(container, items, onPick, render) {
  items.forEach((item, i) => {
    const b = render(item);
    if (i === 0) b.classList.add('on');
    b.addEventListener('click', () => {
      container.querySelectorAll('.on').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      onPick(item);
      drawCat();
    });
    container.appendChild(b);
  });
}

const chip = (label) => Object.assign(document.createElement('button'), { className: 'chip', textContent: label });

chipGroup(document.getElementById('cat-actions'), CAT_ACTIONS, ([, a]) => (cat.action = a), ([label]) => chip(label));
chipGroup(document.getElementById('cat-outfits'), CAT_OUTFITS, ([id]) => (cat.outfit = id), ([, label]) => chip(label));
chipGroup(
  document.getElementById('cat-colors'),
  CAT_COLORS,
  ([id]) => (cat.color = id),
  ([, label, hex]) => {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.style.background = hex;
    return b;
  },
);
drawCat();

// ---------- downloads ----------

function detectOS() {
  const ua = navigator.userAgent;
  const platform = (navigator.userAgentData?.platform || navigator.platform || '').toLowerCase();
  if (/android|iphone|ipad|ipod/i.test(ua)) return null; // phones: just show all three
  if (platform.includes('mac') || /mac os x/i.test(ua)) return 'mac';
  if (platform.includes('win') || /windows/i.test(ua)) return 'windows';
  if (platform.includes('linux') || /linux|x11/i.test(ua)) return 'linux';
  return null;
}

document.querySelectorAll('[data-file]').forEach((a) => {
  a.href = fileUrl(a.dataset.file);
});
document.querySelectorAll('[data-version]').forEach((el) => (el.textContent = VERSION));
document.getElementById('releases-link').href = releases;

// GitHub redirects the click through two hops before the file lands, so give the
// button some feedback right away — otherwise the wait can look like a freeze.
function markStarting(a) {
  const label = a.querySelector('.btn-label') || a;
  if (a.dataset.busy) return;
  const original = label.textContent;
  a.dataset.busy = '1';
  label.textContent = 'Starting download…';
  setTimeout(() => {
    label.textContent = original;
    delete a.dataset.busy;
  }, 4000);
}
document.querySelectorAll('[data-file], #primary-download').forEach((a) => {
  a.addEventListener('click', () => markStarting(a));
});

const os = detectOS();
const primary = document.getElementById('primary-download');
const note = document.getElementById('primary-note');
if (os) {
  document.querySelector(`.dl-card[data-os="${os}"]`)?.classList.add('mine');
  const names = { windows: 'Windows', mac: 'macOS', linux: 'Linux' };
  primary.querySelector('.btn-label').textContent = `Download for ${names[os]}`;
  primary.href = fileUrl(os === 'linux' ? 'appimage' : os);
  note.textContent = `Free · v${VERSION} · No account, no internet. About 1% of one CPU core.`;
} else {
  note.textContent = 'Available for Windows, macOS and Linux. Open this page on your computer to download.';
}
