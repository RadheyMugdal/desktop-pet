"""Build the tabby pet's sprite sheets from the source sheets in src/.

Run from anywhere:  python assets/new-cat/build.py   (needs Pillow)

Every source sheet is sliced into frames, stray bits from neighbouring cells
are dropped, the cat is scaled to one common size, and each animation is lined
up on the same ground line so switching animations never makes the cat jump.
Output: one horizontal strip per animation in src/pets/tabby/.
"""
from pathlib import Path
from PIL import Image

HERE = Path(__file__).resolve().parent
SRC = HERE / "src"
OUT = HERE.parent.parent / "src" / "pets" / "tabby"

CELL = 256      # output frame size in px (shown at half size, so it stays sharp on hi-dpi)
GROUND = 248    # y of the cat's feet inside a frame
GRID_SCALE = CELL / 443.5   # the 4x2 sheets are 1774x887, so 443.5 px per cell
WALK_HEIGHT = 205  # walking cat's height in the cell (tail tip to paws); fits its long stride in the cell

WALK_ORDER = range(8)

# name: (source, frame order). Frames are numbered left to right, top row first.
ANIMS = {
    "idle":        ("idle.png", [0, 0, 1, 1, 0, 0, 2, 0, 0, 3, 3, 4, 4, 3, 3, 5, 4, 4, 7, 7, 0, 0]),
    "walk_right":  ("walk_right.png", WALK_ORDER),
    "walk_left":   ("walk_left.png", WALK_ORDER),
    "jump_right":  ("jump_right.png", [2, 3, 4]),
    "jump_left":   ("jump_left.png", [2, 3, 4]),
    "crouch_right": ("jump_right.png", [0, 1]),   # wind-up before a jump
    "crouch_left": ("jump_left.png", [0, 1]),
    "land_right":  ("jump_right.png", [5, 6, 7]),
    "land_left":   ("jump_left.png", [5, 6, 7]),
    "dangle_right": ("jump_right.png", [3]),
    "dangle_left": ("jump_left.png", [3]),
    "eat":         ("eat.png", range(8)),
    "happy":       ("happy.png", range(8)),
    "yawn":        ("yawn.png", range(8)),
    "cry":         ("cry.png", range(8)),
    "sleep":       ("sleep.png", range(8)),
}
# Animations drawn by mirroring another sheet.
FLIPPED = set()
# Animations where the cat leaves the ground: keep each frame's height as drawn.
AIRBORNE = {"jump_right", "jump_left", "land_right", "land_left", "dangle_right", "dangle_left"}


def components(alpha):
    """Connected blobs of visible pixels in an L image: list of (size, touches_edge, pixel set)."""
    w, h = alpha.size
    px = alpha.load()
    seen = bytearray(w * h)
    blobs = []
    for sy in range(h):
        for sx in range(w):
            if seen[sy * w + sx] or px[sx, sy] < 20:
                continue
            stack = [(sx, sy)]
            seen[sy * w + sx] = 1
            pts = []
            edge = False
            while stack:
                x, y = stack.pop()
                pts.append((x, y))
                if x in (0, w - 1) or y in (0, h - 1):
                    edge = True
                for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                    if 0 <= nx < w and 0 <= ny < h and not seen[ny * w + nx] and px[nx, ny] >= 20:
                        seen[ny * w + nx] = 1
                        stack.append((nx, ny))
            blobs.append((len(pts), edge, pts))
    return blobs


