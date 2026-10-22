// Desktop pet engine.
//
// The window is a transparent overlay covering the monitor's work area. It
// never moves: the pet moves inside it, and the window lets the mouse through
// everywhere except the pet's hitbox (see `mod hit` in main.rs). Moving a
// webview window is expensive; repainting one small sprite is not.
//
// The loop only runs as fast as the current animation needs (10 fps walking,
// 1.5 fps asleep, 2 fps for a still pose) and not at all while a fullscreen
// app is in front. Hearts and z's are moved by this loop rather than by CSS
// animations, which would repaint at 60 fps.
//
// Pets are described by src/pets/<id>/pet.json. Any animation a pet lacks is
// simply skipped (one-shots) or replaced by its `fallback` pose (loops).

const { getCurrentWindow, currentMonitor, monitorFromPoint, cursorPosition } = window.__TAURI__.window;
const { PhysicalPosition, PhysicalSize } = window.__TAURI__.dpi;
const { listen } = window.__TAURI__.event;
const { invoke } = window.__TAURI__.core;

const DEFAULT_PET = 'kitten';
const GRAVITY = 2600; // CSS px/s²
const STILL_FPS = 2; // loop rate while holding a single-frame pose
const FX_FPS = 8; // loop rate while hearts or z's are floating
const PAW_COOLDOWN = 4000; // ms between swats at the cursor
const HOME_RANGE = 1.6; // how far the pet strolls from its home spot, in pet widths

// fixed: loop rate that overrides the animation's own (for movement).
// dur: seconds [min, max] before picking something else to do.
const MODES = {
  sit: { dur: [6, 14] },
  lie: { dur: [8, 20] },
  walk: { dur: [3, 8], fixed: 10 },
  sleep: { dur: [20, 45] },
  drag: { fixed: 10 }, // the pointer handlers move the pet; the loop only animates
  fall: { fixed: 60 },
};

const win = getCurrentWindow();
const petRoot = document.getElementById('root');
const bodyEl = document.getElementById('body');
const spriteEl = document.getElementById('sprite');
const petEl = document.getElementById('pet');
const outfitEl = document.getElementById('outfit');
const fxEl = document.getElementById('fx');

const petId = localStorage.getItem('pet') ?? DEFAULT_PET;
const saved = (key, fallback) => localStorage.getItem(`${petId}:${key}`) ?? fallback;
const save = (key, value) => localStorage.setItem(`${petId}:${key}`, value);

let pet; // contents of pet.json
let base = ''; // pets/<id>/
const sizes = {}; // natural [width, height] of each sprite file
let colorDef = null;
let outfitDef = null;
let roam = localStorage.getItem('roam') === 'true';
let home = Number(saved('home', 1)); // home spot, 0 = left edge, 1 = right edge

let anim = null; // current animation
let animFile = '';
let loopName = 'sit'; // what to go back to after a color change
let animOnce = null; // callback when a one-shot animation finishes; null while looping
let frame = 0;
let frameAcc = 0;
let hopPhase = 0;

let mode = 'sit';
let modeUntil = 0;
let nextFidget = 0;
let walkTarget = null; // x to stop walking at, or null to just wander
let timer = null;
let lastTick = 0;
let paused = false;

let area = { x: 0, y: 0, w: 0, h: 0 }; // work area the window covers (excludes taskbar), physical px
let dpr = 1;
let view = { w: 0, h: 0 }; // the same area in CSS px
let box = { w: 0, h: 0 }; // the pet's cell, cut off below its feet, CSS px
const pos = { x: 0, y: 0 }; // top-left of the pet's box inside the window, CSS px
let shown = { x: NaN, y: NaN };
let hitboxKey = '';
let vy = 0;
let dir = -1; // -1 = left, 1 = right

let pointer = null; // pointerdown that may become a click or a drag
let dragOffset = null;
let shake = { lastX: 0, lastDx: 0, flips: 0, since: 0 };
let grumpy = false;

let cursorBusy = false;
let lastCursor = null;
let lastPaw = 0;

