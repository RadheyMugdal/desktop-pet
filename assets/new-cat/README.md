> **Old.** The tabby is now built from `assets/cat-sheet/` (one full sheet).
> `build_old.py` here makes the previous version and would overwrite the new
> sprites, so don't run it unless you want the old cat back (it also needs the
> old pet.json).

# Tabby source sheets

`src/` holds the original sprite sheets (transparent PNGs). Each is a 4x2 grid
of 8 frames, except:

- `idle.png`: 8 frames in one row.
- `walk_right.png` / `walk_left.png`: 8 frames each in one row of equal
  cells, lined up on the cat's eye. They were cut out of `walk_sheet.png`, the
  drawn sheet (top row facing right, bottom row facing left).
  Older walk sheets are in `old/`.

To rebuild the pet after changing a sheet:

    python assets/new-cat/build_old.py

That slices the frames, drops stray bits, scales every animation to the same
size, lines the feet up on one ground line, and writes the strips to
`src/pets/tabby/`. Frame order per animation is set in `ANIMS` in build.py;
playback speed and which animation is used when is set in
`src/pets/tabby/pet.json`.
