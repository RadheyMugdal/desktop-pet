# Tabby, full sprite sheet

`sheet.png` is the whole cat on one transparent sheet: 7 rows of 8 kittens.

| Row | Animation | Used for |
| --- | --- | --- |
| 1 | sit | idle (front view) |
| 2 | walk right | walking right |
| 3 | walk left | walking left |
| 4 | jump right | crouch (2-3), jump (4-6), land (7-8); mirrored for jumping left |
| 5 | yawn | before a nap and when waking up |
| 6 | sleep | napping |
| 7 | held | when you pick the cat up (hangs by the scruff) |

To rebuild the pet after changing the sheet:

    python assets/cat-sheet/build.py

Needs Pillow and numpy. It cuts out every kitten, scales them all the same,
lines each animation up so nothing jitters, writes the strips to
`src/pets/tabby/`, and updates `frameSize`, `ground`, `hitbox` and `grip` in
`src/pets/tabby/pet.json`. Frame order per animation is set in `ANIMS` in
build.py; speeds are in pet.json.

The kittens on the sheet must not touch each other, and there must be exactly
7 rows of 8.