let zTimer = null;
const particles = []; // floating hearts and z's

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const now = () => performance.now();
const ground = () => view.h - box.h;
const side = () => (dir < 0 ? 'left' : 'right');
const maxX = () => view.w - box.w;
const homeX = () => home * maxX();

// ---------- sprites ----------

function loadImage(file) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve((sizes[file] = [img.naturalWidth, img.naturalHeight]));
    img.onerror = resolve;
    img.src = base + file;
  });
}

async function loadPet(id) {
  base = `pets/${id}/`;
  pet = await (await fetch(base + 'pet.json')).json();
  pet.outfits ??= [];
  pet.fidgets ??= {};
  pet.reactions ??= {};
  pet.sleepPoses ??= [pet.fallback];
  for (const a of Object.values(pet.animations)) {
    a.col ??= 0;
    a.dy ??= 0;
    a.fps ??= 0;
  }
  const files = new Set([
    ...pet.colors.map((c) => c.file),
    ...pet.outfits.map((o) => o.file),
    ...Object.values(pet.animations).map((a) => a.file).filter(Boolean),
  ]);
  await Promise.all([...files].map(loadImage)); // also preloads, so swaps are instant

  const cell = pet.frameSize * pet.scale;
  for (const el of [petEl, outfitEl, spriteEl]) el.style.width = el.style.height = cell + 'px';
  box = { w: cell, h: pet.ground * pet.scale };
  petRoot.style.width = box.w + 'px';
  petRoot.style.height = box.h + 'px';
}

function setColor(id) {
  colorDef = pet.colors.find((c) => c.id === id) ?? pet.colors[0];
  save('color', colorDef.id);
  if (anim && !animOnce) loop(loopName); // the color may swap animations, not just the sheet
  else if (anim) applySheet();
}

function setOutfit(id) {
  outfitDef = pet.outfits.find((o) => o.id === id) ?? null;
  save('outfit', outfitDef?.id ?? '');
  applySheet();
}

/**
 * Resolve `name`, preferring a `name_left` / `name_right` variant for the
 * current facing, and following the color's remap (e.g. a costume).
 */
function animation(name) {
  const remap = colorDef.remap ?? {};
  for (const n of [`${name}_${side()}`, name]) {
    const a = pet.animations[remap[n] ?? n];
    if (a) return a;
  }
  return null;
}

/** Loop an animation (or hold a single-frame pose). */
function loop(name) {
  loopName = name;
  setAnim(animation(name) ?? animation(pet.fallback), null);
}

/** Play an animation once, then call `done`. Pets without it skip straight to `done`. */
function playOnce(name, done) {
  const a = animation(name);
  if (!a) return done();
  setAnim(a, done);
  schedule(); // its fps may differ from what the loop is running at
}

function setAnim(a, done) {
  anim = a;
  animOnce = done;
  frame = 0;
  frameAcc = 0;
  spriteEl.style.top = `${a.dy * pet.scale}px`; // line the feet up with the ground
  applySheet();
}

/** Point both layers at the right image for the current animation, then draw. */
function applySheet() {
  const file = anim.file ?? colorDef.file;
  if (file !== animFile) {
    animFile = file;
    const [w, h] = sizes[file];
    petEl.style.backgroundImage = `url("${base + file}")`;
    petEl.style.backgroundSize = `${w * pet.scale}px ${h * pet.scale}px`;
  }
  // Outfits are drawn for the main sheet's layout only.
  const dressed = outfitDef && !anim.file;
  outfitEl.style.backgroundImage = dressed ? `url("${base + outfitDef.file}")` : 'none';
  if (dressed) {
    const [w, h] = sizes[outfitDef.file];
    outfitEl.style.backgroundSize = `${w * pet.scale}px ${h * pet.scale}px`;
  }
  drawFrame();
}

function drawFrame() {
  const cell = pet.frameSize * pet.scale;
  const p = `${-(anim.col + frame) * cell}px ${-anim.row * cell}px`;
  petEl.style.backgroundPosition = p;
  outfitEl.style.backgroundPosition = p;
}

