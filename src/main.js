// Desktop pet engine.
//
// The window is a transparent overlay covering the monitor's work area. It
// never moves: the pet moves inside it, and the window lets the mouse through
// everywhere except the pet's hitbox and its toys (see `mod hit` in main.rs).
// Moving a webview window is expensive; repainting one small sprite is not.
//
// The loop only runs as fast as the current animation needs and not at all
// while a fullscreen app is in front. Hearts and z's are moved by this loop
// rather than by CSS animations, which would repaint at 60 fps.
//
// Pets are described by src/pets/<id>/pet.json. Any animation a pet lacks is
// simply skipped (one-shots) or replaced by its `fallback` pose (loops).
//
// Everything here only uses the pet's own window, so it works the same on
// Windows, macOS and Linux.

const { getCurrentWindow, currentMonitor, monitorFromPoint, cursorPosition } = window.__TAURI__.window;
const { PhysicalPosition, PhysicalSize } = window.__TAURI__.dpi;
const { listen, emit } = window.__TAURI__.event;
const { invoke } = window.__TAURI__.core;

const DEFAULT_PET = 'tabby';
const GRAVITY = 2600; // CSS px/s²
const STILL_FPS = 2; // loop rate while holding a single-frame pose
const FX_FPS = 8; // loop rate while hearts or z's are floating
const PAW_COOLDOWN = 4000; // ms between swats at the cursor
const HUNT_COOLDOWN = 25000; // ms between pounces on a resting cursor
const MAX_FLING = 2400; // fastest a leap can carry the pet sideways, CSS px/s
const BOUNCE = 0.5; // speed kept when it hits a wall or the ceiling
const CHASE_SPEED = 2.8; // running after the yarn, times the walking speed
const RUN_FROM = 150; // CSS px/s: at this speed or faster it runs instead of walking
const HOUR = 3600 * 1000;
const HUNGRY_AFTER = 6 * HOUR; // from full to starving
const HUNGRY = 70; // hunger (0-100) at which it starts asking for food

// fixed: loop rate that overrides the animation's own (for movement).
// dur: seconds [min, max] before picking something else to do.
const MODES = {
  sit: { dur: [16, 36] }, // calm sitting / observing
  lie: { dur: [22, 50] }, // relaxed loafing
  walk: { dur: [3, 6], fixed: 30 }, // short, natural strolls
  sleep: { dur: [30, 60] }, // cozy catnaps
  drag: { fixed: 30 }, // the pointer handlers move the pet; the loop animates the swing
  fall: { fixed: 60 },
  eat: { dur: [6, 8] },
  hunt: { dur: [1.2, 2.2] }, // wiggling before a pounce
  chase: { dur: [30, 60], fixed: 30 }, // playing with the yarn
  hidden: { dur: [4, 10] }, // walked off the edge of the screen
  peek: { dur: [30, 30] }, // its peek animation decides when it's over
};

const win = getCurrentWindow();
const petRoot = document.getElementById('root');
const bodyEl = document.getElementById('body');
const spriteEl = document.getElementById('sprite');
const petEl = document.getElementById('pet');
const outfitEl = document.getElementById('outfit');
const fxEl = document.getElementById('fx');
const worldEl = document.getElementById('world');
const frontEl = document.getElementById('front');

// One-time switch to the new tabby for anyone who had picked another pet before.
if (!localStorage.getItem('tabby-intro')) {
  localStorage.setItem('tabby-intro', '1');
  localStorage.setItem('pet', DEFAULT_PET);
}
const petId = localStorage.getItem('pet') ?? DEFAULT_PET;
const saved = (key, fallback) => localStorage.getItem(`${petId}:${key}`) ?? fallback;
const save = (key, value) => localStorage.setItem(`${petId}:${key}`, value);
const loadJson = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
};

let pet; // contents of pet.json
let base = ''; // pets/<id>/
const sizes = {}; // natural [width, height] of each sprite file
const images = {}; // the loaded sprite sheets
let colorDef = null;
let outfitDef = null;
const roam = true; // always free roam: wander and leap anywhere on screen
let home = Number(saved('home', 1)); // last drop spot, 0 = left edge, 1 = right edge

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
let walkFree = false; // allowed to walk off the edge of the screen (to hide)
let walkBoost = 1; // trotting (to its food bowl): faster than its usual walk
let onArrive = null; // what to do on reaching walkTarget
let next = null; // what to do once the pet is back on its feet (after a drop or a jump down)
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
let vx = 0; // horizontal speed while airborne (leaping)
let dir = -1; // -1 = left, 1 = right

let pointer = null; // pointerdown that may become a click or a drag
let dragOffset = null;
let shake = { lastX: 0, lastDx: 0, flips: 0, since: 0 };
let grumpy = false;
let leaping = false; // airborne from a pounce (not dropped)

let cursorBusy = false;
let lastCursorPoll = 0;
let userBusyUntil = 0; // timestamp until when user was actively moving mouse
const cur = { x: NaN, y: NaN, movedAt: 0, rested: true }; // cursor in window CSS px
let lastPaw = 0;
let lastHunt = 0;

let zTimer = null;
const particles = []; // floating hearts and z's
let bubble = null; // speech bubble on screen: { el, kind, timer }
let pending = null; // a message waiting for the pet to sit down: { text, kind, ms, center }
const BUBBLE_RANK = { hungry: 1, break: 2, focus: 3, reminder: 4 };
let swing = 0; // how far the held pet is swinging, degrees
let swingV = 0;
let lastDragX = 0;
let napUntilBack = false; // asleep because you stepped away
let lastWoke = -Infinity; // so it doesn't nap again straight after waking up

let love = Number(saved('love', 50)); // 0-100: how loved the pet feels
let loveAt = Number(saved('loveAt', Date.now()));
let sulkGreeted = false;
let lastFed = Number(saved('fed', Date.now()));
let lastHungrySay = 0;
let bowl = null; // { els, x, top, w, full, food, held, drag, vy, timer, teased }
let walkToBowl = false; // walking after the bowl, which may be moving
let begSince = 0; // sitting under the bowl you're holding up
let lastBowlHop = 0;
let snatching = false; // mid-jump at the bowl you're holding
let eatStart = 0;
let eatLength = 0;
let yarn = null; // { el, x, y, vx, vy, rot, timer, last, drag, touched }
let playTired = 0; // when it last got bored of the yarn
let focus = loadJson('focus', null); // { end, minutes }
let clockEl = null;
let clockTimer = null;
let reminders = loadJson('reminders', []); // [{ id, at, text }]
let hideSide = -1;
let peeks = 0;

const BREAK_LINES = [
  'Time for a stretch?',
  'Break time! Rest your eyes.',
  'Water break?',
  'Stretch with me?',
  "You've been busy. Short break?",
];
const HUNGRY_LINES = ["I'm hungry!", 'Food please?', 'Is it dinner time?', 'My bowl is empty...'];

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const now = () => performance.now();
const ground = () => view.h - box.h;
const side = () => (dir < 0 ? 'left' : 'right');
const maxX = () => view.w - box.w;
const settled = () => mode === 'sit' || mode === 'lie';
// Walking limits: the screen.
const minWalkX = () => 0;
const maxWalkX = () => maxX();

// ---------- sprites ----------

function loadImage(file) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      images[file] = img;
      resolve((sizes[file] = [img.naturalWidth, img.naturalHeight]));
    };
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
  // Drop animations whose sheet failed to load, so they fall back instead of breaking.
  for (const [name, a] of Object.entries(pet.animations)) if (a.file && !sizes[a.file]) delete pet.animations[name];
  findHeads();

  const cell = pet.frameSize * pet.scale;
  for (const el of [petEl, outfitEl, spriteEl]) el.style.width = el.style.height = cell + 'px';
  // Pixel-art pets scale with hard edges; drawn pets (smooth: true) scale normally.
  petEl.style.imageRendering = outfitEl.style.imageRendering = pet.smooth ? 'auto' : '';
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
    } else if (anim.hold) {
      break; // hold the last frame (e.g. tucked up mid-jump)
    } else {
      frame = 0;
    }
  }
  if (changed) drawFrame();
}

