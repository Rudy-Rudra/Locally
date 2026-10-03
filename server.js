#!/usr/bin/env node
// Local video server. No dependencies.
//
//   node server.js "path/to/folder"      serves all videos, music and images in the folder, subfolders included
//   node server.js "path/to/file.mp4"     serves that single file (video, audio or image)
//   node server.js "path" --port 9000    use another port (default 8000, or the PORT env variable)

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------- arguments ----------
const args = process.argv.slice(2);
let target = './videos';
let port = Number(process.env.PORT) || 8000;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' || args[i] === '-p') port = Number(args[++i]);
  else target = args[i];
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('Invalid port. Use a number between 1 and 65535.');
  process.exit(1);
}

const MEDIA = {
  // video
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
  '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.ogv': 'video/ogg',
  // audio
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav',
  '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg',
  // images
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
};
const kindOf = f => (MEDIA[ext(f)] || '').split('/')[0]; // 'video' | 'audio' | 'image'
const SUB = new Set(['.srt', '.vtt']);
const ext = f => path.extname(f).toLowerCase();
const isHidden = n => n.startsWith('.') || n === 'node_modules';

const abs0 = path.resolve(target);
let st;
try { st = fs.statSync(abs0); } catch {
  console.error(`Path not found: ${abs0}\nUsage: node server.js "folder or video file path"`);
  process.exit(1);
}
if (st.isFile() && !MEDIA[ext(abs0)]) {
  console.error(`Not a supported media file: ${abs0}\nSupported: ${Object.keys(MEDIA).join(' ')}`);
  process.exit(1);
}
const SINGLE = st.isFile() ? path.basename(abs0) : null;
const ROOT = st.isFile() ? path.dirname(abs0) : abs0;
const TITLE = SINGLE
  ? path.parse(SINGLE).name.replace(/[._]+/g, ' ').trim()
  : (path.basename(ROOT) || 'Videos');

// ---------- file system helpers ----------
function safe(rel) {
  if (rel.includes('\0')) return null;
  const abs = path.resolve(ROOT, ...rel.split('/').filter(Boolean));
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return null; // blocks ../ traversal
  if (SINGLE && abs !== ROOT) {
    if (path.dirname(abs) !== ROOT) return null;
    const b = path.basename(abs);
    const okVideo = b === SINGLE;
    const okSub = SUB.has(ext(b)) && b.startsWith(path.parse(SINGLE).name + '.');
    if (!okVideo && !okSub) return null;
  }
  return abs;
}

function countVideos(dir, depth = 0) {
  let n = 0, ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of ents) {
    if (isHidden(e.name)) continue;
    if (e.isDirectory()) { if (depth < 6) n += countVideos(path.join(dir, e.name), depth + 1); }
    else if (MEDIA[ext(e.name)]) n++;
  }
  return n;
}

function subLabel(file, stem) {
  const tag = file.slice(stem.length + 1).replace(/\.[^.]+$/, '');
  return tag ? tag : 'Subtitles';
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function list(rel) {
  const abs = safe(rel);
  if (!abs || (SINGLE && abs !== ROOT)) return null;
  let ents;
  try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch { return null; }
  const names = ents.map(e => e.name);
  const folders = [], files = [];
  for (const e of ents) {
    if (isHidden(e.name)) continue;
    const relPath = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) {
      if (SINGLE) continue;
      const count = countVideos(path.join(abs, e.name));
      if (count) folders.push({ name: e.name, path: relPath, count });
    } else if (MEDIA[ext(e.name)]) {
      if (SINGLE && e.name !== SINGLE) continue;
      const stem = path.parse(e.name).name;
      const subs = kindOf(e.name) !== 'video' ? [] : names
        .filter(n => SUB.has(ext(n)) && n.startsWith(stem + '.'))
        .map(n => ({ label: subLabel(n, stem), path: rel ? rel + '/' + n : n }));
      let size = 0;
      try { size = fs.statSync(path.join(abs, e.name)).size; } catch {}
      files.push({ name: e.name, path: relPath, size, subs, kind: kindOf(e.name) });
    }
  }
  folders.sort((a, b) => collator.compare(a.name, b.name));
  files.sort((a, b) => collator.compare(a.name, b.name));
  return { path: rel, folders, files };
}