function advanceFrames(dt) {
  if (anim.frames < 2 || !anim.fps) return;
  frameAcc += dt;
  const spf = 1 / anim.fps;
  let changed = false;
  while (frameAcc >= spf) {
    frameAcc -= spf;
    changed = true;
    if (frame + 1 < anim.frames) {
      frame++;
    } else if (animOnce) {
      const done = animOnce;
      animOnce = null;
      done();
      return; // done() has set up whatever comes next
    } else {
      frame = 0;
    }
  }
  if (changed) drawFrame();
}

// ---------- window + position ----------

const sameArea = (m) =>
  m.workArea.position.x === area.x &&
  m.workArea.position.y === area.y &&
  m.workArea.size.width === area.w &&
  m.workArea.size.height === area.h;

/** Cover the work area of the monitor at screen point (x, y). Returns true if that changed anything. */
async function placeWindow(x, y) {
  const m = (await monitorFromPoint(x, y)) ?? (await currentMonitor());
  if (!m || sameArea(m)) return false;
  area = {
    x: m.workArea.position.x,
    y: m.workArea.position.y,
    w: m.workArea.size.width,
    h: m.workArea.size.height,
  };
  dpr = m.scaleFactor;
  view = { w: area.w / dpr, h: area.h / dpr };
  await win.setPosition(new PhysicalPosition(area.x, area.y));
  await win.setSize(new PhysicalSize(area.w, area.h));
  return true;
}

/** Screen position (physical px) of a point given in window CSS px. */
const toScreen = (x, y) => ({ x: area.x + x * dpr, y: area.y + y * dpr });

/** Move the pet inside the window, and tell Rust where its hitbox now is. */
function render() {
  // Snap to whole device pixels so the pixel art stays crisp.
  const x = Math.round(pos.x * dpr) / dpr;
  const y = Math.round(pos.y * dpr) / dpr;
  if (x === shown.x && y === shown.y) return;
  shown = { x, y };
  petRoot.style.translate = `${x}px ${y}px`;

  const [x0, y0, x1, y1] = pet.hitbox;
  const tl = toScreen(x + x0 * pet.scale, y + y0 * pet.scale);
  const hb = { x: tl.x, y: tl.y, w: (x1 - x0) * pet.scale * dpr, h: (y1 - y0) * pet.scale * dpr };
  const key = `${Math.round(hb.x)},${Math.round(hb.y)}`;
  if (key !== hitboxKey) {
    hitboxKey = key;
    invoke('set_hitbox', hb);
  }
}

function clampX() {
  pos.x = Math.min(Math.max(pos.x, 0), maxX());
}

/** Keep the pet on the floor if the taskbar moved, the resolution changed, etc. */
async function checkArea() {
  const at = toScreen(pos.x, pos.y);
  const c = toScreen(pos.x + box.w / 2, pos.y + box.h / 2);
  if (!(await placeWindow(c.x, c.y))) return;
  pos.x = (at.x - area.x) / dpr;
  shown = { x: NaN, y: NaN };
  if (mode !== 'drag' && mode !== 'fall') {
    clampX();
    pos.y = ground();
    render();
  }
}

// ---------- modes ----------

function setMode(name, seconds) {
  mode = name;
  const m = MODES[name];
  modeUntil = now() + (seconds ?? (m.dur ? rand(...m.dur) : Infinity)) * 1000;
  nextFidget = now() + rand(2, 6) * 1000;
  if (name !== 'walk') walkTarget = null;
  bodyEl.className = name;
  bodyEl.style.translate = '';
  stopZzz();

  if (name === 'sit') loop('sit');
  else if (name === 'lie') loop('lie');
  else if (name === 'walk') loop('walk');
  else if (name === 'drag' || name === 'fall') loop('dangle');
  else if (name === 'sleep') {
    const pose = pick(pet.sleepPoses);
    playOnce('yawn_sit', () => {
      loop(pose);
      startZzz();
    });
  }

  lastTick = now();
  schedule();
}