/**
 * Where the head is in each animation (top of the cat, and the middle of the
 * part just below it), so hearts and z's float up from the head rather than
 * from the top of the frame.
 */
function findHeads() {
  const f = pet.frameSize;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = f;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  for (const a of Object.values(pet.animations)) {
    const img = images[a.file];
    if (!img) continue;
    g.clearRect(0, 0, f, f);
    g.drawImage(img, a.col * f, a.row * f, f, f, 0, 0, f, f);
    let px;
    try {
      px = g.getImageData(0, 0, f, f).data;
    } catch {
      continue;
    }
    const solid = (x, y) => px[(y * f + x) * 4 + 3] > 60;
    let top = -1;
    for (let y = 0; y < f && top < 0; y++) for (let x = 0; x < f; x++) if (solid(x, y)) { top = y; break; }
    if (top < 0) continue;
    let sum = 0;
    let n = 0;
    for (let y = top; y < Math.min(f, top + 50); y++) for (let x = 0; x < f; x++) if (solid(x, y)) { sum += x; n++; }
    a.top = top;
    a.headX = n ? sum / n : f / 2;
  }
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
  // Snap to whole device pixels so the art stays crisp.
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
  pos.x = clamp(pos.x, 0, maxX());
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
  if (name !== 'walk') {
    walkTarget = null;
    walkFree = false;
    onArrive = null;
  }
  walkBoost = 1;
  walkToBowl = false;
  bodyEl.className = name;
  bodyEl.style.translate = '';
  bodyEl.style.rotate = '';
  // Held by the scruff: swing from the grip point (pet.json "grip"), not the feet.
  bodyEl.style.transformOrigin =
    name === 'drag' && pet.grip ? `${pet.grip[0] * pet.scale}px ${pet.grip[1] * pet.scale}px` : '';
  stopZzz();
  stopSleepPurr();

  if (name === 'sit') loop('sit');
  else if (name === 'lie') {
    if (animation('lie_down')) playOnce('lie_down', () => loop('lie'));
    else loop('lie');
  } else if (name === 'walk' || name === 'chase') loop(gait());
  else if (name === 'drag') loop(animation('held') ? 'held' : 'dangle');
  else if (name === 'fall') loop(leaping && animation('jump') ? 'jump' : 'dangle');
  else if (name === 'eat') loop('eat');
  else if (name === 'hunt') loop(animation('hunt') ? 'hunt' : 'crouch');
  else if (name === 'hidden') loop('sit'); // off screen, so it doesn't matter
  else if (name === 'sleep') {
    const pose = pick(pet.sleepPoses);
    playOnce('yawn_sit', () => {
      loop(pose);
      startZzz();
      startSleepPurr();
    });
  }

  lastTick = now();
  schedule();
}

/**
 * Walk to `target` (CSS x) and then call `arrive` (or sit down), or wander for
 * a while if target is null. `free` lets it walk off the edge of the screen.
 */
function startWalk(target, seconds, arrive = null, free = false) {
  if (target === null) {
    setMode('walk', seconds);
    return;
  }
  if (!free) target = clamp(target, minWalkX(), maxWalkX());
  if (Math.abs(target - pos.x) < box.w * 0.1) {
    pos.x = target;
    render();
    return arrive ? arrive() : setMode('sit');
  }
  dir = target < pos.x ? -1 : 1;
  setMode('walk', seconds ?? 60);
  walkTarget = target;
  walkFree = free;
  onArrive = arrive;
}

/** How fast it's moving along the ground right now, CSS px/s. */
function currentSpeed() {
  if (mode === 'chase') return pet.walkSpeed * CHASE_SPEED;
  return pet.walkSpeed * (grumpy ? 2.2 : walkBoost);
}

/** Running or walking: it runs when it's fast enough (and has a running animation). */
function gait() {
  return currentSpeed() >= RUN_FROM && animation('run') ? 'run' : 'walk';
}

/** Speed up the walk it has just started into a run (or a trot). */
function hurry(boost) {
  if (mode !== 'walk') return;
  walkBoost = boost;
  loop(gait());
}

/** Zoomies: a sudden sprint to the other side of the screen, and sometimes back. */
function zoomies() {
  const far = pos.x < maxX() / 2 ? maxX() : 0;
  startWalk(far, 30, () => {
    if (Math.random() < 0.5) return setMode('sit');
    startWalk(far ? 0 : maxX(), 30); // and back again
    hurry(rand(2.6, 3));
  });
  hurry(rand(2.6, 3.2));
}

/** Hop a few body lengths along the floor: crouch first, then jump. */
function leap() {
  const room = (d) => (d < 0 ? pos.x : maxX() - pos.x);
  let d = pick([-1, 1]);
  if (room(d) < box.w * 1.5) d = -d; // toward the open side
  const dist = Math.min(room(d), rand(1.5, 3.5) * box.w);
  if (dist < box.w) return setMode('sit');
  jumpTo(pos.x + d * dist, rand(0.5, 1.1) * box.h);
}

/**
 * Crouch, then jump to x (CSS px) along an arc `height` px above the start.
 * `toY` is where it lands (pos.y), when that's not the same height it left from.
 */
function jumpTo(x, height, toY = pos.y) {
  const dx = x - pos.x;
  dir = dx < 0 ? -1 : 1;
  mode = 'sit'; // stand still for the crouch
  walkTarget = null;
  onArrive = null;
  bodyEl.className = 'sit';
  bodyEl.style.translate = '';
  playOnce('crouch', () => launch(dx, height, pos.y - toY));
}

/** Once in a while: get to the other side of the screen, by a playful leap or a stroll. */
function crossScreen() {
  const atLeft = pos.x < maxX() / 2;
  const far = atLeft ? maxX() : 0;
  const nearEdge = atLeft ? pos.x < box.w * 1.5 : maxX() - pos.x < box.w * 1.5;
  if (nearEdge && Math.random() < 0.5) {
    // Playful ground-level hop towards the other side
    const hopDist = (atLeft ? 1 : -1) * rand(2.5, 4.5) * box.w;
    return jumpTo(pos.x + hopDist, rand(0.6, 1.1) * box.h);
  }
  startWalk(far, 60); // stroll all the way over
}

/**
 * Jump along an arc that peaks `height` px above the start, drifts `dx` px
 * sideways and comes down `rise` px higher than it started (negative: lower).
 */
function launch(dx, height, rise = 0) {
  dir = dx < 0 ? -1 : 1;
  const h = Math.max(height, rise + box.h * 0.3, box.h * 0.4);
  const up = Math.sqrt((2 * h) / GRAVITY); // seconds to the peak
  const down = Math.sqrt((2 * (h - rise)) / GRAVITY); // and from there to the landing
  vx = clamp(dx / (up + down), -MAX_FLING, MAX_FLING);
  vy = -Math.sqrt(2 * GRAVITY * h);
  leaping = true;
  setMode('fall');
}

