# Locally

Share videos, music and photos from your computer to any device on the same Wi-Fi. No cloud, no account, no upload. Your files stay on your computer.

Locally runs a small web server on your computer. Other devices open its address in a normal browser, or scan a QR code, and browse and play your media.

This repository contains the **Windows desktop app** (Electron). An **Android app** with the same features and the same web interface exists as a separate project.

## Features

- Choose a media folder from a dropdown of recent folders, or browse for a new one
- **Start**, **Pause** and **Stop** sharing
- QR code and link for other devices, with Copy and Open buttons
- Browse folders and subfolders, search, and filter by video, audio or images
- Video player with resume, next episode and subtitles (`.srt` and `.vtt` files placed next to the video)
- Audio player with a track list and automatic next track
- Image viewer with previous and next
- Seeking works in video and audio
- Zero dependencies in the server itself (plain Node.js)

## Supported formats

| Type  | Formats |
|-------|---------|
| Video | mp4, m4v, webm, mov, mkv, ogv |
| Audio | mp3, m4a, aac, wav, flac, ogg, oga, opus |
| Image | jpg, jpeg, png, gif, webp, avif, svg, bmp |

Whether a file plays depends on the viewing device's browser and hardware. If a file will not play, the page shows an `ffmpeg` command to convert it.

## Run from source

Requires [Node.js](https://nodejs.org) (LTS).

```bat
npm install
npm start
```

If PowerShell blocks npm scripts, use Command Prompt (`cmd`) instead.

## Build the Windows installer

```bat
npm run build
```

The installer is written to `dist\` as `Locally Setup 1.0.0.exe`. It is not code-signed, so Windows SmartScreen may show "Windows protected your PC". Click **More info**, then **Run anyway**.

When you first press Start, allow **Private networks** in the Windows Firewall prompt, or other devices will not be able to connect.

## Use

1. Open **Locally** and choose a media folder.
2. Press **Start**.
3. On another device on the same Wi-Fi, scan the QR code or type the address shown, for example `http://192.168.1.20:8000`.
4. **Pause** blocks access and stops anything currently playing. **Stop** shuts the server down.

## Use the server without the app

`server.js` also works on its own from a terminal with only Node.js installed:

```bat
node server.js "D:\Movies"
node server.js "D:\Movies\film.mp4"
node server.js "D:\Movies" --port 9000
```

The first form shares a whole folder. The second shares a single file.

## Project structure

```
main.js       Electron main process: window, folder picker, starts and stops the server
preload.js    safe bridge between the window and the main process
renderer.js   logic for the app window
index.html    the app window (folder, port, controls, QR code)
server.js     the media server and the web interface other devices see
package.json  app and installer settings
```

## Security

Version 1.0 has **no PIN or password**. Anyone on the same network who knows the address can browse and play your shared folder, and traffic is plain HTTP. Use it on networks you trust, such as your home Wi-Fi, and never expose it to the internet or forward its port on your router.

## Known limits

- Windows is the tested platform. The build settings include macOS and Linux, but they are untested.
- Embedded subtitle tracks inside MKV files are not shown. Only separate `.srt` and `.vtt` files work.
- No automatic format conversion yet.
- The app uses the default Electron icon.

## Roadmap

- PIN or password protection
- Custom app icon
- Tray icon, so closing the window keeps sharing
- Optional automatic conversion for formats a device cannot play
