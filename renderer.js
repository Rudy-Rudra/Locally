const $ = id => document.getElementById(id);
let s = { status: 'stopped', folder: '', recent: [], port: 8000, urls: [], qr: '', error: '' };

function render() {
  const on = s.status !== 'stopped', paused = s.status === 'paused';
  const sel = $('folder');
  sel.replaceChildren();
  const opts = s.recent.slice();
  if (s.folder && !opts.includes(s.folder)) opts.unshift(s.folder);
  if (!opts.length) sel.add(new Option('No folder chosen yet', ''));
  opts.forEach(p => sel.add(new Option(p, p)));
  sel.value = s.folder || '';
  if (document.activeElement !== $('port')) $('port').value = s.port;
  sel.disabled = $('browse').disabled = $('port').disabled = on;

  $('dot').className = 'dot ' + s.status;
  $('stext').textContent = paused ? 'Paused. Devices cannot watch right now.' : on ? 'Sharing on your network' : 'Not sharing';
  $('start').disabled = on;
  $('pause').disabled = !on;
  $('pause').textContent = paused ? 'Resume' : 'Pause';
  $('stop').disabled = !on;

  $('err').hidden = !s.error;
  $('err').textContent = s.error;
  $('card').hidden = !on;
  $('card').classList.toggle('dim', paused);
  if (on) {
    $('qr').src = s.qr;
    $('url').textContent = s.urls[0];
    $('more').textContent = s.urls.length > 1 ? 'Other addresses: ' + s.urls.slice(1).join(', ') : '';
    $('more').hidden = s.urls.length < 2;
  }
}

$('folder').onchange = () => { s.folder = $('folder').value; };
$('browse').onclick = async () => { s = await api.pick(); render(); };
$('start').onclick = async () => { s = await api.start({ folder: $('folder').value, port: $('port').value }); render(); };
$('pause').onclick = async () => { s = await (s.status === 'paused' ? api.resume() : api.pause()); render(); };
$('stop').onclick = async () => { s = await api.stop(); render(); };
$('copy').onclick = async () => { await api.copy(s.urls[0]); $('copy').textContent = 'Copied'; setTimeout(() => { $('copy').textContent = 'Copy link'; }, 1500); };
$('open').onclick = () => api.open(s.urls[0]);
api.onState(st => { s = st; render(); });
api.state().then(st => { s = st; render(); });