// ---------- responses ----------
function json(res, data, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function stream(req, res, rel) {
  const file = safe(rel);
  if (!file || !MEDIA[ext(file)]) { res.writeHead(404); return res.end('Not found'); }
  fs.stat(file, (err, s) => {
    if (err || !s.isFile()) { res.writeHead(404); return res.end('Not found'); }
    const type = MEDIA[ext(file)];
    const size = s.size;
    const range = req.headers.range;
    let start = 0, end = size - 1, code = 200;
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': 'sandbox' };

    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!m || (!m[1] && !m[2])) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
      if (m[1]) { start = parseInt(m[1], 10); end = m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1; }
      else { start = Math.max(size - parseInt(m[2], 10), 0); }
      if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
      code = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(code, headers);
    if (size === 0) return res.end();
    const rs = fs.createReadStream(file, { start, end });
    rs.on('error', () => res.destroy());
    res.on('close', () => rs.destroy());
    rs.pipe(res);
  });
}

function subtitle(res, rel) {
  const file = safe(rel);
  if (!file || !SUB.has(ext(file))) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(file, 'utf8', (err, text) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    if (!text.startsWith('WEBVTT')) {
      text = 'WEBVTT\n\n' + text.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2'); // SRT -> VTT
    }
    res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(text);
  });
}