def clean(frame):
    """Drop small blobs that poke in from a neighbouring cell (they touch the edge)."""
    small = frame.resize((frame.width // 4, frame.height // 4), Image.NEAREST)
    blobs = components(small.getchannel("A"))
    if not blobs:
        return frame
    biggest = max(b[0] for b in blobs)
    mask = Image.new("L", small.size, 255)
    mp = mask.load()
    for size, edge, pts in blobs:
        if edge and size < biggest * 0.25:
            for x, y in pts:
                mp[x, y] = 0
    mask = mask.resize(frame.size, Image.NEAREST)
    r, g, b, a = frame.split()
    a = Image.composite(a, Image.new("L", frame.size, 0), mask)
    return Image.merge("RGBA", (r, g, b, a))


def grid_frames(sheet, cols=4, rows=2):
    w, h = sheet.size
    cw, ch = w / cols, h / rows
    return [sheet.crop((round(c * cw), round(r * ch), round((c + 1) * cw), round((r + 1) * ch)))
            for r in range(rows) for c in range(cols)]


def row_frames(sheet, n=8):
    """Single row (the idle sheet): split on the empty gaps between cats."""
    a = sheet.getchannel("A").point(lambda p: 255 if p > 40 else 0)
    w, h = sheet.size
    cols = [a.crop((x, 0, x + 1, h)).getbbox() is not None for x in range(w)]
    runs, start = [], None
    for x, on in enumerate(cols + [False]):
        if on and start is None:
            start = x
        if not on and start is not None:
            if x - start > 15:
                runs.append((start, x))
            start = None
    assert len(runs) == n, f"expected {n} cats in a row, found {len(runs)}"
    bounds = [0] + [(runs[i][1] + runs[i + 1][0]) // 2 for i in range(n - 1)] + [w]
    return [sheet.crop((bounds[i], 0, bounds[i + 1], h)) for i in range(n)]


def height(f):
    b = f.getchannel("A").point(lambda p: 255 if p > 40 else 0).getbbox()
    return b[3] - b[1]


def load(name, cache={}):
    if name not in cache:
        sheet = Image.open(SRC / name).convert("RGBA")
        if name == "idle.png":
            frames = row_frames(sheet)
        elif name in ("walk_right.png", "walk_left.png"):
            # 8 frames in one row of equal cells, lined up on the cat's eye
            # (cut out of walk_sheet.png, the drawn sheet:
            # top row facing right, bottom row facing left).
            frames = grid_frames(sheet, 8, 1)
        else:
            frames = grid_frames(sheet)
        cache[name] = [clean(f) for f in frames]
    return cache[name]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    # The idle sheet was drawn at a different size: match its sitting cat to the yawn sheet's.
    ref = sum(height(f) for f in load("yawn.png")[:1] + load("cry.png")[:1]) / 2
    idle_scale = GRID_SCALE * ref / height(load("idle.png")[0])
    # Each walk direction is scaled on its own, so the cat keeps its size when it turns.
    walk_k = {src: WALK_HEIGHT / (sum(height(f) for f in load(src)) / len(load(src)))
              for src in ("walk_right.png", "walk_left.png")}

    for name, (src, order) in ANIMS.items():
        frames = load(src)
        k = {"idle.png": idle_scale, **walk_k}.get(src, GRID_SCALE)
        order = list(order)
        scaled = {}
        for i in set(order):
            f = frames[i]
            scaled[i] = f.resize((round(f.width * k), round(f.height * k)), Image.LANCZOS)
            if name in FLIPPED:
                scaled[i] = scaled[i].transpose(Image.FLIP_LEFT_RIGHT)
        boxes = {i: s.getchannel("A").point(lambda p: 255 if p > 40 else 0).getbbox() for i, s in scaled.items()}
        # One horizontal offset for the whole animation (no side-to-side jitter),
        # centring the cat's average middle in the cell.
        mid = sum((b[0] + b[2]) / 2 for b in boxes.values()) / len(boxes)
        dx = round(CELL / 2 - mid)
        lowest = max(b[3] for b in boxes.values())
        strip = Image.new("RGBA", (CELL * len(order), CELL), (0, 0, 0, 0))
        for n, i in enumerate(order):
            # Feet on the ground line: per frame when standing, per sheet when airborne.
            dy = GROUND - (lowest if name in AIRBORNE else boxes[i][3])
            cell = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
            cell.paste(scaled[i], (dx, dy), scaled[i])
            strip.alpha_composite(cell, (n * CELL, 0))
        strip.save(OUT / f"{name}.png", optimize=True)
        print(f"{name:13} {len(order):2} frames")


if __name__ == "__main__":
    main()
