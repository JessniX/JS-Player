# Prism Player

A customizable desktop media player with live visualizers, themes, an equalizer and ffmpeg conversion for formats the built-in decoder can't handle.

## Run it

```
npm install
npm start
```

Or double-click `Start Prism.bat`. To build a Windows installer with file associations: `npm run dist`.

## What it does

- **Plays almost anything.** Common formats (MP4, MKV/H.264, WebM, MP3, FLAC, WAV, OGG, Opus, AAC) play natively. Anything else (AVI/MPEG-2, WMV, FLV, HEVC on machines without hardware support, WMA, APE, AC3/DTS…) is converted once with ffmpeg and cached, then plays with seeking. If only the audio stream is unsupported, the video is copied as-is so conversion is fast.
- **7 live visualizers:** Bars, Mirror, Silk, Scope, Halo (ring around the album art), Nebula (particles that react to bass), Waterfall (spectrogram). You can set colors (theme, rainbow, fire, ice, custom 3-color gradient), bar count, sensitivity, smoothing, glow and peak caps, turn on a background pulse with the bass, and overlay the visualizer on videos.
- **Themes:** 10 built-in themes. You can edit every color, the corner radius, panel transparency, interface scale, font, a background image with blur, and add your own CSS. Save your own themes and import/export them as `.json`.
- **Audio:** 10-band EQ with 12 presets, preamp, bass boost, stereo balance, volume up to 200%.
- **Playback:** playlist with drag reorder, filter, shuffle and repeat. Remembers where you stopped in each file. A-B loop, speed 0.25–4× (pitch kept), frame step, screenshots, picture-in-picture, fullscreen with auto-hiding controls, always on top, Windows media keys.
- **Subtitles:** loads `.srt`/`.vtt` files automatically when they sit next to the video, or by drag-drop. Size and colors are adjustable.
- **Image viewer:** JPEG, PNG, GIF (animated), WebP, AVIF, BMP, SVG and ICO open directly. TIFF, HEIC, TGA, PSD, DDS, EXR, JPEG 2000, JPEG XL and others are converted once with ffmpeg. Opening one photo loads the rest of its folder. You can zoom with the wheel toward the cursor, drag to pan, fit or view at 100%, rotate and flip. There's a slideshow (1–30s, with fade, zoom or slide transitions), a filmstrip with cached thumbnails, an info panel, and a choice of background (theme, black, checkerboard for transparency, or a blurred copy of the photo). Photos and media can share one playlist. Opening a music folder skips its cover images.
- **Feeds:** switch to **Feeds** in the title bar to scroll YouTube Shorts, TikTok, Instagram Reels, Facebook Reels, X and Reddit inside Prism. You sign in on each site's own page; Prism never sees your password and only checks whether you're signed in, to show it on the cards. Sign-ins are kept in a separate, saved session, and each card has a Sign out button. **Auto next** (off by default, and Prism asks the first time) skips to the next video when one finishes. It uses the site's own "next" button, then the ↓ key, then scrolling. Videos in feeds you've left are paused and muted.
- **Opening files:** drag and drop files or whole folders, open with, or the command line.

## Keyboard

| Key | Action |
|---|---|
| Space / K | Play / pause |
| ← / → | Seek (Shift 1s, Ctrl 60s) |
| ↑ / ↓ | Volume |
| M | Mute |
| F / Enter / double-click | Fullscreen |
| N / P | Next / previous |
| [ / ] / Backspace | Slower / faster / normal |
| , / . | Frame step |
| L | A-B loop |
| V | Next visualizer |
| S | Screenshot |
| Tab | Toggle side panel |
| 0–9 | Jump to 0–90% |

When viewing images:

| Key | Action |
|---|---|
| ← / → / PgUp / PgDn | Previous / next image |
| Wheel, + / − | Zoom (Shift+wheel: next image) |
| Drag | Pan |
| 0 / 1 / double-click | Fit / 100% / toggle |
| R / Shift+R | Rotate right / left |
| H | Flip |
| Space | Slideshow |
| I / T | Info panel / filmstrip |
| Home / End | First / last image |

## Layout

- `main.js`: window, `prism://` protocol (UI and ranged media streaming), ffmpeg probe/convert/cover art, settings
- `preload.js`: safe bridge to the renderer
- `src/app.js`: player, playlist, EQ, settings and theme editor
- `feeds-main.js`: Feeds session, webview lockdown, sign-in status and sign out
- `src/feeds.js`: Feeds screen, site list (add a site to `FEEDS`), auto next
- `src/imageviewer.js`: image viewing, slideshow, filmstrip, info panel
- `src/visualizer.js`: visualizer modes. Add a mode by writing a `draw_<id>()` method and listing it in `VIZ_MODES`
- `src/themes.js`: theme presets and how they're applied
- `src/styles.css`: all styling (everything uses CSS variables)

Settings are stored in `%APPDATA%\prism-player\settings.json`.