// ---------- web page ----------
const HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#161220">
<title>Locally</title>
<style>
*{box-sizing:border-box}
[hidden]{display:none!important}
:root{--bg:#161220;--panel:#211b2f;--raise:#2c2440;--line:#3b3253;--text:#f3effa;--muted:#a79fba;--accent:#ff7a90;--ink:#2a0d14;--r:14px}
html{color-scheme:dark}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 "Avenir Next","Segoe UI",system-ui,-apple-system,Roboto,sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.top{position:sticky;top:0;z-index:5;display:flex;gap:1rem;align-items:center;justify-content:space-between;padding:.8rem clamp(1rem,4vw,2.5rem);background:rgba(22,18,32,.88);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.brand{font-weight:700;font-size:1.15rem;letter-spacing:-.01em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#q{width:min(320px,55%);background:var(--panel);border:1px solid var(--line);color:var(--text);border-radius:999px;padding:.55rem 1rem;font:inherit;font-size:.95rem}
#q::placeholder{color:var(--muted)}
main{padding:1.5rem clamp(1rem,4vw,2.5rem) 4rem;max-width:1400px;margin:0 auto}
.crumbs{display:flex;flex-wrap:wrap;gap:.4rem;color:var(--muted);font-size:.92rem;margin-bottom:1rem}
.crumbs a:hover{color:var(--text)}
.crumbs .sep{opacity:.5}
h1.page{font-size:clamp(1.7rem,4.5vw,2.6rem);line-height:1.12;margin:0 0 .35rem;letter-spacing:-.025em;overflow-wrap:anywhere}
.lead{color:var(--muted);margin:0 0 1.5rem}
.section-title{font-size:1rem;color:var(--muted);font-weight:600;margin:2rem 0 .85rem}
.grid{display:grid;gap:1.1rem;grid-template-columns:repeat(auto-fill,minmax(min(100%,210px),1fr))}
.tile{display:block}
.poster{position:relative;aspect-ratio:16/10;border-radius:var(--r);overflow:hidden;padding:.9rem;display:flex;align-items:flex-end;font-weight:700;font-size:1.02rem;line-height:1.2;letter-spacing:-.01em;background:linear-gradient(145deg,hsl(var(--h) 42% 33%),hsl(calc(var(--h) + 45) 48% 19%));transition:transform .18s}
.tile:hover .poster,.tile:focus-visible .poster{transform:translateY(-3px)}
.poster .t{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;text-shadow:0 1px 8px rgba(0,0,0,.45)}
.play{position:absolute;right:.7rem;top:.7rem;width:34px;height:34px;border-radius:50%;background:var(--accent);display:grid;place-items:center;opacity:0;transition:opacity .15s}
.tile:hover .play,.tile:focus-visible .play{opacity:1}
@media(hover:none){.play{opacity:1}}
.play svg{width:14px;height:14px;fill:var(--ink);margin-left:2px}
.bar{position:absolute;left:0;right:0;bottom:0;height:4px;background:rgba(0,0,0,.4)}
.bar i{display:block;height:100%;background:var(--accent)}
.meta{display:flex;justify-content:space-between;gap:.5rem;color:var(--muted);font-size:.85rem;margin-top:.5rem}
.folder{margin-top:11px}
.folder .poster{background:var(--raise);box-shadow:0 -5px 0 -1px #3b3253,0 -10px 0 -2px #2a2239}
.empty{border:1px dashed var(--line);border-radius:var(--r);padding:2.5rem 1.5rem;text-align:center;color:var(--muted)}
.watch{display:grid;gap:1.5rem}
@media(min-width:960px){.watch:not(.solo){grid-template-columns:minmax(0,1fr) 340px;align-items:start}}
.stage{background:#000;border-radius:var(--r);overflow:hidden;aspect-ratio:16/9;max-height:80vh;margin:0 auto;width:100%}
video{width:100%;height:100%;display:block;background:#000}
.title{font-size:clamp(1.2rem,2.6vw,1.65rem);margin:1.1rem 0 .3rem;letter-spacing:-.015em;overflow-wrap:anywhere}
.hint{color:var(--muted);font-size:.85rem;margin:.25rem 0 0}
.row{display:flex;flex-wrap:wrap;gap:.6rem;align-items:center}
.btn{border:1px solid var(--line);background:var(--panel);color:var(--text);padding:.5rem 1rem;border-radius:999px;font:inherit;font-size:.9rem;cursor:pointer}
.btn:hover{background:var(--raise)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--ink);font-weight:600}
.notice{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:.8rem 1rem;margin-top:1rem;font-size:.92rem}
.notice .row{justify-content:space-between}
.notice code{display:block;margin-top:.5rem;background:var(--bg);padding:.5rem .7rem;border-radius:8px;word-break:break-all;font-size:.82rem}
.queue{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);overflow-y:auto;max-height:72vh}
.queue h2{font-size:.95rem;margin:0;padding:.85rem 1rem;color:var(--muted);font-weight:600;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--panel);z-index:1}
.qi{display:block;padding:.7rem 1rem;border-bottom:1px solid var(--line)}
.qi:last-child{border-bottom:0}
.qi:hover{background:var(--raise)}
.qi.on{background:var(--raise);box-shadow:inset 3px 0 0 var(--accent)}
.qi .n{font-size:.92rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qi .p{height:3px;background:var(--bg);margin-top:.45rem;border-radius:2px}
.qi .p i{display:block;height:100%;background:var(--accent);border-radius:2px}
.poster.img{padding:0;background:var(--raise)}
.poster.img img{width:100%;height:100%;object-fit:cover;display:block}
.meta span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chips{display:flex;gap:.5rem;flex-wrap:wrap;margin:0 0 1.25rem}
.chip{border:1px solid var(--line);background:transparent;color:var(--muted);padding:.35rem .95rem;border-radius:999px;font:inherit;font-size:.88rem;cursor:pointer}
.chip.on{background:var(--text);border-color:var(--text);color:var(--bg)}
.stage.audio{display:flex;flex-direction:column;background:linear-gradient(145deg,hsl(var(--h) 42% 33%),hsl(calc(var(--h) + 45) 48% 19%))}
.stage.audio .art{flex:1;display:grid;place-items:center;min-height:0}
.art svg{width:min(26%,110px);fill:rgba(255,255,255,.85)}
audio{width:calc(100% - 2rem);margin:0 1rem 1rem}
.stage.img{aspect-ratio:auto;height:min(75vh,900px);display:grid;place-items:center}
.stage.img img{max-width:100%;max-height:100%;object-fit:contain;display:block}
a.btn{display:inline-block}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
</style>
</head>
<body>
<header class="top">
  <a class="brand" id="brand" href="#/b/">Locally</a>
  <input id="q" type="search" placeholder="Search this folder" aria-label="Search this folder">
</header>
<main id="app"></main>
<script>
(function () {
  var app = document.getElementById('app');
  var q = document.getElementById('q');
  var brand = document.getElementById('brand');
  var info = { title: 'Locally', single: null };
  var cleanup = null;
  var filterFn = null;

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function clean(n) { return n.replace(/\.[^.]+$/, '').replace(/[._]+/g, ' ').trim(); }
  function hue(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; }
  function fmt(s) {
    s = Math.max(0, Math.floor(s || 0));
    var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
    var sec = (x < 10 ? '0' : '') + x;
    return h ? h + ':' + (m < 10 ? '0' : '') + m + ':' + sec : m + ':' + sec;
  }
  function bytes(b) {
    var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0;
    while (b >= 1024 && i < 4) { b /= 1024; i++; }
    return (i > 1 ? b.toFixed(1) : Math.round(b)) + ' ' + u[i];
  }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
  function hb(p) { return '#/b/' + encodeURIComponent(p); }
  function hw(p) { return '#/w/' + encodeURIComponent(p); }

  function prog() { try { return JSON.parse(localStorage.getItem('hc-progress') || '{}'); } catch (e) { return {}; } }
  function saveProg(p, t, d) {
    var o = prog(); o[p] = { t: t, d: d };
    try { localStorage.setItem('hc-progress', JSON.stringify(o)); } catch (e) {}
  }
  function pct(o, p) { var x = o[p]; return x && x.d ? Math.min(100, Math.round(x.t / x.d * 100)) : 0; }

  function api(p) {
    return fetch('/api/list?path=' + encodeURIComponent(p)).then(function (r) {
      if (!r.ok) throw new Error('This folder could not be opened.');
      return r.json();
    });
  }

  var PLAY = '<span class="play"><svg viewBox="0 0 10 12"><path d="M0 0l10 6-10 6z"/></svg></span>';

  var NOTEPATH = '<path d="M4 1v7.2A2.5 2.5 0 1 0 5.5 10.5V4h4V1z"/>';
  var NOTE = '<span class="play"><svg viewBox="0 0 12 12">' + NOTEPATH + '</svg></span>';
  var KIND_LABEL = { video: 'video', audio: 'audio file', image: 'image' };
  var KIND_CHIP = { all: 'All', video: 'Video', audio: 'Audio', image: 'Images' };
  var kindFilter = 'all';

  function tileFor(f, pr) {
    var c = pct(pr, f.path);
    var inner;
    if (f.kind === 'image') {
      inner = '<div class="poster img"><img loading="lazy" alt="" src="/stream?path=' + encodeURIComponent(f.path) + '"></div>';
    } else {
      inner = '<div class="poster" style="--h:' + hue(f.name) + '"><span class="t">' + esc(clean(f.name)) + '</span>' + (f.kind === 'audio' ? NOTE : PLAY) +
        (c > 0 ? '<div class="bar"><i style="width:' + c + '%"></i></div>' : '') + '</div>';
    }
    return '<a class="tile" data-kind="' + f.kind + '" data-name="' + esc(f.name.toLowerCase()) + '" href="' + hw(f.path) + '">' + inner +
      '<div class="meta"><span>' + (f.kind === 'image' ? esc(clean(f.name)) : bytes(f.size)) + '</span><span>' +
      esc(f.name.split('.').pop().toUpperCase()) + (f.subs.length ? ' + subtitles' : '') + '</span></div></a>';
  }

  function browse(p) {
    app.innerHTML = '<p class="lead">Loading...</p>';
    kindFilter = 'all';
    return api(p).then(function (d) {
      var pr = prog();
      var parts = p ? p.split('/') : [];
      var name = parts.length ? parts[parts.length - 1] : info.title;
      document.title = name + ' - ' + info.title;

      var crumbs = '';
      if (parts.length) {
        var acc = '';
        crumbs = '<nav class="crumbs"><a href="' + hb('') + '">' + esc(info.title) + '</a>';
        parts.forEach(function (s, i) {
          acc = acc ? acc + '/' + s : s;
          crumbs += '<span class="sep">/</span>' + (i < parts.length - 1 ? '<a href="' + hb(acc) + '">' + esc(s) + '</a>' : '<span>' + esc(s) + '</span>');
        });
        crumbs += '</nav>';
      }

      var kinds = ['video', 'audio', 'image'].filter(function (k) { return d.files.some(function (x) { return x.kind === k; }); });
      var bits = [];
      if (d.folders.length) bits.push(plural(d.folders.length, 'folder'));
      kinds.forEach(function (k) { bits.push(plural(d.files.filter(function (x) { return x.kind === k; }).length, KIND_LABEL[k])); });

      var html = crumbs + '<h1 class="page">' + esc(name) + '</h1><p class="lead">' + (bits.join(', ') || 'Nothing here yet') + '</p>';
      if (kinds.length > 1) {
        html += '<div class="chips">' + ['all'].concat(kinds).map(function (k) {
          return '<button type="button" class="chip' + (k === 'all' ? ' on' : '') + '" data-k="' + k + '">' + KIND_CHIP[k] + '</button>';
        }).join('') + '</div>';
      }
      if (!d.folders.length && !d.files.length) {
        html += '<div class="empty">No media found. Add video, audio or image files to the folder, then reload this page.</div>';
      }
      if (d.folders.length) {
        html += '<div class="grid">' + d.folders.map(function (f) {
          return '<a class="tile folder" data-name="' + esc(f.name.toLowerCase()) + '" href="' + hb(f.path) + '">' +
            '<div class="poster"><span class="t">' + esc(f.name) + '</span></div>' +
            '<div class="meta"><span>' + plural(f.count, 'item') + '</span></div></a>';
        }).join('') + '</div>';
      }
      if (d.files.length) {
        if (d.folders.length) html += '<h2 class="section-title">Files</h2>';
        html += '<div class="grid">' + d.files.map(function (f) { return tileFor(f, pr); }).join('') + '</div>';
      }
      html += '<p class="empty" id="none" hidden>No matches in this folder.</p>';
      app.innerHTML = html;

      var tiles = Array.prototype.slice.call(app.querySelectorAll('.tile'));
      var none = document.getElementById('none');
      filterFn = function (v) {
        v = v.trim().toLowerCase();
        var n = 0;
        tiles.forEach(function (t) {
          var ok = t.dataset.name.indexOf(v) > -1 && (kindFilter === 'all' || !t.dataset.kind || t.dataset.kind === kindFilter);
          t.hidden = !ok; if (ok) n++;
        });
        none.hidden = n > 0 || !tiles.length;
      };
      var chips = Array.prototype.slice.call(app.querySelectorAll('.chip'));
      chips.forEach(function (b) {
        b.onclick = function () {
          kindFilter = b.dataset.k;
          chips.forEach(function (x) { x.classList.toggle('on', x === b); });
          filterFn(q.value);
        };
      });
    });
  }

  function watch(p) {
    var i = p.lastIndexOf('/');
    var dir = i < 0 ? '' : p.slice(0, i);
    return api(dir).then(function (d) {
      var pr = prog();
      var f = null;
      d.files.forEach(function (x) { if (x.path === p) f = x; });
      if (!f) throw new Error('This file is not in the library.');
      var kind = f.kind;
      var same = d.files.filter(function (x) { return x.kind === kind; });
      var idx = 0;
      same.forEach(function (x, n) { if (x.path === p) idx = n; });
      var next = same[idx + 1] || null, prev = same[idx - 1] || null;
      var solo = same.length < 2;
      var isMedia = kind !== 'image';
      var src = '/stream?path=' + encodeURIComponent(p);
      document.title = clean(f.name) + ' - ' + info.title;

      var back = '';
      if (!info.single) {
        var dn = dir ? dir.split('/').pop() : info.title;
        back = '<nav class="crumbs"><a href="' + hb(dir) + '">Back to ' + esc(dn) + '</a></nav>';
      }
      var stage;
      if (kind === 'video') {
        var tracks = f.subs.map(function (s) {
          return '<track kind="subtitles" label="' + esc(s.label) + '" src="/sub?path=' + encodeURIComponent(s.path) + '">';
        }).join('');
        stage = '<div class="stage"><video id="v" controls autoplay playsinline preload="metadata" src="' + src + '">' + tracks + '</video></div>';
      } else if (kind === 'audio') {
        stage = '<div class="stage audio" style="--h:' + hue(f.name) + '"><div class="art"><svg viewBox="0 0 12 12">' + NOTEPATH + '</svg></div>' +
          '<audio id="v" controls autoplay preload="metadata" src="' + src + '"></audio></div>';
      } else {
        stage = '<div class="stage img"><img id="v" alt="' + esc(clean(f.name)) + '" src="' + src + '"></div>';
      }
      var hint;
      if (kind === 'image') hint = 'The left and right arrow keys move between images, and F goes fullscreen.';
      else if (kind === 'audio') hint = 'Space plays or pauses, the arrow keys skip 10 seconds' + (next ? ', N plays the next track' : '') + '.';
      else hint = 'Space plays or pauses, the arrow keys skip 10 seconds, F goes fullscreen' + (next ? ', N plays the next video' : '') + '.' + (f.subs.length ? ' Turn on subtitles from the player menu.' : '');
      var nav = '';
      if (kind === 'image' && !solo) {
        nav = '<div class="row" style="margin-top:.9rem">' + (prev ? '<a class="btn" href="' + hw(prev.path) + '">Previous</a>' : '') + (next ? '<a class="btn primary" href="' + hw(next.path) + '">Next</a>' : '') + '</div>';
      }
      var queue = '';
      if (!solo) {
        var heading = { video: 'Videos in this folder', audio: 'Tracks in this folder', image: 'Images in this folder' }[kind];
        queue = '<aside class="queue" id="queue"><h2>' + heading + '</h2>' + same.map(function (x) {
          var c = pct(pr, x.path);
          return '<a class="qi' + (x.path === p ? ' on' : '') + '" href="' + hw(x.path) + '"><div class="n">' + esc(clean(x.name)) + '</div>' +
            (c > 0 && x.kind !== 'image' ? '<div class="p"><i style="width:' + c + '%"></i></div>' : '') + '</a>';
        }).join('') + '</aside>';
      }

      app.innerHTML = back +
        '<div class="watch' + (solo ? ' solo' : '') + '"><section>' + stage + nav +
        '<h1 class="title">' + esc(clean(f.name)) + '</h1><p class="hint">' + hint + '</p>' +
        '<div class="notice" id="ro" hidden><div class="row"><span id="rot"></span><button class="btn" id="restart" type="button">Start over</button></div></div>' +
        '<div class="notice" id="nx" hidden><div class="row"><span id="nxt"></span><span class="row"><button class="btn primary" id="nxgo" type="button">Play now</button><button class="btn" id="nxno" type="button">Cancel</button></span></div></div>' +
        '<div class="notice" id="er" hidden></div></section>' + queue + '</div>';

      var v = document.getElementById('v');
      var ro = document.getElementById('ro'), nx = document.getElementById('nx'), er = document.getElementById('er');
      var nxt = document.getElementById('nxt');
      var timer = null, last = 0, saved = pr[p];

      var qEl = document.getElementById('queue');
      if (qEl) { var on = qEl.querySelector('.on'); if (on) qEl.scrollTop = Math.max(0, on.offsetTop - 70); }

      function go(t) { if (t) location.hash = hw(t.path); }
      function save() { if (isMedia && v.duration) saveProg(p, v.currentTime, v.duration); }

      v.addEventListener('error', function () {
        er.hidden = false;
        if (kind === 'video') er.innerHTML = 'This browser cannot play this file. The cause is usually the video or audio codec rather than the file type. Convert it to H.264 video with AAC audio:<code>ffmpeg -i "' + esc(f.name) + '" -c:v libx264 -c:a aac -movflags +faststart output.mp4</code>';
        else if (kind === 'audio') er.innerHTML = 'This browser cannot play this audio format. Convert it to MP3:<code>ffmpeg -i "' + esc(f.name) + '" output.mp3</code>';
        else er.textContent = 'This browser cannot display this image. Convert it to JPG or PNG first.';
      });

      if (isMedia) {
        v.addEventListener('loadedmetadata', function () {
          if (saved && saved.t > 10 && saved.t < v.duration - 20) {
            v.currentTime = saved.t;
            document.getElementById('rot').textContent = 'Resumed at ' + fmt(saved.t) + '.';
            ro.hidden = false;
          }
        }, { once: true });
        document.getElementById('restart').onclick = function () { v.currentTime = 0; ro.hidden = true; v.play(); };
        v.addEventListener('timeupdate', function () { var n = Date.now(); if (n - last > 3000) { last = n; save(); } });
        v.addEventListener('pause', save);
        v.addEventListener('ended', function () {
          saveProg(p, v.duration, v.duration);
          if (!next) return;
          var s = kind === 'audio' ? 2 : 8;
          nx.hidden = false;
          function tick() {
            nxt.textContent = 'Next: ' + clean(next.name) + ' starts in ' + s + 's';
            if (s <= 0) { clearInterval(timer); go(next); return; }
            s--;
          }
          tick();
          timer = setInterval(tick, 1000);
        });
      }
      document.getElementById('nxgo').onclick = function () { clearInterval(timer); go(next); };
      document.getElementById('nxno').onclick = function () { clearInterval(timer); nx.hidden = true; };

      function key(e) {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON' || e.metaKey || e.ctrlKey || e.altKey) return;
        var k = e.key.toLowerCase(), hit = true;
        if (k === 'arrowright') { if (isMedia) v.currentTime += 10; else go(next); }
        else if (k === 'arrowleft') { if (isMedia) v.currentTime -= 10; else go(prev); }
        else if (k === 'n' && next) { go(next); }
        else if (k === 'f' && kind !== 'audio') {
          var t = kind === 'video' ? v : v.parentNode;
          if (document.fullscreenElement) document.exitFullscreen();
          else if (t.requestFullscreen) t.requestFullscreen();
          else if (t.webkitEnterFullscreen) t.webkitEnterFullscreen();
        }
        else if (isMedia && (k === ' ' || k === 'k')) { if (v.paused) v.play(); else v.pause(); }
        else if (isMedia && k === 'm') { v.muted = !v.muted; }
        else hit = false;
        if (hit) e.preventDefault();
      }
      document.addEventListener('keydown', key);
      window.addEventListener('pagehide', save);

      cleanup = function () {
        clearInterval(timer);
        document.removeEventListener('keydown', key);
        window.removeEventListener('pagehide', save);
        if (isMedia) { save(); v.pause(); v.removeAttribute('src'); v.load(); }
      };
    });
  }

  function route() {
    if (cleanup) { cleanup(); cleanup = null; }
    filterFn = null;
    q.value = '';
    var m = location.hash.match(/^#\/(b|w)\/(.*)$/);
    if (!m) { location.replace(info.single ? hw(info.single) : hb('')); return; }
    q.hidden = m[1] === 'w';
    var p = decodeURIComponent(m[2]);
    (m[1] === 'w' ? watch(p) : browse(p)).catch(function (e) {
      app.innerHTML = '<div class="empty">' + esc(e.message) + ' <a href="' + hb('') + '" style="text-decoration:underline">Go to the start</a></div>';
    });
  }

  q.addEventListener('input', function () { if (filterFn) filterFn(q.value); });

  fetch('/api/info').then(function (r) { return r.json(); }).then(function (i) {
    info = i;
    brand.textContent = i.title;
    brand.href = i.single ? hw(i.single) : hb('');
  }).catch(function () {}).then(function () {
    window.addEventListener('hashchange', route);
    route();
  });
})();
</script>
</body>
</html>`;

// ---------- server ----------
process.on('uncaughtException', err => console.error('Error:', err.message));
let paused = false;
const server = http.createServer((req, res) => {
  if (paused) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '5' });
    return res.end('Sharing is paused by the host. Try again soon.');
  }
  let u;
  try { u = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); return res.end(); }
  const rel = (u.searchParams.get('path') || '').replace(/^\/+|\/+$/g, '');
  switch (u.pathname) {
    case '/':
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(HTML);
    case '/api/info':
      return json(res, { title: TITLE, single: SINGLE });
    case '/api/list': {
      const d = list(rel);
      return d ? json(res, d) : json(res, { error: 'Not found' }, 404);
    }
    case '/stream': return stream(req, res, rel);
    case '/sub': return subtitle(res, rel);
    default:
      res.writeHead(404); return res.end('Not found');
  }
});

// The desktop app controls the server through messages: 'pause' and 'resume'.
process.on('message', m => {
  if (m === 'pause') { paused = true; if (server.closeAllConnections) server.closeAllConnections(); }
  else if (m === 'resume') paused = false;
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${port} is already in use. Try: node server.js "${target}" --port ${port + 1}`);
  else console.error(err.message);
  process.exit(1);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Serving ${SINGLE ? path.join(ROOT, SINGLE) : ROOT}`);
  console.log(`  This computer:  http://localhost:${port}`);
  try {
    for (const addrs of Object.values(os.networkInterfaces()))
      for (const a of addrs || [])
        if (a.family === 'IPv4' && !a.internal) console.log(`  Other devices:  http://${a.address}:${port}`);
  } catch {
    // Some Android setups (Termux) block this lookup. Read the IP from the Wi-Fi settings instead.
    console.log(`  Other devices:  http://<this device's Wi-Fi IP>:${port}`);
  }
  console.log('Press Ctrl+C to stop.');
  if (process.send) process.send({ type: 'ready' });
});
