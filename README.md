# Desktop Pet

A small pixel pet that lives on your desktop (Windows, macOS and Linux), built with [Tauri 2](https://tauri.app).

## Run

```bash
npm install
npm run dev
```

Build an installer for the system you're on:

```bash
npm run build
```

## Releasing for Windows, macOS and Linux

Each installer has to be built on its own OS, so `.github/workflows/release.yml` does it on GitHub's machines:

1. Push this project to a GitHub repository.
2. Push a version tag, for example `git tag v0.1.0` then `git push origin v0.1.0`.
3. The workflow builds `DesktopPet-windows-x64-setup.exe`, `DesktopPet-macos-universal.dmg`, `DesktopPet-linux-x86_64.AppImage` and `DesktopPet-linux-amd64.deb`, and attaches them to a GitHub release for that tag.

You can also run it by hand from the Actions tab to get the installers as build artifacts without making a release.

The installers aren't code-signed, so Windows SmartScreen and macOS Gatekeeper warn on first launch. The website explains how to get past that.

### Update signing (one-time setup)

Installed copies only accept updates signed with the project's update key. The key pair lives outside the repo at `~/.tauri/desktop-pet.key` (private) and `.key.pub` (public, already in `tauri.conf.json`).

1. On GitHub open **Settings → Secrets and variables → Actions → New repository secret**.
2. Name it `TAURI_SIGNING_PRIVATE_KEY` and paste the full contents of `~/.tauri/desktop-pet.key`.
3. Keep a backup of that file somewhere safe. If it's lost, installed copies can't be updated any more and people would have to reinstall.

The release workflow signs every installer and publishes `latest.json`, which is what installed copies check.

## Website

`website/` is the landing page: plain HTML, CSS and JS with no build step. It uses the real sprites, so visitors can pet the kitten and dress up the cat.

- Set `REPO` at the top of `website/script.js` to your GitHub `owner/name`. The download buttons link to `releases/latest/download/<file>`, so they always serve the newest release.
- Preview it locally with `python -m http.server 8765 --directory website`.
- Host it on any static host, for example GitHub Pages, Netlify or Cloudflare Pages.

## What it does

- Three pets: **Tabby** (the new flagship default; hand-drawn expressive animations, stretching, loafing, and cozy nap cycles), **Kitten** (classic pixel kitten; round-faced, sits in its box, Dracula costume), and **Cat** (more than 40 pixel animations, 3 colors, 11 outfits). Switch between them from the tray.
- **Interactive play & feeding:** Drop a bouncy yarn ball for your cat to chase and bat across the screen, or serve a bowl of food from the tray menu.
- **Pomodoro focus timer & break reminders:** Set a 25-minute focus session where your pet quietly keeps you company beside a mini desk clock, then gently suggests a stretch when it's break time.
- **Smart work awareness (auto-rest):** Senses when you are actively typing or moving your mouse, quietly curling up and loafing so it never interrupts your workflow.
- **Cozy audio:** Sweet short meows, happy greeting trills, and soft purrs with volume normalization and zero harsh looping drones.
- Falls in from the top of the screen and lands on its **home spot**, by default the bottom-right corner near the clock. It mostly stays there, taking a few steps now and then. Drag it somewhere and that becomes its new home. Turn on **Roam freely** in the tray to let it wander the taskbar.
- Drag it and it dangles; shake it hard and it hisses when it lands and runs off
- Tray menu: Nap time, Bring pet back, **Pet**, **Color**, **Outfit**, **Focus & reminders**, **Feed**, **Play with yarn**, **Roam freely**, Quit. Choices and home spots are saved for each pet.
- Hides and stops animating while a fullscreen app (game or video) is in front (Windows)
- Naps when you step away for 3 minutes and wakes up happy when you're back (Windows and macOS)
- **Break reminders:** after 50 minutes of work without a 5-minute break, it suggests one in a speech bubble, and again every 15 minutes until you take one. Pet it to dismiss. Turn it off in the menu.
- **Right-click the pet** for the same menu as the tray icon
- **Start with computer** is on after installing, and you can turn it off in the menu
- **Updates itself:** it checks GitHub every few hours, downloads new versions in the background, and shows "Restart to update" in the menu

## Why it uses so little

- The window never moves. It's a transparent overlay covering the work area, and the cat moves inside it. Moving a webview window is expensive; repainting one small sprite is not.
- Clicks pass through everywhere except the cat. A Rust thread checks the cursor 20 times a second and only lets the window take the mouse while the cursor is over the cat's hitbox (`hitbox` in `pet.json`).
- The loop runs only as fast as the current animation needs: 10 fps walking, 1.5 fps asleep, 2 fps holding a pose, and not at all behind fullscreen apps. Hearts and z's are moved by the same loop, so nothing redraws in between.
- It uses Tauri, which runs on the system webview, instead of Electron.

Measured on Windows (debug build), as a share of one CPU core: the Kitten uses about 1% sitting or asleep; the Cat about 0.5% sitting, 4% asleep, and 7% walking (down from 21% when the window itself moved). With a home spot, the pet rarely walks. Total memory is about 200 MB, mostly WebView2.

While you drag the pet to another monitor, it stays on the monitor it started on. When you let go, it jumps to where you dropped it.

## Adding or replacing a pet

Pets are listed in `src/pets/index.json`, and each one is a folder in `src/pets/<id>/` with a `pet.json`:

```json
{
  "frameSize": 32,
  "scale": 4,
  "ground": 25,
  "hitbox": [4, 6, 28, 25],
  "walkSpeed": 38,
  "colors": [{ "id": "ginger", "name": "Ginger", "file": "colors/ginger.png" }],
  "outfits": [{ "id": "pink-bow", "name": "Pink bow", "file": "outfits/pink-bow.png" }],
  "fallback": "sit",
  "sleepPoses": ["sleep1"],
  "fidgets": { "sit": ["wash_sit"], "lie": ["wash_lie"] },
  "reactions": { "sit": ["meow_sit"], "lie": ["meow_lie"] },
  "animations": {
    "walk_left": { "row": 7, "frames": 8, "fps": 10 },
    "sit": { "row": 0, "col": 0, "frames": 1 },
    "lie": { "file": "box.png", "frames": 4, "fps": 4 }
  }
}
```

- Each animation is a row of the color's sprite sheet, or of its own `file`.
- The engine uses these names: `sit`, `lie`, `walk`, `dangle`, the `sleepPoses`, and optionally `yawn_sit`, `paw`, `hiss`, plus anything listed in `fidgets` and `reactions`. A missing one-shot is skipped, and a missing loop uses `fallback`.
- A `name_left` / `name_right` pair is chosen automatically from the direction the pet faces. `"hop": true` makes a pet with no walk cycle bounce as it moves.
- `ground` is the pixel row the feet stand on, `dy` nudges a single animation up or down, and `hitbox` (x0, y0, x1, y1, in sprite pixels) is where the pet catches the mouse.
- A color is a full sheet with the same layout, and can `remap` animations, as the Kitten's Dracula look does. Outfits are transparent sheets with the main sheet's layout, drawn on top of the pet.

## Layout

- `src/main.js`: pet engine (modes, physics, dragging, effects)
- `src/style.css`: sprite layers and the drag wiggle and landing squash
- `src-tauri/src/main.rs`: tray menu (built from `pet.json`), mouse click-through, and fullscreen detection
- `src-tauri/tauri.conf.json`: transparent, frameless, always-on-top window

## Credits

The Kitten (`CatPackFree`), the Cat (`Free pack`) and the outfits (`14 feb`) come from free downloadable asset packs. Check each pack's download page for the license terms and the credit it requires before you publish.