function nextMode() {
  if (mode === 'sleep') return wake();
  if (mode === 'eat') return finishEat();
  if (mode === 'hunt') return pounce();
  if (mode === 'hidden') return startPeek();
  if (mode === 'peek') return comeOut();
  if (mode === 'chase') {
    playTired = now(); // bored of the yarn for now
    return setMode(Math.random() < 0.5 ? 'lie' : 'sit');
  }
  if (bubble) {
    // Keep sitting while a message is showing.
    modeUntil = now() + 2000;
    return schedule();
  }
  if (bowl?.full) return goEat();
  checkArea();

  const l = currentLove();
  const userBusy = now() < userBusyUntil;
  const weights = focus || userBusy
    ? { sit: 55, lie: 40, sleep: now() - lastWoke > 8 * 60000 ? 5 : 0 } // peaceful loafing while you are actively working
    : {
        walk: 25,
        leap: 10,
        cross: 3,
        sit: 35,
        lie: 20,
        sleep: now() - lastWoke > 6 * 60000 ? 6 : 0, // cozy catnap
        hide: animation('peek') ? 2 : 0,
        play: yarn && now() - playTired > 60000 ? 25 : 0,
        zoomies: 2,
        sulk: l < 20 ? 10 : 0,
      };
  let r = Math.random() * Object.values(weights).reduce((a, b) => a + b);
  for (const [name, w] of Object.entries(weights)) {
    if ((r -= w) > 0) continue;
    if (name === 'leap') return leap();
    if (name === 'cross') return crossScreen();
    if (name === 'hide') return hideAway();
    if (name === 'play') return startChase();
    if (name === 'zoomies') return zoomies();
    if (name === 'sulk') return startWalk(pos.x < maxX() / 2 ? 0 : maxX(), 30, () => setMode('lie'));
    if (name !== 'walk') return setMode(name);
    // Wander: head away from a nearby edge, otherwise pick a random direction.
    dir = pos.x < box.w * 2 ? 1 : maxX() - pos.x < box.w * 2 ? -1 : pick([-1, 1]);
    return startWalk(null);
  }
}

function wake() {
  lastWoke = now();
  stopZzz();
  stopSleepPurr();
  mode = 'sit';
  bodyEl.className = 'sit';
  playOnce('yawn_sit', () => {
    if (Math.random() < 0.5 && animation('stretch')) {
      dir = pick([-1, 1]);
      return playOnce('stretch', () => setMode('sit'));
    }
    setMode('sit');
  });
}

/** Back on its feet after a drop or a landing: carry on with whatever was waiting. */
function settle() {
  if (next) {
    const f = next;
    next = null;
    return f();
  }
  if (bowl?.full) return goEat();
  setMode(Math.random() < 0.75 ? 'sit' : 'lie');
}

/** Do `f` as soon as the pet is free: now, or once it has landed (jumping down from a window first). */
function doSoon(f) {
  if (mode === 'drag' || mode === 'fall') {
    next = f;
    return;
  }
  if (mode === 'hidden' || mode === 'peek') {
    next = null;
    return comeOut(f);
  }
  f();
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

  // Running after the yarn: the legs move faster too.
  // Legs keep pace with the ground: a faster walk (or run) moves its legs faster too.
  const moving = (mode === 'walk' || mode === 'chase') && !animOnce && (loopName === 'walk' || loopName === 'run');
  const base = loopName === 'run' ? anim.speed || currentSpeed() : pet.walkSpeed;
  advanceFrames(moving ? dt * (currentSpeed() / base) : dt);
  updateParticles(dt);

  if (mode === 'walk') walk(dt);
  else if (mode === 'eat') eatProgress();
  else if (mode === 'chase') chase(dt);
  else if (mode === 'fall') fall(dt);
  else if (mode === 'drag') swingHeld(dt);
  if ((settled() || mode === 'walk') && t - lastCursorPoll > 350) pollCursor();
  if (pending && !animOnce && settled()) deliver();
  if (bowl?.full && mode !== 'eat') watchBowl();

  if (t > modeUntil && !animOnce && mode !== 'drag' && mode !== 'fall') nextMode();
  else schedule();
}

function walk(dt) {
  if (animOnce) return; // stopped for a one-shot
  if (anim.hop) {
    // Pets without a walk cycle bounce along instead, in step with the loop.
    hopPhase = (hopPhase + dt) % 0.4;
    bodyEl.style.translate = `0 ${-Math.round(Math.sin((hopPhase / 0.4) * Math.PI) * 5)}px`;
  }
  if (walkToBowl && bowl?.full) {
    // You may be moving the bowl: keep heading for where it is now.
    walkTarget = bowlSpot().x;
    const d = walkTarget < pos.x ? -1 : 1;
    if (d !== dir) {
      dir = d;
      loop(gait());
    }
  }
  pos.x += dir * currentSpeed() * dt;

  if (walkTarget !== null && (dir > 0 ? pos.x >= walkTarget : pos.x <= walkTarget)) {
    pos.x = walkTarget;
    render();
    const arrive = onArrive;
    onArrive = null;
    walkTarget = null;
    return arrive ? arrive() : setMode(Math.random() < 0.7 ? 'sit' : 'lie');
  }
  // Settle smoothly at the edges instead of ping-pong bouncing.
  const lo = minWalkX();
  const hi = maxWalkX();
  if (!walkFree && ((pos.x <= lo && dir < 0) || (pos.x >= hi && dir > 0))) {
    pos.x = clamp(pos.x, lo, hi);
    dir = pos.x <= lo ? 1 : -1; // turn inward to face the room
    walkTarget = null;
    onArrive = null;
    render();
    return setMode(Math.random() < 0.65 ? 'sit' : 'lie');
  }
  render();
}

function fall(dt) {
  const prevY = pos.y;
  const rising = vy < 0;
  vy += GRAVITY * dt;
  if (snatching && rising && vy >= 0) trySnatch(); // top of a jump at the bowl
  pos.x += vx * dt;
  pos.y += vy * dt;

  // Ricochet off the sides of the frame, and off the top, losing some speed.
  if (pos.x < 0) {
    pos.x = 0;
    if (vx < 0) vx = -vx * BOUNCE;
  } else if (pos.x > maxX()) {
    pos.x = maxX();
    if (vx > 0) vx = -vx * BOUNCE;
  }
  if (pos.y < 0 && vy < 0) {
    pos.y = 0;
    vy = -vy * BOUNCE;
  }

  // Coming down onto the floor.
  const floor = ground();
  if (pos.y < floor) return render();

  if (vy > 1200) playSound('thump', Math.min(0.22, 0.12 + (vy - 1200) / 6000));
  pos.y = floor;
  render();

  if (grumpy) {
    leaping = false;
    // Shaken too hard: upset, then stomp off quickly.
    vx = 0;
    vy = 0;
    mode = 'sit';
    bodyEl.className = 'sit land';
    bodyEl.style.rotate = '';
    playSound('hiss', 0.35, 1.5);
    playOnce('upset', () => {
      dir = pos.x > view.w / 2 ? -1 : 1;
      startWalk(null, rand(2, 3.5));
      setTimeout(() => (grumpy = false), 3500);
    });
    return;
  }

  vx = 0;
  vy = 0;
  if (leaping && animation('land')) {
    // End a pounce on its feet: crouch, then stand up.
    leaping = false;
    mode = 'sit';
    bodyEl.className = 'sit';
    bodyEl.style.rotate = '';
    return playOnce('land', settle);
  }
  leaping = false;
  settle();
  bodyEl.classList.add('land');
}

// ---------- cursor awareness: auto-settling while user is active ----------

/** Track cursor activity to stay quiet and settled when the user is actively working. */
function pollCursor() {
  if (cursorBusy) return;
  cursorBusy = true;
  lastCursorPoll = now();
  cursorPosition()
    .then((c) => {
      const x = (c.x - area.x) / dpr;
      const y = (c.y - area.y) / dpr;
      const moved = Math.hypot(x - (isNaN(cur.x) ? x : cur.x), y - (isNaN(cur.y) ? y : cur.y)) > 8;
      cur.x = x;
      cur.y = y;
      if (moved) {
        cur.movedAt = now();
        userBusyUntil = now() + 6000; // user actively working; pet stays peacefully settled
      }
    })
    .catch(() => {}) // some systems (Wayland) don't share the cursor position
    .finally(() => (cursorBusy = false));
}

function swatAt() {}
function maybeHunt() {}