/** Walk to `target` (CSS x) and sit down there, or wander for a while if target is null. */
function startWalk(target, seconds) {
  if (target === null) {
    walkTarget = null;
    setMode('walk', seconds);
    return;
  }
  target = Math.min(Math.max(target, 0), maxX());
  if (Math.abs(target - pos.x) < box.w * 0.25) return setMode('sit');
  dir = target < pos.x ? -1 : 1;
  setMode('walk', 60);
  walkTarget = target;
}

function nextMode() {
  if (mode === 'sleep') return wake();
  checkArea();
  const night = new Date().getHours() >= 23 || new Date().getHours() < 6; // sleepier late at night

  if (!roam && Math.abs(pos.x - homeX()) > box.w * HOME_RANGE * 1.5) {
    return startWalk(homeX()); // wandered (or was dropped) away from home: head back
  }
  const weights = roam
    ? { walk: 40, sit: 30, lie: 15, sleep: night ? 45 : 15 }
    : { walk: 15, sit: 40, lie: 25, sleep: night ? 50 : 20 };
  let r = Math.random() * Object.values(weights).reduce((a, b) => a + b);
  for (const [name, w] of Object.entries(weights)) {
    if ((r -= w) > 0) continue;
    if (name !== 'walk') return setMode(name);
    if (!roam) return startWalk(homeX() + rand(-HOME_RANGE, HOME_RANGE) * box.w);
    // Roaming: head away from a nearby edge, otherwise pick a random direction.
    dir = pos.x < box.w * 2 ? 1 : maxX() - pos.x < box.w * 2 ? -1 : pick([-1, 1]);
    return startWalk(null);
  }
}

function wake() {
  stopZzz();
  mode = 'sit';
  bodyEl.className = 'sit';
  playOnce('yawn_sit', () => setMode('sit'));
}

// ---------- loop ----------

function loopFps() {
  let fps = MODES[mode].fixed ?? (anim.frames > 1 && anim.fps ? anim.fps : STILL_FPS);
  if (particles.length) fps = Math.max(fps, FX_FPS);
  return fps;
}

function schedule() {
  clearTimeout(timer);
  if (!paused) timer = setTimeout(tick, 1000 / loopFps());
}

function tick() {
  const t = now();
  const dt = Math.min((t - lastTick) / 1000, 0.1);
  lastTick = t;

  advanceFrames(dt);
  updateParticles(dt);

  if (mode === 'walk') walk(dt);
  else if (mode === 'fall') fall(dt);
  else if ((mode === 'sit' || mode === 'lie') && !animOnce) {
    if (animation('paw')) watchCursor();
    const fidgets = pet.fidgets[mode];
    if (fidgets && t > nextFidget) {
      nextFidget = t + rand(4, 10) * 1000;
      const back = mode;
      playOnce(pick(fidgets), () => loop(back));
    }
  }

  if (t > modeUntil && !animOnce && mode !== 'drag' && mode !== 'fall') nextMode();
  else schedule();
}

function walk(dt) {
  if (animOnce) return; // stopped for a one-shot (e.g. a meow)
  if (anim.hop) {
    // Pets without a walk cycle bounce along instead, in step with the loop.
    hopPhase = (hopPhase + dt) % 0.4;
    bodyEl.style.translate = `0 ${-Math.round(Math.sin((hopPhase / 0.4) * Math.PI) * 5)}px`;
  }
  pos.x += dir * pet.walkSpeed * (grumpy ? 2.2 : 1) * dt;

  if (walkTarget !== null && (dir > 0 ? pos.x >= walkTarget : pos.x <= walkTarget)) {
    pos.x = walkTarget;
    render();
    return setMode(Math.random() < 0.7 ? 'sit' : 'lie');
  }
  if (pos.x <= 0 || pos.x >= maxX()) {
    clampX();
    dir = -dir;
    loop('walk');
  }
  render();
}

