Snaglet desktop {{VERSION}} for macOS.

**Requires macOS 14 (Sonoma) or later on Apple Silicon** — every M1-or-later
Mac can run this (macOS 14 is a free update).

Download **`Snaglet-{{VERSION}}-macos-arm64.dmg`** from the Assets below.

## Install

1. Open the DMG and drag **Snaglet** onto the **Applications** folder.
2. Eject the disk image.
3. Open Snaglet from your Applications folder.

Please don't run Snaglet straight from the disk image. macOS runs apps opened from a
disk image out of a temporary, read-only copy, so Snaglet would stop working the
moment you eject it. Snaglet detects this and tells you to move it instead of failing
in a confusing way.

## First launch: macOS blocks Snaglet once

Snaglet is **not notarized by Apple yet**, so macOS refuses to open it the first
time and warns that it cannot verify the developer. This is expected, it does
not mean the download is broken, and you only have to do it once.

1. Double-click Snaglet in your Applications folder. macOS shows a warning and
   refuses to open it — click **Done**.
2. Open **System Settings** → **Privacy & Security**.
3. Scroll down to the **Security** section. There is a message saying _"Snaglet" was
   blocked to protect your Mac_.
4. Click **Open Anyway**, then confirm with Touch ID or your password.

Snaglet opens, and you will not be asked again.

> On macOS 15 (Sequoia) and later, including macOS 26, Control-clicking the app
> and choosing **Open** no longer bypasses this. Use System Settings as above.

Prefer the Terminal? This does the same thing in one step:

```sh
xattr -dr com.apple.quarantine /Applications/Snaglet.app
```

## Your data stays on your Mac

Everything Snaglet stores lives in `~/.snaglet`: its database, logs and settings. There
is no Snaglet account, no Snaglet server and no telemetry. What you send to agents goes
to the model providers you connect. The first launch takes a little longer than
usual because Snaglet sets up its local PostgreSQL database, and it downloads its
search model (about 137 MB) in the background.

## Verify the download

Download `SHA256SUMS` into the folder that holds the DMG, then run:

```sh
grep 'Snaglet-{{VERSION}}-macos-arm64.dmg' SHA256SUMS | shasum -a 256 -c
```

Built from [`{{COMMIT_SHORT}}`](https://github.com/{{SOURCE_REPOSITORY}}/commit/{{COMMIT}}).