function pounce() {
  if (Math.random() < 0.5) playSound('trill', 0.4);
  const target = clamp((isNaN(cur.x) ? pos.x : cur.x) - box.w / 2, 0, maxX());
  const reach = isNaN(cur.y) ? 0 : view.h - cur.y - box.h * 0.3; // jump up to where the cursor is
  launch(target - pos.x, clamp(reach, box.h * 0.5, view.h * 0.4));
}

// ---------- love ----------

/** How loved the pet feels right now; it slowly fades if you don't pet or feed it. */
function currentLove() {
  const hours = (Date.now() - loveAt) / HOUR;
  if (hours > 0.05) {
    love = Math.max(0, love - hours * 1.5);
    loveAt = Date.now();
    save('love', love.toFixed(1));
    save('loveAt', loveAt);
  }
  return love;
}

function addLove(n) {
  love = clamp(currentLove() + n, 0, 100);
  save('love', love.toFixed(1));
  if (love > 30) sulkGreeted = false;
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

/** Held by the scruff: the body swings like a pendulum when you move it, then settles. */
function swingHeld(dt) {
  swingV += (-90 * swing - 7 * swingV) * dt;
  swing = clamp(swing + swingV * dt, -30, 30);
  bodyEl.style.rotate = `${swing.toFixed(1)}deg`;
}

function startDrag(e) {
  leaping = false;
  snatching = false;
  hideBubble();
  swing = 0;
  swingV = 0;
  lastDragX = e.clientX;
  setMode('drag');
  grumpy = false;
  shake = { lastX: e.clientX, lastDx: 0, flips: 0, since: now() };
  if (pet.grip && animation('held')) {
    // Picked up by the scruff: the cat hangs from your cursor.
    dragOffset = { x: pet.grip[0] * pet.scale, y: pet.grip[1] * pet.scale };
    moveDrag(e);
  } else {
    dragOffset = { x: e.clientX - pos.x, y: e.clientY - pos.y };
  }
}

function moveDrag(e) {
  pos.x = e.clientX - dragOffset.x;
  pos.y = e.clientY - dragOffset.y;
  swingV -= (e.clientX - lastDragX) * 4; // the body lags behind the hand
  lastDragX = e.clientX;
  render();
  detectShake(e.clientX);
}

async function endDrag() {
  dragOffset = null;
  // Letting go just drops the pet straight down (no throwing).
  vx = 0;
  vy = 0;

  // Dropped on another monitor? Move the window there and keep the pet where it was let go.
  const at = toScreen(pos.x, pos.y);
  const c = toScreen(pos.x + box.w / 2, pos.y + box.h / 2);
  if (await placeWindow(c.x, c.y)) {
    pos.x = (at.x - area.x) / dpr;
    pos.y = (at.y - area.y) / dpr;
    shown = { x: NaN, y: NaN };
  }
  clampX();
  pos.y = clamp(pos.y, 0, ground()); // dropped onto the taskbar, or above the screen
  render();
  home = maxX() > 0 ? pos.x / maxX() : 1;
  save('home', home.toFixed(4));
  setMode('fall');
}

function onPet() {
  if (bubble) hideBubble(); // petting counts as "got it"
  const l = currentLove();
  addLove(now() - (onPet.last ?? 0) < 3000 ? 1 : 3); // lots of quick pets count a bit less
  onPet.last = now();
  // More hearts the more loved it feels.
  const hearts = l > 70 ? 3 : l > 35 ? 2 : 1;
  for (let i = 0; i < hearts; i++) setTimeout(() => spawnFx('heart', '♥'), i * 180);
  if (mode !== 'sleep') {
    // A sweet meow or happy trill when you start petting; keep petting and it gently purrs.
    if (now() - (onPet.lastMeow ?? 0) > 2200) {
      onPet.lastMeow = now();
      if (Math.random() < 0.45) playSound('trill', 0.32);
      else playSound('meow', 0.3);
    } else playSound('purr', 0.28, 1.8);
  }
  if (mode === 'sleep') return wake();
  if (mode === 'hidden' || mode === 'peek') return comeOut();
  if (animOnce || mode === 'drag' || mode === 'fall') return;
  const back = mode === 'walk' || mode === 'chase' ? 'sit' : mode === 'lie' ? 'lie' : 'sit';
  if (mode === 'walk' || mode === 'chase' || mode === 'hunt') setMode('sit');
  // Ignored for a long time: a little "hmph" first.
  if (l < 20 && !sulkGreeted && animation('upset')) {
    sulkGreeted = true;
    return playOnce('upset', () => loop(back));
  }
  const reactions = pet.reactions[back];
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
// Right-click the pet for the same menu as the tray icon.
petEl.addEventListener('contextmenu', () => invoke('show_pet_menu'));

// ---------- hide and peek ----------

/** Walk off the nearest edge of the screen, wait, then peek back in. */
function hideAway() {
  hideSide = pos.x + box.w / 2 < view.w / 2 ? -1 : 1;
  peeks = 0;
  startWalk(hideSide < 0 ? -box.w : view.w, 60, () => setMode('hidden'), true);
}

function startPeek() {
  // The peek frames are drawn flush with the edge they come in from.
  dir = hideSide;
  pos.x = hideSide < 0 ? 0 : maxX();
  pos.y = ground();
  render();
  mode = 'peek';
  modeUntil = now() + 30000;
  bodyEl.className = 'sit';
  playOnce('peek', () => {
    peeks++;
    pos.x = hideSide < 0 ? -box.w : view.w; // ducks back out of sight
    render();
    if (peeks < 2 && Math.random() < 0.5) return setMode('hidden', rand(2, 5)); // and peeks again
    comeOut();
  });
}

/** Walk back onto the screen from where it was hiding, then do `then` (or sit down). */
function comeOut(then = null) {
  pos.x = hideSide < 0 ? -box.w : view.w;
  pos.y = ground();
  dir = -hideSide;
  render();
  const x = hideSide < 0 ? box.w * rand(0.3, 1.5) : maxX() - box.w * rand(0.3, 1.5);
  startWalk(x, 30, then);
  walkFree = true; // it starts off screen
}

// ---------- food ----------

function hunger() {
  return clamp(((Date.now() - lastFed) / HUNGRY_AFTER) * 100, 0, 100);
}

/** Put a full bowl on the floor beside the pet; it perks up, trots over and eats. */
function feed() {
  if (bowl) {
    if (!bowl.full) return; // still licking the last one clean
    return doSoon(goEat);
  }
  const mid = pos.x + box.w / 2;
  const d = mid < view.w / 2 ? 1 : -1;
  const w = box.w * 0.46;
  const x = clamp(mid + d * box.w * rand(1.3, 2.3), w, view.w - w);
  // Two halves: the inside and the food behind the cat, the front rim in front of it,
  // so its face goes over the food and into the bowl rather than behind it.
  const [back, front] = makeBowl(w);
  bowl = { els: [back, front], x, top: bowlFloor(w), w, full: true, food: 3, held: false, drag: null, vy: 0, timer: null, teased: 0 };
  placeBowl();
  worldEl.appendChild(back);
  frontEl.appendChild(front);
  // You can pick the bowl up and move it around (to tease the cat a little).
  front.classList.add('front');
  front.addEventListener('pointerdown', bowlDown);
  front.addEventListener('pointermove', bowlMove);
  front.addEventListener('pointerup', bowlUp);
  updateExtraHitboxes();
  requestAnimationFrame(() => bowl?.els.forEach((el) => el.classList.add('placed'))); // drops in with a little bounce
  if (settled() && !animOnce) spawnFx('alert', '!'); // food!
  if (mode !== 'sleep') setTimeout(() => playSound('meow', 0.32), 250);
  setTimeout(() => doSoon(goEat), settled() ? 450 : 0);
}

const bowlFloor = (w) => view.h - w * 0.5; // the bowl's top edge when it sits on the floor

function placeBowl() {
  for (const el of bowl.els) {
    el.style.left = `${bowl.x - bowl.w / 2}px`;
    el.style.top = `${bowl.top}px`;
  }
}

/** Where the cat should stand to eat: mouth just past the near rim, over the food. */
function bowlSpot() {
  // Keep to the side it's already on unless the bowl is clearly on the other one.
  const off = bowl.x - (pos.x + box.w / 2);
  if (!bowl.side || Math.abs(off) > box.w * 0.35) bowl.side = off > 0 ? 1 : -1;
  const right = bowl.side > 0;
  const mouth = (pet.mouth ?? pet.frameSize * 0.8) * pet.scale; // where the mouth is in the eating frames
  const at = bowl.x - (right ? 1 : -1) * bowl.w * 0.18;
  return { right, x: clamp(right ? at - mouth : at - (box.w - mouth), 0, maxX()) };
}

function goEat() {
  if (!bowl?.full) return setMode('sit');
  const { right, x } = bowlSpot();
  dir = right ? 1 : -1;
  startWalk(x, 30, atBowl);
  if (mode === 'walk') {
    hurry(2.6); // run, there's food
    walkToBowl = true; // and keep heading for it if you move it
  }
}

/** Got to the bowl: eat, or (if you're holding it up) sit and beg. */
function atBowl() {
  if (!bowl?.full) return setMode('sit');
  dir = bowlSpot().right ? 1 : -1;
  if (bowl.held || bowl.timer) {
    setMode('sit');
    begSince = now();
    return;
  }
  setMode('eat');
  eatStart = now();
  eatLength = modeUntil - eatStart;
}

/** Every tick while there's food out: keep going after the bowl wherever you put it. */
function watchBowl() {
  if (!bowl?.full || !settled() || animOnce || bubble) return;
  const spot = bowlSpot();
  if (Math.abs(spot.x - pos.x) > box.w * 0.3) return goEat(); // you moved it: follow
  if (!bowl.held && !bowl.timer) return atBowl(); // you put it down: eat
  // Held up within reach: jump for it now and then (and sometimes knock it out of your hand).
  const above = view.h - (bowl.top + bowl.w * 0.5); // how high the bowl is off the floor
  if (bowl.held && above < view.h * 0.4 && now() - begSince > 1000 && now() - lastBowlHop > 2200) {
    lastBowlHop = now();
    const dx = (bowl.x - (pos.x + box.w / 2)) * 0.6;
    dir = dx < 0 ? -1 : 1;
    snatching = true;
    launch(dx, clamp(above - box.h * 0.35, box.h * 0.45, view.h * 0.4));
  }
}

/** Top of the jump at the bowl you're holding: close enough, and it may get it. */
function trySnatch() {
  snatching = false;
  if (!bowl?.held) return;
  const head = pos.y + box.h * 0.3;
  const bottom = bowl.top + bowl.w * 0.5;
  const near = Math.abs(bowl.x - (pos.x + box.w / 2)) < box.w * 0.55 && head - bottom < box.h * 0.4;
  if (!near || Math.random() > 0.45) return;
  // Got it! The bowl drops out of your hand.
  invoke('hold_cursor', { hold: false });
  bowl.drag = null;
  bowl.held = false;
  for (const el of bowl.els) el.classList.remove('held');
  spawnFx('alert', '!');
  dropBowl();
}

function bowlDown(e) {
  if (!bowl?.full || e.button !== 0) return;
  e.currentTarget.setPointerCapture(e.pointerId);
  invoke('hold_cursor', { hold: true });
  clearTimeout(bowl.timer);
  bowl.timer = null;
  bowl.held = true;
  bowl.drag = { dx: e.clientX - bowl.x, dy: e.clientY - bowl.top };
  for (const el of bowl.els) el.classList.add('held');
  // Snatched away from under its nose.
  const near = Math.abs(bowl.x - (pos.x + box.w / 2)) < box.w * 1.2;
  if (mode === 'eat') setMode('sit');
  if (near) bowl.teased++;
  if (near && bowl.teased >= 3 && settled() && !animOnce && animation('upset')) {
    bowl.teased = 0;
    addLove(-2);
    playSound('hiss', 0.3, 1.2);
    playOnce('upset', () => setMode('sit')); // hey!
  }
}

function bowlMove(e) {
  if (!bowl?.drag) return;
  bowl.x = clamp(e.clientX - bowl.drag.dx, bowl.w / 2, view.w - bowl.w / 2);
  bowl.top = clamp(e.clientY - bowl.drag.dy, 0, bowlFloor(bowl.w));
  placeBowl();
  if (now() - (bowlMove.hit ?? 0) > 60) {
    bowlMove.hit = now();
    updateExtraHitboxes();
  }
}

/** Let go: the bowl drops to the floor, and the cat goes for it. */
function bowlUp() {
  if (!bowl?.drag) return;
  invoke('hold_cursor', { hold: false });
  bowl.drag = null;
  bowl.held = false;
  for (const el of bowl.els) el.classList.remove('held');
  dropBowl();
}

function dropBowl() {
  bowl.vy = 0;
  const b = bowl;
  let last = now();
  const step = () => {
    if (bowl !== b) return;
    const t = now();
    const dt = Math.min((t - last) / 1000, 0.05);
    last = t;
    b.vy += GRAVITY * dt;
    b.top += b.vy * dt;
    const floor = bowlFloor(b.w);
    if (b.top >= floor) {
      b.top = floor;
      b.timer = null;
      placeBowl();
      return updateExtraHitboxes();
    }
    placeBowl();
    b.timer = setTimeout(step, 16);
  };
  b.timer = setTimeout(step, 16);
}

/** While eating, the heap of food in the bowl gets smaller. */
function eatProgress() {
  if (!bowl?.full || bowl.held) return setMode('sit');
  if (!eatLength) return;
  const done = clamp((now() - eatStart) / eatLength, 0, 1);
  const food = done < 0.33 ? 3 : done < 0.66 ? 2 : 1;
  if (food !== bowl.food) {
    bowl.food = food;
    for (const el of bowl.els) el.dataset.food = food;
  }
}

function finishEat() {
  if (bowl) {
    bowl.full = false;
    for (const el of bowl.els) el.dataset.food = 0;
    const b = bowl;
    b.els[1].classList.remove('front'); // empty: nothing to grab any more
    setTimeout(updateExtraHitboxes, 0);
    // The empty bowl slides away a moment later.
    setTimeout(() => {
      b.els.forEach((el) => el.classList.add('gone'));
      setTimeout(() => {
        b.els.forEach((el) => el.remove());
        if (bowl === b) bowl = null;
      }, 700);
    }, 2500);
  }
  eatLength = 0;
  lastFed = Date.now();
  save('fed', lastFed);
  addLove(10);
  // Sits back, happy and full.
  setMode('sit');
  playSound('lick', 0.3);
  setTimeout(() => playSound('purr', 0.28, 2.0), 1300);
  playOnce('happy', () => setMode('sit'));
  for (let i = 0; i < 3; i++) setTimeout(() => spawnFx('heart', '♥'), 300 + i * 220);
}

function checkHunger() {
  if (focus || bubble || pending || bowl || !settled() || animOnce) return;
  if (hunger() < HUNGRY || Date.now() - lastHungrySay < 25 * 60 * 1000) return;
  lastHungrySay = Date.now();
  say(pick(HUNGRY_LINES), 'hungry', 30000);
}

/** The bowl as two layers: [inside with the food, front rim]. */
function makeBowl(w) {
  const layer = (svg) => {
    const el = document.createElement('div');
    el.className = 'bowl';
    el.dataset.food = 3;
    el.style.width = `${w}px`;
    el.style.height = `${w * 0.5}px`;
    el.innerHTML = `<svg viewBox="0 0 100 50" width="100%" height="100%" overflow="visible">${svg}</svg>`;
    return el;
  };
  const back = layer(`
    <path d="M5 16 Q50 2 95 16 Q50 26 5 16 Z" fill="#c94a5e"/>
    <ellipse cx="50" cy="16" rx="42" ry="7" fill="#6e2a35"/>
    <g class="k1">
      <circle cx="22" cy="17" r="5" fill="#b9733c"/><circle cx="33" cy="15" r="5.5" fill="#c98448"/>
      <circle cx="45" cy="16" r="5.5" fill="#a65f2e"/><circle cx="57" cy="15" r="5.5" fill="#c98448"/>
      <circle cx="69" cy="16" r="5.5" fill="#b06a35"/><circle cx="79" cy="17" r="5" fill="#d39256"/>
    </g>
    <g class="k2">
      <circle cx="30" cy="11" r="5" fill="#d39256"/><circle cx="41" cy="10" r="5.5" fill="#b9733c"/>
      <circle cx="52" cy="10" r="5.5" fill="#c98448"/><circle cx="63" cy="10" r="5.5" fill="#a65f2e"/>
      <circle cx="72" cy="12" r="5" fill="#c98448"/>
    </g>
    <g class="k3">
      <circle cx="42" cy="5" r="5" fill="#c98448"/><circle cx="52" cy="4" r="5.5" fill="#d39256"/>
      <circle cx="61" cy="6" r="5" fill="#b06a35"/>
    </g>`);
  const front = layer(`
    <path d="M5 16 Q50 30 95 16 L88 44 Q50 52 12 44 Z" fill="#ef6f82"/>
    <path d="M5 16 Q50 30 95 16 L93 22 Q50 35 7 22 Z" fill="#f99aa8"/>
    <path d="M13 40 Q50 48 87 40" fill="none" stroke="#c94a5e" stroke-width="3" stroke-linecap="round"/>
    <path d="M42 33 q4 -5 8 0 q4 -5 8 0 q-8 9 -8 9 q0 0 -8 -9 z" fill="#fff" opacity="0.9"/>`);
  return [back, front];
}

// ---------- yarn ----------

const YARN_R = 13;

/** Drop a ball of yarn near the pet (or put it away). */
function toggleYarn() {
  if (yarn) return removeYarn();
  const el = document.createElement('div');
  el.className = 'yarn';
  el.style.width = el.style.height = `${YARN_R * 2}px`;
  el.innerHTML = `
    <svg viewBox="0 0 26 26" width="100%" height="100%">
      <circle cx="13" cy="13" r="12" fill="#e9577a" stroke="#a82c4c" stroke-width="1.2"/>
      <path d="M3 9 Q13 4 23 10 M2 14 Q13 8 24 15 M4 19 Q13 13 22 20 M8 3 Q5 13 9 24 M15 2 Q11 13 16 25"
        fill="none" stroke="#f9a3b8" stroke-width="1.3" stroke-linecap="round"/>
    </svg>`;
  worldEl.appendChild(el);
  const x = clamp(pos.x + box.w / 2 + pick([-1, 1]) * box.w * rand(1, 2), YARN_R, view.w - YARN_R);
  yarn = { el, x, y: YARN_R, vx: rand(-60, 60), vy: 0, rot: 0, timer: null, last: now(), drag: null, touched: Date.now() };
  el.addEventListener('pointerdown', yarnDown);
  el.addEventListener('pointermove', yarnMove);
  el.addEventListener('pointerup', yarnUp);
  el.addEventListener('dblclick', () => removeYarn()); // double-click picks it up and puts it away
  wakeYarn();
  invoke('set_yarn_out', { out: true }).catch(() => {});
  if (!focus && !bubble) doSoon(startChase);
}

function removeYarn() {
  if (!yarn) return;
  clearTimeout(yarn.timer);
  yarn.el.remove();
  yarn = null;
  invoke('hold_cursor', { hold: false });
  invoke('set_yarn_out', { out: false }).catch(() => {});
  updateExtraHitboxes();
  if (mode === 'chase') setMode('sit');
}

function wakeYarn() {
  if (yarn && !yarn.timer) {
    yarn.last = now();
    yarn.timer = setTimeout(yarnStep, 16);
  }
}

/** Ball physics: falls, bounces, rolls to a stop. Stops running once it's still. */
function yarnStep() {
  if (!yarn) return;
  yarn.timer = null;
  const t = now();
  const dt = Math.min((t - yarn.last) / 1000, 0.05);
  yarn.last = t;
  const floor = view.h - YARN_R;
  if (!yarn.drag) {
    yarn.vy += GRAVITY * 0.6 * dt;
    yarn.x += yarn.vx * dt;
    yarn.y += yarn.vy * dt;
    if (yarn.y > floor) {
      yarn.y = floor;
      yarn.vy = yarn.vy > 80 ? -yarn.vy * 0.45 : 0;
      yarn.vx *= 0.92;
    }
    if (yarn.y >= floor - 0.5) yarn.vx *= Math.max(0, 1 - 1.8 * dt); // rolling slows it down
    if (yarn.x < YARN_R) {
      yarn.x = YARN_R;
      yarn.vx = Math.abs(yarn.vx) * 0.6;
    } else if (yarn.x > view.w - YARN_R) {
      yarn.x = view.w - YARN_R;
      yarn.vx = -Math.abs(yarn.vx) * 0.6;
    }
    if (yarn.y < YARN_R) {
      yarn.y = YARN_R;
      yarn.vy = Math.abs(yarn.vy) * 0.5;
    }
    yarn.rot += ((yarn.vx * dt) / YARN_R) * 57.3;
  }
  drawYarn();
  const still = !yarn.drag && yarn.vy === 0 && Math.abs(yarn.vx) < 4 && yarn.y >= floor - 0.5;
  if (still) {
    yarn.vx = 0;
    return updateExtraHitboxes();
  }
  yarn.timer = setTimeout(yarnStep, 16);
}

function drawYarn() {
  yarn.el.style.translate = `${(yarn.x - YARN_R).toFixed(1)}px ${(yarn.y - YARN_R).toFixed(1)}px`;
  yarn.el.style.rotate = `${yarn.rot.toFixed(0)}deg`;
  if (now() - (drawYarn.hit ?? 0) > 60) {
    drawYarn.hit = now();
    updateExtraHitboxes();
  }
}

/** Let the mouse reach the yarn (and anything else besides the pet that can be grabbed). */
function updateExtraHitboxes() {
  const rects = [];
  if (yarn) {
    const p = toScreen(yarn.x - YARN_R - 4, yarn.y - YARN_R - 4);
    rects.push([p.x, p.y, (YARN_R * 2 + 8) * dpr, (YARN_R * 2 + 8) * dpr]);
  }
  if (bowl?.full) {
    const p = toScreen(bowl.x - bowl.w / 2, bowl.top + bowl.w * 0.1);
    rects.push([p.x, p.y, bowl.w * dpr, bowl.w * 0.4 * dpr]);
  }
  invoke('set_extra_hitboxes', { rects }).catch(() => {});
}

function yarnDown(e) {
  if (!yarn || e.button !== 0) return;
  yarn.el.setPointerCapture(e.pointerId);
  invoke('hold_cursor', { hold: true });
  yarn.drag = { dx: e.clientX - yarn.x, dy: e.clientY - yarn.y, trail: [{ x: e.clientX, y: e.clientY, t: now() }] };
  yarn.vx = yarn.vy = 0;
  wakeYarn();
}

function yarnMove(e) {
  if (!yarn?.drag) return;
  yarn.x = clamp(e.clientX - yarn.drag.dx, YARN_R, view.w - YARN_R);
  yarn.y = clamp(e.clientY - yarn.drag.dy, YARN_R, view.h - YARN_R);
  yarn.drag.trail.push({ x: e.clientX, y: e.clientY, t: now() });
  if (yarn.drag.trail.length > 8) yarn.drag.trail.shift();
}

/** Let go of the yarn: it flies off at the speed you flicked it. */
function yarnUp() {
  if (!yarn?.drag) return;
  invoke('hold_cursor', { hold: false });
  const all = yarn.drag.trail;
  const clicked = Math.hypot(all[all.length - 1].x - all[0].x, all[all.length - 1].y - all[0].y) < 5;
  const trail = all.filter((p) => now() - p.t < 100);
  if (trail.length > 1 && !clicked) {
    const a = trail[0];
    const b = trail[trail.length - 1];
    const dt = Math.max((b.t - a.t) / 1000, 0.016);
    yarn.vx = clamp((b.x - a.x) / dt, -1800, 1800);
    yarn.vy = clamp((b.y - a.y) / dt, -1800, 1800);
  }
  yarn.drag = null;
  yarn.touched = Date.now();
  wakeYarn();
  // A flick sends the cat after it at once. A plain click waits a moment, in
  // case it's the first half of a double-click (which puts the yarn away).
  const chaseIt = () => {
    if (yarn && !focus && !bubble && (settled() || mode === 'walk')) doSoon(startChase);
  };
  if (clicked) setTimeout(chaseIt, 400);
  else chaseIt();
}

function startChase() {
  if (!yarn) return setMode('sit');
  dir = yarn.x < pos.x + box.w / 2 ? -1 : 1;
  setMode('chase');
}

/** Run after the yarn and bat it when it's within reach. */
function chase(dt) {
  if (!yarn) return setMode('sit');
  if (animOnce) return; // mid-swat
  const mid = pos.x + box.w / 2;
  const off = yarn.x - mid;
  const low = yarn.y > view.h - box.h * 0.55;
  // Anywhere from the back paws to the front paws is within reach. Against the
  // edge of the screen the cat can't get any closer, so reach a bit further there.
  const atEdge = (off < 0 && pos.x <= 0.5) || (off > 0 && pos.x >= maxX() - 0.5);
  const reach = box.w * (atEdge ? 0.75 : 0.32);
  if (Math.abs(off) < reach) {
    if (!low) {
      // Up in the air above it: stand still and wait for it to come down.
      if (loopName !== 'sit') loop('sit');
      return;
    }
    // Within reach (even right under its belly): swat it out. Near a wall,
    // swat it back toward the room so it can't get trapped against the edge.
    let face = off < 0 ? -1 : 1;
    if (yarn.x < box.w * 1.2) face = 1;
    else if (yarn.x > view.w - box.w * 1.2) face = -1;
    dir = face;
    return bat();
  }
  // Out of reach: run toward it. It's clearly on one side, so no flip-flopping.
  const want = off < 0 ? -1 : 1;
  if (want !== dir || loopName !== gait()) {
    dir = want;
    loop(gait());
  }
  pos.x = clamp(pos.x + dir * currentSpeed() * dt, 0, maxX());
  render();
}

function bat() {
  playOnce('bat', () => {
    if (mode === 'chase') loop(gait());
  });
  setTimeout(() => {
    if (!yarn || mode !== 'chase') return;
    const mid = pos.x + box.w / 2;
    if (Math.abs(yarn.x - mid) > box.w * 0.8 || yarn.y < view.h - box.h * 0.7) return;
    yarn.vx = dir * rand(220, 480);
    yarn.vy = -rand(120, 420);
    playSound('bat', 0.35);
    yarn.touched = Date.now();
    addLove(0.5);
    wakeYarn();
  }, 220);
}

// ---------- speech bubbles: breaks, hunger, focus timer, reminders ----------

/**
 * Show a message once the pet is sitting. A busy pet sits down first; a
 * reminder walks to the middle of the screen first. A more important message
 * replaces a less important one.
 */
function say(text, kind, ms = 60000, opts = {}) {
  const rank = BUBBLE_RANK[kind];
  if (bubble && BUBBLE_RANK[bubble.kind] > rank) return;
  if (pending && BUBBLE_RANK[pending.kind] > rank) return;
  pending = { text, kind, ms, center: !!opts.center, moved: false };
  deliver();
}

function deliver() {
  if (!pending || paused || napUntilBack) return;
  if (pending.center && !pending.moved) {
    // Come to the middle of the screen with the message.
    const target = view.w / 2 - box.w / 2;
    if (Math.abs(pos.x - target) > box.w && mode !== 'drag' && mode !== 'fall') {
      pending.moved = true;
      return doSoon(() => {
        if (Math.abs(pos.x - target) > view.w * 0.3) return jumpTo(target, box.h * 0.8);
        startWalk(target, 30, () => setMode('sit'));
      });
    }
  }
  if (!settled() || animOnce) {
    // Busy: sit down first (walking, playing, sleeping), or wait (held, falling, mid-animation).
    if (mode === 'walk' || mode === 'chase' || mode === 'hunt') setMode('sit');
    else if (mode === 'sleep') wake();
    else if (mode === 'hidden' || mode === 'peek') doSoon(() => setMode('sit'));
    return;
  }
  const p = pending;
  pending = null;
  showBubble(p.text, p.kind, p.ms);
}

function showBubble(text, kind, ms) {
  hideBubble();
  const el = document.createElement('div');
  el.className = `bubble ${kind}`;
  el.textContent = text;
  // Open toward the middle of the screen so it never runs off the edge.
  el.classList.add(pos.x > view.w / 2 ? 'to-left' : 'to-right');
  petRoot.appendChild(el);
  bubble = { el, kind, timer: setTimeout(hideBubble, ms) };
  if (kind === 'hungry') playSound('ask', 0.32);
  else playSound('meow', kind === 'reminder' ? 0.35 : 0.28);
  modeUntil = Math.max(modeUntil, now() + 2000);
}

function hideBubble() {
  if (!bubble) return;
  clearTimeout(bubble.timer);
  bubble.el.remove();
  bubble = null;
}

// Focus timer: the pet sits quietly next to a little clock, then tells you to take a break.
function startFocus(minutes) {
  focus = { end: Date.now() + minutes * 60000, minutes };
  localStorage.setItem('focus', JSON.stringify(focus));
  if (bubble?.kind === 'break' || bubble?.kind === 'hungry') hideBubble();
  if (mode === 'walk' || mode === 'chase' || mode === 'hunt') setMode('sit');
  showClock();
  sendPanelState();
}

function stopFocus(finished) {
  focus = null;
  localStorage.removeItem('focus');
  clearInterval(clockTimer);
  clockEl?.remove();
  clockEl = null;
  if (finished) {
    for (let i = 0; i < 3; i++) setTimeout(() => spawnFx('heart', '♥'), i * 200);
    if (settled() && !animOnce && animation('stretch')) playOnce('stretch', () => setMode('sit'));
    say('Focus done! Take a 5-minute break.', 'focus', 2 * 60000);
  }
  sendPanelState();
}

function showClock() {
  clockEl?.remove();
  clockEl = document.createElement('div');
  clockEl.className = 'clock';
  petRoot.appendChild(clockEl);
  const update = () => {
    if (!focus) return;
    const left = focus.end - Date.now();
    if (left <= 0) return stopFocus(true);
    const m = Math.floor(left / 60000);
    const s = Math.floor((left % 60000) / 1000);
    clockEl.textContent = `${m}:${String(s).padStart(2, '0')}`;
  };
  update();
  clearInterval(clockTimer);
  clockTimer = setInterval(update, 1000);
}

// Reminders: at the set time the pet walks to the middle of the screen with your message.
function saveReminders() {
  localStorage.setItem('reminders', JSON.stringify(reminders));
  sendPanelState();
}

function checkReminders() {
  if (napUntilBack || bubble?.kind === 'reminder' || pending?.kind === 'reminder') return;
  const due = reminders.filter((r) => r.at <= Date.now()).sort((a, b) => a.at - b.at)[0];
  if (!due) return;
  reminders = reminders.filter((r) => r !== due);
  saveReminders();
  say(`⏰ ${due.text}`, 'reminder', 10 * 60000, { center: true });
}

function sendPanelState() {
  emit('panel-state', { focus, reminders }).catch(() => {});
}

// ---------- sound ----------

// Short sounds, each with a couple of copies so one can overlap another.
const SOUNDS = {
  meow: ['sounds/meow.mp3', 'sounds/meow_short.mp3', 'sounds/meow_gentle.mp3'], // sweet short meows
  ask: ['sounds/meow_short.mp3', 'sounds/meow.mp3'], // asking for food
  purr: ['sounds/purr.mp3'],
  hiss: ['sounds/hiss.mp3'],
  trill: ['sounds/trill1.mp3', 'sounds/trill2.mp3', 'sounds/trill3.mp3'], // happy "mrrp"
  lick: ['sounds/lick.mp3'],
  thump: ['sounds/soft_drop.ogg'], // gentle padded paw landing
  bat: ['sounds/bat.mp3'],
};
const soundPool = {};
let soundOn = localStorage.getItem('sound') !== 'false';
let sleepPurr = null; // the quiet purr while it naps

for (const [name, files] of Object.entries(SOUNDS)) {
  soundPool[name] = files.map((file) => [0, 1].map(() => Object.assign(new Audio(file), { preload: 'auto' })));
}

/** Play a sound; `seconds` cuts a long one (the purr) short with a fade. */
function playSound(name, volume = 0.32, seconds = 0) {
  if (!soundOn || paused) return;
  const voices = pick(soundPool[name] ?? [[]]);
  const a = voices.find((v) => v.paused) ?? voices[0];
  if (!a) return;
  clearInterval(a.fade);
  try {
    a.currentTime = 0;
    a.volume = volume;
    a.playbackRate = 0.98 + Math.random() * 0.04; // subtle pitch variation
    a.play()?.catch(() => {}); // autoplay can be blocked until the first click
  } catch {}
  if (seconds) fadeOut(a, seconds);
}

function fadeOut(a, after, over = 0.8) {
  clearTimeout(a.fadeStart);
  a.fadeStart = setTimeout(() => {
    const start = a.volume;
    const t0 = now();
    clearInterval(a.fade);
    a.fade = setInterval(() => {
      const k = (now() - t0) / (over * 1000);
      if (k >= 1) {
        clearInterval(a.fade);
        a.pause();
        return;
      }
      a.volume = start * (1 - k);
    }, 50);
  }, after * 1000);
}

function startSleepPurr() {
  if (!soundOn || paused) return;
  // A brief gentle settling purr that softly fades out after 2.5s, letting the pet sleep in quiet peace
  playSound('purr', 0.2, 2.5);
}

function stopSleepPurr() {
  if (sleepPurr && !sleepPurr.paused) fadeOut(sleepPurr, 0, 0.4);
}

// ---------- effects ----------

function spawnFx(kind, text) {
  const el = document.createElement('span');
  el.className = `fx ${kind}`;
  el.textContent = text;
  // Just above the head in the current pose.
  const top = (anim?.top ?? pet.frameSize * 0.2) * pet.scale;
  const head = (anim?.headX ?? pet.frameSize / 2) * pet.scale;
  el.style.left = `${head + rand(-16, 8)}px`;
  el.style.top = `${Math.max(0, top - 14)}px`;
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

// ---------- you stepped away ----------

function onPresence(state) {
  if (state === 'away') {
    if (bubble?.kind !== 'reminder') hideBubble();
    if (pending?.kind !== 'reminder') pending = null;
    if (mode === 'sleep') {
      napUntilBack = true;
      modeUntil = now() + 24 * HOUR; // already napping: keep napping until you're back
    } else if (settled() || mode === 'walk' || mode === 'chase') {
      napUntilBack = true;
      setMode('sleep', 24 * 3600); // stays asleep until you're back
    }
  } else if (state === 'back' && napUntilBack) {
    napUntilBack = false;
    if (mode === 'sleep') {
      wake();
      setTimeout(() => spawnFx('heart', '♥'), 700); // happy you're back
      setTimeout(() => playSound('trill', 0.45), 500);
    }
  }
}

// ---------- tray + system events ----------

function dropFromTop() {
  pos.x = view.w * rand(0.3, 0.8);
  pos.y = -box.h * 0.3;
  clampX();
  vy = 0;
  vx = 0;
  leaping = false;
  render();
  setMode('fall');
}

listen('tray', ({ payload }) => {
  if (payload === 'sleep') doSoon(() => setMode('sleep'));
  if (payload === 'reset') dropFromTop();
  if (payload === 'feed') feed();
  if (payload === 'yarn') toggleYarn();
});

listen('pet', ({ payload }) => {
  localStorage.setItem('pet', payload);
  location.reload();
});
listen('color', ({ payload }) => setColor(payload));
listen('outfit', ({ payload }) => setOutfit(payload));

listen('sound', ({ payload }) => {
  soundOn = !!payload;
  localStorage.setItem('sound', String(soundOn));
  if (!soundOn) {
    stopSleepPurr();
    for (const files of Object.values(soundPool)) for (const voices of files) for (const a of voices) a.pause();
  } else {
    playSound('trill', 0.4); // a little hello
    if (mode === 'sleep' && !animOnce) startSleepPurr();
  }
});

listen('presence', ({ payload }) => onPresence(payload));
listen('break', () => {
  if (!focus) say(pick(BREAK_LINES), 'break'); // no break nagging in the middle of a focus session
});
listen('breaks', ({ payload }) => localStorage.setItem('breaks', String(payload)));

// The "Focus & reminders" window.
listen('panel-ready', () => sendPanelState());
listen('focus-start', ({ payload }) => startFocus(clamp(Number(payload?.minutes) || 25, 1, 240)));
listen('focus-stop', () => stopFocus(false));
listen('reminder-add', ({ payload }) => {
  const at = Number(payload?.at);
  const text = String(payload?.text ?? '').trim().slice(0, 120);
  if (!at || !text) return;
  reminders.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, at, text });
  saveReminders();
});
listen('reminder-remove', ({ payload }) => {
  reminders = reminders.filter((r) => r.id !== payload?.id);
  saveReminders();
});

listen('fullscreen', ({ payload }) => {
  paused = payload;
  if (paused) {
    clearTimeout(timer);
    stopZzz();
    stopSleepPurr();
  } else {
    lastTick = now();
    if (mode === 'sleep' && !animOnce) {
      startZzz();
      startSleepPurr();
    }
    schedule();
  }
});

// ---------- start ----------

(async () => {
  const pets = await (await fetch('pets/index.json')).json();
  await loadPet(pets.some((p) => p.id === petId) ? petId : DEFAULT_PET);
  colorDef = pet.colors.find((c) => c.id === saved('color', '')) ?? pet.colors[0];
  outfitDef = pet.outfits.find((o) => o.id === saved('outfit', '')) ?? null;

  // Before the menu is built, so its "Break reminders" check is right.
  await invoke('set_break_reminders', { on: localStorage.getItem('breaks') !== 'false' });
  invoke('set_menu', {
    pets,
    pet: petId,
    colors: pet.colors.map(({ id, name }) => ({ id, name })),
    color: colorDef.id,
    outfits: pet.outfits.map(({ id, name }) => ({ id, name })),
    outfit: outfitDef?.id ?? '',
    roam,
    sound: soundOn,
  });

  const m = await currentMonitor();
  await placeWindow(m.position.x + m.size.width / 2, m.position.y + m.size.height / 2);
  dropFromTop(); // entrance: fall in from the top of the screen
  await win.show();

  if (focus && focus.end > Date.now()) showClock();
  else if (focus) stopFocus(false);
  setInterval(checkReminders, 15000);
  setInterval(checkHunger, 60000);
  sendPanelState();
})();