function fall(dt) {
  vy += GRAVITY * dt;
  pos.y += vy * dt;
  if (pos.y < ground()) return render();

  pos.y = ground();
  vy = 0;
  render();
  if (grumpy) {
    // Shaken too hard: hiss, then stomp off quickly.
    mode = 'sit';
    bodyEl.className = 'sit land';
    playOnce('hiss', () => {
      const away = pos.x > view.w / 2 ? -1 : 1;
      if (roam) {
        dir = away;
        startWalk(null, rand(2, 3.5));
      } else {
        startWalk(pos.x + away * box.w * 2);
      }
      setTimeout(() => (grumpy = false), 3500);
    });
  } else {
    setMode('sit');
    bodyEl.classList.add('land');
  }
}

/** Swat at the mouse when it moves close by. */
function watchCursor() {
  if (cursorBusy || now() - lastPaw < PAW_COOLDOWN) return;
  cursorBusy = true;
  cursorPosition().then((c) => {
    cursorBusy = false;
    const moved = lastCursor && Math.hypot(c.x - lastCursor.x, c.y - lastCursor.y) > 3;
    lastCursor = c;
    if (!moved || animOnce || (mode !== 'sit' && mode !== 'lie')) return;
    const cx = (c.x - area.x) / dpr; // cursor in window CSS px
    const cy = (c.y - area.y) / dpr;
    const mid = pos.x + box.w / 2;
    const near = Math.abs(cx - mid) < box.w * 0.9 && cy > pos.y - box.h * 0.3 && cy < pos.y + box.h;
    if (!near) return;
    lastPaw = now();
    dir = cx < mid ? -1 : 1;
    const back = mode;
    playOnce('paw', () => loop(back));
  });
}

// ---------- mouse ----------

/** Five quick left-right reversals within ~1 s makes the pet grumpy. */
function detectShake(x) {
  const dx = x - shake.lastX;
  shake.lastX = x;
  if (Math.abs(dx) < 12) return;
  if (Math.sign(dx) !== Math.sign(shake.lastDx)) {
    if (now() - shake.since > 1200) {
      shake.flips = 0;
      shake.since = now();
    }
    shake.flips++;
    if (shake.flips >= 5) grumpy = true;
  }
  shake.lastDx = dx;
}

function startDrag(e) {
  setMode('drag');
  grumpy = false;
  shake = { lastX: e.clientX, lastDx: 0, flips: 0, since: now() };
  dragOffset = { x: e.clientX - pos.x, y: e.clientY - pos.y };
}

function moveDrag(e) {
  pos.x = e.clientX - dragOffset.x;
  pos.y = e.clientY - dragOffset.y;
  render();
  detectShake(e.clientX);
}

async function endDrag() {
  dragOffset = null;
  // Dropped on another monitor? Move the window there and keep the pet where it was let go.
  const at = toScreen(pos.x, pos.y);
  const c = toScreen(pos.x + box.w / 2, pos.y + box.h / 2);
  if (await placeWindow(c.x, c.y)) {
    pos.x = (at.x - area.x) / dpr;
    pos.y = (at.y - area.y) / dpr;
    shown = { x: NaN, y: NaN };
  }
  clampX();
  pos.y = Math.min(Math.max(pos.y, 0), ground()); // dropped onto the taskbar, or above the screen
  render();
  // Wherever you put it becomes its new home spot.
  home = maxX() > 0 ? pos.x / maxX() : 1;
  save('home', home.toFixed(4));
  vy = 0;
  setMode('fall');
}

function onPet() {
  spawnFx('heart', '♥');
  setTimeout(() => spawnFx('heart', '♥'), 180);
  if (mode === 'sleep') return wake();
  if (animOnce || mode === 'drag' || mode === 'fall') return;
  const back = mode === 'walk' ? 'walk' : mode;
  const reactions = pet.reactions[mode === 'lie' ? 'lie' : 'sit'];
  if (reactions?.length) return playOnce(pick(reactions), () => loop(back));
  // No reaction animations: a happy little jump.
  bodyEl.classList.remove('happy');
  void bodyEl.offsetWidth; // restart the CSS animation
  bodyEl.classList.add('happy');
}

petEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  petEl.setPointerCapture(e.pointerId);
  invoke('hold_cursor', { hold: true });
  pointer = { x: e.clientX, y: e.clientY, moved: false };
});

petEl.addEventListener('pointermove', (e) => {
  if (!pointer) return;
  if (pointer.moved) return moveDrag(e);
  if (Math.hypot(e.clientX - pointer.x, e.clientY - pointer.y) > 4) {
    pointer.moved = true;
    startDrag(e);
  }
});

petEl.addEventListener('pointerup', () => {
  if (!pointer) return;
  const p = pointer;
  pointer = null;
  invoke('hold_cursor', { hold: false });
  if (p.moved) endDrag();
  else onPet();
});

window.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------- effects ----------

function spawnFx(kind, text) {
  const el = document.createElement('span');
  el.className = `fx ${kind}`;
  el.textContent = text;
  el.style.left = `${rand(35, 60)}%`;
  el.style.top = '4px';
  el.style.opacity = '0';
  fxEl.appendChild(el);
  particles.push({ el, age: 0, life: 1.4, dx: rand(-12, 12) });
  if (particles.length === 1) schedule(); // speed the loop up if it was holding a pose
}

function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.age += dt;
    const k = p.age / p.life;
    if (k >= 1) {
      p.el.remove();
      particles.splice(i, 1);
      continue;
    }
    p.el.style.opacity = String(k < 0.2 ? k / 0.2 : 1 - (k - 0.2) / 0.8);
    p.el.style.translate = `${Math.round(p.dx * k)}px ${Math.round(-30 * k)}px`;
  }
}

function startZzz() {
  stopZzz();
  zTimer = setInterval(() => spawnFx('z', 'z'), 1600);
}

function stopZzz() {
  clearInterval(zTimer);
  zTimer = null;
}

// ---------- tray + system events ----------

function dropFromTop() {
  pos.x = roam ? view.w * rand(0.3, 0.8) : homeX();
  pos.y = -box.h * 0.3;
  clampX();
  vy = 0;
  render();
  setMode('fall');
}

listen('tray', ({ payload }) => {
  if (payload === 'sleep') setMode('sleep');
  if (payload === 'reset') dropFromTop();
});

listen('pet', ({ payload }) => {
  localStorage.setItem('pet', payload);
  location.reload();
});
listen('color', ({ payload }) => setColor(payload));
listen('outfit', ({ payload }) => setOutfit(payload));
listen('roam', ({ payload }) => {
  roam = payload;
  localStorage.setItem('roam', String(roam));
  if (!roam && mode === 'walk' && walkTarget === null) startWalk(homeX());
});

listen('fullscreen', ({ payload }) => {
  paused = payload;
  if (paused) {
    clearTimeout(timer);
    stopZzz();
  } else {
    lastTick = now();
    if (mode === 'sleep' && !animOnce) startZzz();
    schedule();
  }
});

// ---------- start ----------

(async () => {
  const pets = await (await fetch('pets/index.json')).json();
  await loadPet(pets.some((p) => p.id === petId) ? petId : DEFAULT_PET);
  colorDef = pet.colors.find((c) => c.id === saved('color', '')) ?? pet.colors[0];
  outfitDef = pet.outfits.find((o) => o.id === saved('outfit', '')) ?? null;

  invoke('set_menu', {
    pets,
    pet: petId,
    colors: pet.colors.map(({ id, name }) => ({ id, name })),
    color: colorDef.id,
    outfits: pet.outfits.map(({ id, name }) => ({ id, name })),
    outfit: outfitDef?.id ?? '',
    roam,
  });

  const m = await currentMonitor();
  await placeWindow(m.position.x + m.size.width / 2, m.position.y + m.size.height / 2);
  dropFromTop(); // entrance: fall in from the top of the screen
  await win.show();
})();
