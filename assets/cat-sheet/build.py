"""Build the tabby pet from its sprite sheets.

Run from anywhere:  python assets/cat-sheet/build.py   (needs Pillow and numpy)

sheet.png  (7 rows of 8): sit, walk right, walk left, jump, yawn, sleep, held
sheet2.png (8 rows of 8): eat, lie down, happy, upset, hunt, bat, peek, stretch
sheet3.png (2 rows of 8):  walk (facing left), run (facing left); replaces sheet.png's walk

A sheet can be a transparent PNG or drawn on a flat green screen; green is
removed here. Every kitten is cut out on its own, both sheets are scaled to
the same cat size, each animation is lined up so nothing jitters between
frames, and the result is written as one horizontal strip per animation into
src/pets/tabby/. The pet's hitbox and grip point go into src/pets/tabby/pet.json.
"""
import json
import re
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
OUT = HERE.parent.parent / "src" / "pets" / "tabby"

CELL = 360        # output frame size in px (shown at half size)
GROUND = 350      # y of the paws inside a frame
SIT_HEIGHT = 220  # sitting cat's height in a frame; sets the size of everything
HELD_TOP = 6      # held cat: top of the ears this far below the top of the frame

# sheet file -> (row names, how to match its cat's size to the others):
#   a row name: that row's kittens sit upright, scaled to SIT_HEIGHT
#   (other row, my row): scale my row to the same height as another sheet's row
SHEETS = {
    "sheet.png": (["sit", "walk_right", "walk_left", "jump", "yawn", "sleep", "held"], "sit"),
    "sheet2.png": (["eat", "lie", "happy", "upset", "hunt", "bat", "peek", "stretch"], "happy"),
    "sheet3.png": (["walk2", "run"], ("walk_left", "walk2")),
}

# Output animations: name -> (row, frame order, how to line frames up, mirror)
#   anchor "body": middle of the lower body   "head": middle of the head
#   anchor "eye":  the eye (walking side view) "mass": middle of the whole cat
#   anchor "edge": cut-off side flush with the cell edge (peeking in from a wall)
ANIMS = {
    "sit":          ("sit", [0, 0, 0, 0, 1, 1, 0, 0, 0, 2, 3, 3, 2, 0, 0, 0, 0, 4, 4, 5, 5, 5, 5, 6, 6, 7, 7, 0], "body", False),
    # Walking uses sheet3's walk (its legs really alternate) when it's there,
    # otherwise sheet.png's walk-left row. Both face left; walking right is mirrored.
    "walk_right":   ("walk2|walk_left", range(8), "eye", True),
    "walk_left":    ("walk2|walk_left", range(8), "eye", False),
    "run_right":    ("run", range(8), "eye", True),
    "run_left":     ("run", range(8), "eye", False),
    "crouch_right": ("jump", [1, 2], "mass", False),
    "crouch_left":  ("jump", [1, 2], "mass", True),
    "jump_right":   ("jump", [3, 4, 5], "mass", False),
    "jump_left":    ("jump", [3, 4, 5], "mass", True),
    "land_right":   ("jump", [6, 7], "mass", False),
    "land_left":    ("jump", [6, 7], "mass", True),
    "yawn":         ("yawn", range(8), "body", False),
    "sleep":        ("sleep", range(8), "mass", False),
    "held":         ("held", range(8), "head", False),
    "dangle":       ("held", [0], "head", False),  # falling after you let go
    "eat_right":    ("eat", [2, 3, 4, 5, 4, 3, 6, 2], "mass", False),
    "eat_left":     ("eat", [2, 3, 4, 5, 4, 3, 6, 2], "mass", True),
    "lie_down":     ("lie", [0, 1, 2, 3], "body", False),
    "lie":          ("lie", [4, 4, 5, 5, 6, 6, 7, 7], "body", False),
    "happy":        ("happy", range(8), "body", False),
    "upset":        ("upset", range(8), "body", False),
    "hunt_right":   ("hunt", range(8), "mass", False),
    "hunt_left":    ("hunt", range(8), "mass", True),
    "bat_right":    ("bat", range(8), "mass", False),
    "bat_left":     ("bat", range(8), "mass", True),
    "peek_left":    ("peek", range(8), "edge", False),   # peeking in from the left edge
    "peek_right":   ("peek", range(8), "edge", True),    # ...and from the right edge
    "stretch_right": ("stretch", range(8), "mass", False),
    "stretch_left": ("stretch", range(8), "mass", True),
}
HANGING = {"held", "dangle"}  # lined up from the top (the scruff), not the paws


def runs(mask, min_len):
    """(start, end) of each run of True values at least min_len long."""
    out, start = [], None
    for i, on in enumerate(list(mask) + [False]):
        if on and start is None:
            start = i
        if not on and start is not None:
            if i - start >= min_len:
                out.append((start, i))
            start = None
    return out


def load(path):
    """The sheet as RGBA with a clean background: green screen removed, faint leftovers dropped."""
    img = Image.open(path).convert("RGBA")
    a = np.array(img).astype(float)
    if a[..., 3].min() > 250:  # opaque: drawn on a green screen
        rgb = a[..., :3]
        border = np.concatenate([rgb[:20].reshape(-1, 3), rgb[-20:].reshape(-1, 3)])
        bg = np.median(border, 0)
        r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
        # Cat colours have green about halfway between red and blue; the screen is far greener.
        k = (g - (r + b) / 2) / (bg[1] - (bg[0] + bg[2]) / 2)
        alpha = np.clip((np.clip(1 - k, 0, 1) - 0.08) / 0.84, 0, 1)
        colour = np.clip(bg + (rgb - bg) / np.maximum(alpha, 0.05)[..., None], 0, 255)
        colour[..., 1] = np.minimum(colour[..., 1], np.maximum(colour[..., 0], colour[..., 2]))
        a = np.dstack([colour, alpha * 255])
    a[..., 3] = np.where(a[..., 3] < 25, 0, a[..., 3])
    return Image.fromarray(a.astype(np.uint8), "RGBA")


def cut_sheet(sheet, names):
    """Split a sheet into rows of separate kittens (they never touch)."""
    a = np.array(sheet)[..., 3]
    solid = a > 60
    bands = runs(solid.sum(1) > 3, 40)
    assert len(bands) == len(names), f"expected {len(names)} rows of kittens, found {len(bands)}"
    rows = []
    for y0, y1 in bands:
        cols = runs(solid[y0:y1].sum(0) > 0, 20)
        assert len(cols) == 8, f"expected 8 kittens in the row at y={y0}, found {len(cols)}"
        frames = []
        for x0, x1 in cols:
            f = np.array(sheet.crop((x0, y0, x1, y1)))
            ys = np.where((f[..., 3] > 60).any(1))[0]
            frames.append(Image.fromarray(f[ys.min():ys.max() + 1]))
        rows.append(frames)
    return dict(zip(names, rows))


def anchor_x(img, how):
    """x of the point that should stay still from frame to frame."""
    f = np.array(img).astype(int)
    a = f[..., 3] > 60
    h = a.shape[0]
    if how == "eye":
        r, b = f[..., 0], f[..., 2]
        eye = a & (b > r + 30) & (b > 70)
        if eye.sum() > 10:
            return np.where(eye)[1].mean()
        how = "head"
    if how == "head":
        a = a[: int(h * 0.45)]
    elif how == "body":
        a = a[int(h * 0.6):]
    return np.where(a)[1].mean()


def main():
    rows = {}
    for file, (names, upright) in SHEETS.items():
        path = HERE / file
        if not path.exists():
            print(f"({file} not found, skipping its animations)")
            continue
        cut = cut_sheet(load(path), names)
        if isinstance(upright, tuple):
            other, mine = upright
            k = np.median([f.height for f in rows[other]]) / np.median([f.height for f in cut[mine]])
        else:
            k = SIT_HEIGHT / np.median([f.height for f in cut[upright]])
        for name, frames in cut.items():
            rows[name] = [f.resize((round(f.width * k), round(f.height * k)), Image.LANCZOS) for f in frames]

    OUT.mkdir(parents=True, exist_ok=True)
    boxes = {}
    for name, (row, order, how, mirror) in ANIMS.items():
        row = next((r for r in row.split("|") if r in rows), None)  # first one that exists
        if row is None:
            continue
        order = list(order)
        frames = {}
        for i in set(order):
            f = rows[row][i]
            frames[i] = f.transpose(Image.FLIP_LEFT_RIGHT) if mirror else f
        strip = Image.new("RGBA", (CELL * len(order), CELL), (0, 0, 0, 0))
        if how == "edge":
            xs = {i: (CELL - f.width if mirror else 0) for i, f in frames.items()}
        else:
            anchors = {i: anchor_x(f, how) for i, f in frames.items()}
            # Centre the animation's average outline in the cell, keeping each frame's anchor fixed.
            ax = CELL / 2 - np.mean([f.width / 2 - anchors[i] for i, f in frames.items()])
            xs = {i: round(ax - anchors[i]) for i in frames}
        for n, i in enumerate(order):
            f = frames[i]
            x = xs[i]
            y = HELD_TOP if name in HANGING else GROUND - f.height
            assert 0 <= x and x + f.width <= CELL and 0 <= y and y + f.height <= CELL, f"{name} frame {i} does not fit"
            strip.alpha_composite(f, (n * CELL + x, y))
            boxes.setdefault(name, []).append((x, y, x + f.width, y + f.height))
        strip.save(OUT / f"{name}.png", optimize=True)
        print(f"{name:13} {len(order):2} frames")

    # Hitbox: where the cat is when standing or walking. Grip: the scruff, for picking it up.
    stand = [b for n in ("sit", "walk_right", "walk_left") for b in boxes[n]]
    hitbox = [min(b[0] for b in stand), min(b[1] for b in stand), max(b[2] for b in stand), GROUND]
    held = boxes["held"]
    top = min(b[1] for b in held)
    bottom = max(b[3] for b in held)
    grip = [CELL // 2, round(top + (bottom - top) * 0.1)]
    pj = OUT / "pet.json"
    text = pj.read_text(encoding="utf-8")
    values = {"frameSize": CELL, "ground": GROUND, "hitbox": hitbox, "grip": grip}
    if "eat_right" in boxes:
        # Where the mouth is while eating (facing right), so the pet stands right at its bowl.
        values["mouth"] = round(np.mean([b[2] for b in boxes["eat_right"]])) - 14
    for key, value in values.items():
        line = f'"{key}": {json.dumps(value)},'
        text, n = re.subn(rf'"{key}": [^\n]*,', line, text, count=1)
        if not n:  # not there yet: add it after "scale"
            text = re.sub(r'("scale": [^\n]*,)', r"\1\n  " + line.replace("\\", "\\\\"), text, count=1)
    json.loads(text)
    pj.write_text(text, encoding="utf-8")
    print("hitbox", hitbox, "grip", grip)


if __name__ == "__main__":
    main()
