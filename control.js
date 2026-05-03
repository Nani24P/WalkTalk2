// WalkTalk v4.0 Arctic Signal — Command Board
const STRATEGIES = [
  { name: 'nostr',   urls: ['https://esm.sh/trystero/nostr',   'https://cdn.skypack.dev/trystero/nostr'] },
  { name: 'mqtt',    urls: ['https://esm.sh/trystero/mqtt',    'https://cdn.skypack.dev/trystero/mqtt'] },
  { name: 'torrent', urls: ['https://esm.sh/trystero/torrent', 'https://cdn.skypack.dev/trystero/torrent'] },
];
const NOSTR_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.snort.social', 'wss://relay.nostr.band'];
const APP_ID = 'walkie-ptt-v3';
const LOBBY_CODE = 'walkie-lobby-v1';
const SETTINGS_KEY = 'walktalk-v2-settings';
const ACTIVITY_KEY = 'walktalk-v2-activity';
const DEFAULT_SETTINGS = { deviceName: '', defaultChannel: 7, audioAlerts: true, vibration: true, autoJoin: false, tapLock: false, muted: false };
const ROOM_PRESETS = [['Home',7], ['Kitchen',8], ['Bedroom',9], ['Office',10], ['Garage',11], ['Upstairs',12]];
const QUICK_MESSAGES = ['Call me', 'Need help', 'Open the door', 'All good'];

let settings = loadSettings();
let peerMap = {};
let lobbyRoom = null;
let sendPresence = null;
let sendLobbyPing = null;
let sendLobbyStatus = null;
let sendLobbyEmergency = null;
let strategyName = 'offline';
let audioCtx = null;

const els = {
  subtitle: document.getElementById('board-subtitle'),
  toast: document.getElementById('board-toast'),
  device: document.getElementById('board-device'),
  room: document.getElementById('board-room'),
  peers: document.getElementById('board-peers'),
  mode: document.getElementById('board-mode'),
  rooms: document.getElementById('room-presets'),
  statusButtons: document.getElementById('board-status-buttons'),
  devices: document.getElementById('board-device-list'),
  deviceCount: document.getElementById('device-count-label'),
  activity: document.getElementById('activity-list'),
  pingAll: document.getElementById('ping-all-btn'),
  alertAll: document.getElementById('alert-all-btn'),
  showQr: document.getElementById('show-qr-btn'),
  clearInbox: document.getElementById('clear-inbox-btn'),
  exportInbox: document.getElementById('export-inbox-btn'),
  openTalk: document.getElementById('open-talk-link'),
  qrModal: document.getElementById('board-qr-modal'),
  qrImg: document.getElementById('board-qr-img'),
  qrLink: document.getElementById('board-qr-link'),
  closeQr: document.getElementById('close-board-qr-btn'),
  copyLink: document.getElementById('copy-board-link-btn'),
  copyLinkModal: document.getElementById('copy-board-link-btn-modal'),
  settingsCard: document.getElementById('board-settings-card'),
  deviceNameInput: document.getElementById('board-device-name-input'),
  defaultChannelSelect: document.getElementById('board-default-channel-select'),
  audioAlertsToggle: document.getElementById('board-audio-alerts-toggle'),
  vibrationToggle: document.getElementById('board-vibration-toggle'),
  autoJoinToggle: document.getElementById('board-auto-join-toggle'),
  tapLockToggle: document.getElementById('board-tap-lock-toggle'),
  saveSettings: document.getElementById('board-save-settings-btn'),
};

function loadSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}
function saveSettings() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }
function defaultDeviceName() {
  const ua = navigator.userAgent || '';
  if (/iPad/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/iPhone/i.test(ua)) return 'iPhone';
  return 'Device';
}
function displayName() { return (settings.deviceName || defaultDeviceName()).trim(); }
function currentCh() { return Math.max(1, Math.min(40, Number(settings.defaultChannel) || 7)); }
function prettyTime(ts) { return new Date(ts || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function escapeText(value) { return String(value || '').replace(/[&<>\"]/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[ch])); }
function shortPeer(peerId) { return peerId ? peerId.slice(0, 8) : 'local'; }
function peerName(peerId) { return peerMap[peerId] && peerMap[peerId].name ? peerMap[peerId].name : 'Device ' + shortPeer(peerId); }
function chLabel(ch) { return 'CH ' + String(ch).padStart(2, '0'); }

function joinLink() {
  const url = new URL('index.html', location.href);
  url.searchParams.set('ch', String(currentCh()));
  return url.toString();
}
function renderQr() {
  const link = joinLink();
  if (els.qrLink) els.qrLink.textContent = link;
  if (els.qrImg) els.qrImg.src = 'https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=12&data=' + encodeURIComponent(link);
}
function showQrModal() {
  renderQr();
  if (els.qrModal) els.qrModal.classList.remove('hidden');
}
function hideQrModal() {
  if (els.qrModal) els.qrModal.classList.add('hidden');
}

function recordActivity(item) {
  try {
    const current = JSON.parse(localStorage.getItem(ACTIVITY_KEY) || '[]');
    const list = Array.isArray(current) ? current : [];
    list.push({ type: item.type || 'event', from: item.from || displayName(), text: item.text || '', ts: item.ts || Date.now(), local: !!item.local });
    localStorage.setItem(ACTIVITY_KEY, JSON.stringify(list.slice(-120)));
  } catch {}
  renderActivity();
}
function loadActivity() {
  try {
    const saved = JSON.parse(localStorage.getItem(ACTIVITY_KEY) || '[]');
    return Array.isArray(saved) ? saved.slice(-80).reverse() : [];
  } catch { return []; }
}
function toast(msg) {
  els.toast.textContent = msg;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { els.toast.textContent = ''; }, 2200);
}
function vibrate(pattern) { if (settings.vibration && navigator.vibrate) navigator.vibrate(pattern); }
function unlockAudio() {
  if (!settings.audioAlerts || audioCtx) return;
  try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch {}
}
function beep(kind = 'message') {
  if (!settings.audioAlerts) return;
  unlockAudio();
  if (!audioCtx) return;
  const table = { message: [720, 0.10, 0.10], ping: [1040, 0.22, 0.30], emergency: [520, 0.40, 0.22], error: [180, 0.12, 0.10] };
  const [freq, gain, dur] = table[kind] || table.message;
  const osc = audioCtx.createOscillator();
  const vol = audioCtx.createGain();
  osc.type = 'sine'; osc.frequency.value = freq;
  vol.gain.setValueAtTime(0.001, audioCtx.currentTime);
  vol.gain.exponentialRampToValueAtTime(gain, audioCtx.currentTime + 0.02);
  vol.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
  osc.connect(vol); vol.connect(audioCtx.destination); osc.start(); osc.stop(audioCtx.currentTime + dur + 0.03);
  if (kind === 'emergency') { setTimeout(() => beep('ping'), 160); setTimeout(() => beep('ping'), 320); }
}

document.addEventListener('pointerdown', unlockAudio, { once: true });
document.addEventListener('keydown', unlockAudio, { once: true });

async function loadStrategy() {
  for (const strat of STRATEGIES) {
    for (const url of strat.urls) {
      try {
        const mod = await import(url);
        strategyName = strat.name;
        return { joinRoom: mod.joinRoom, name: strat.name };
      } catch {}
    }
  }
  throw new Error('No signaling strategy available');
}
async function initLobby() {
  try {
    const strategy = await loadStrategy();
    const config = strategy.name === 'nostr' ? { appId: APP_ID, relayUrls: NOSTR_RELAYS } : { appId: APP_ID };
    lobbyRoom = strategy.joinRoom(config, LOBBY_CODE);
    const presencePair = lobbyRoom.makeAction('presence');
    sendPresence = presencePair[0];
    const getPresence = presencePair[1];
    const pingPair = lobbyRoom.makeAction('lobby-ping');
    sendLobbyPing = pingPair[0];
    const getLobbyPing = pingPair[1];
    const statusPair = lobbyRoom.makeAction('lobby-status');
    sendLobbyStatus = statusPair[0];
    const getLobbyStatus = statusPair[1];
    const emergencyPair = lobbyRoom.makeAction('lobby-emergency');
    sendLobbyEmergency = emergencyPair[0];
    const getLobbyEmergency = emergencyPair[1];

    lobbyRoom.onPeerJoin(peerId => {
      try { sendPresence(buildPresence(), peerId); } catch {}
      renderBoard();
    });
    lobbyRoom.onPeerLeave(peerId => {
      delete peerMap[peerId];
      renderBoard();
    });
    getPresence((data, peerId) => {
      peerMap[peerId] = { ...data, lastSeen: Date.now() };
      renderBoard();
    });
    getLobbyPing((data, peerId) => {
      const sender = data && data.name ? data.name : peerName(peerId);
      recordActivity({ type: 'ping', from: sender, text: 'Pinged this command board', ts: Date.now(), local: false });
      toast('Ping from ' + sender);
      beep('ping');
      vibrate([80, 50, 80]);
    });
    getLobbyStatus((data, peerId) => {
      const sender = data && data.name ? data.name : peerName(peerId);
      recordActivity({ type: 'status', from: sender, text: data && data.text ? data.text : '', ts: Date.now(), local: false });
      toast(sender + ': ' + (data && data.text ? data.text : 'Status'));
      beep('message');
    });
    getLobbyEmergency((data, peerId) => {
      const sender = data && data.name ? data.name : peerName(peerId);
      recordActivity({ type: 'alert', from: sender, text: data && data.text ? data.text : 'Emergency attention requested', ts: Date.now(), local: false });
      toast('ALERT from ' + sender);
      beep('emergency');
      vibrate([150,100,150,100,250]);
    });
    setInterval(() => { try { sendPresence(buildPresence()); } catch {} }, 3500);
    try { sendPresence(buildPresence()); } catch {}
    renderBoard();
    toast('Board online via ' + strategyName);
  } catch {
    els.subtitle.textContent = displayName() + ' · ' + chLabel(currentCh()) + ' · Offline board';
    toast('Board offline');
  }
}
function buildPresence() {
  return { ch: currentCh(), status: 'control', name: displayName(), speaking: false, lastSeen: Date.now() };
}

function populateChannelSelect() {
  if (!els.defaultChannelSelect || els.defaultChannelSelect.options.length) return;
  for (let i = 1; i <= 40; i++) {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = chLabel(i);
    els.defaultChannelSelect.appendChild(opt);
  }
}
function applySettingsToBoard() {
  populateChannelSelect();
  if (els.deviceNameInput) els.deviceNameInput.value = settings.deviceName || '';
  if (els.defaultChannelSelect) els.defaultChannelSelect.value = String(currentCh());
  if (els.audioAlertsToggle) els.audioAlertsToggle.checked = !!settings.audioAlerts;
  if (els.vibrationToggle) els.vibrationToggle.checked = !!settings.vibration;
  if (els.autoJoinToggle) els.autoJoinToggle.checked = !!settings.autoJoin;
  if (els.tapLockToggle) els.tapLockToggle.checked = !!settings.tapLock;
}
function saveBoardSettings() {
  settings.deviceName = (els.deviceNameInput?.value || '').trim();
  settings.defaultChannel = Number(els.defaultChannelSelect?.value || settings.defaultChannel || 7);
  settings.audioAlerts = !!els.audioAlertsToggle?.checked;
  settings.vibration = !!els.vibrationToggle?.checked;
  settings.autoJoin = !!els.autoJoinToggle?.checked;
  settings.tapLock = !!els.tapLockToggle?.checked;
  saveSettings();
  try { if (sendPresence) sendPresence(buildPresence()); } catch {}
  renderBoard();
  toast('Settings saved');
}
function focusSettingsFromHash() {
  if (location.hash === '#settings' && els.settingsCard) {
    setTimeout(() => els.settingsCard.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
  }
}

function renderRooms() {
  els.rooms.innerHTML = ROOM_PRESETS.map(([name, ch]) => {
    const selected = ch === currentCh() ? ' selected' : '';
    return `<button class="board-btn room-btn${selected}" data-ch="${ch}">${escapeText(name)}<br>${chLabel(ch)}</button>`;
  }).join('');
  els.rooms.querySelectorAll('.room-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      settings.defaultChannel = Number(btn.dataset.ch);
      saveSettings();
      try { if (sendPresence) sendPresence(buildPresence()); } catch {}
      renderBoard();
      toast('Default room set to ' + chLabel(currentCh()));
    });
  });
}
function renderQuickMessages() {
  els.statusButtons.innerHTML = QUICK_MESSAGES.map(msg => `<button class="board-btn status-board-btn" data-status="${escapeText(msg)}">${escapeText(msg)}</button>`).join('');
  els.statusButtons.querySelectorAll('.status-board-btn').forEach(btn => btn.addEventListener('click', () => sendStatus(btn.dataset.status)));
}
function renderDevices() {
  const peers = Object.entries(peerMap).sort((a,b) => (b[1].lastSeen || 0) - (a[1].lastSeen || 0));
  els.deviceCount.textContent = String(peers.length);
  if (!peers.length) {
    els.devices.innerHTML = '<div class="empty-state board-empty">No devices seen yet. Open WalkTalk on another device.</div>';
    return;
  }
  els.devices.innerHTML = peers.map(([id, peer]) => {
    const same = Number(peer.ch) === currentCh();
    const meta = chLabel(peer.ch || '--') + ' · ' + (peer.status || 'online').toUpperCase() + (same ? ' · SAME ROOM' : '');
    return `<div class="device-row control-device"><div class="device-main"><div class="device-name">${escapeText(peer.name || peerName(id))}</div><div class="device-meta">${escapeText(meta)}</div></div><div class="device-actions"><button class="mini-btn board-ping-peer" data-peer="${escapeText(id)}">PING</button></div></div>`;
  }).join('');
  els.devices.querySelectorAll('.board-ping-peer').forEach(btn => btn.addEventListener('click', () => pingPeer(btn.dataset.peer)));
}
function renderActivity() {
  const activity = loadActivity();
  if (!activity.length) {
    els.activity.innerHTML = '<div class="empty-state board-empty">No activity yet. Pings, alerts, and messages will appear here.</div>';
    return;
  }
  els.activity.innerHTML = activity.map(item => {
    const who = item.local ? 'You' : (item.from || 'Device');
    return `<div class="activity-row"><div class="activity-head"><span>${escapeText(item.type || 'event')} · ${escapeText(who)}</span><span>${prettyTime(item.ts)}</span></div><div class="activity-text">${escapeText(item.text || '')}</div></div>`;
  }).join('');
}
function renderBoard() {
  settings = loadSettings();
  els.device.textContent = displayName().toUpperCase();
  els.room.textContent = chLabel(currentCh());
  els.peers.textContent = String(Object.keys(peerMap).length);
  els.mode.textContent = strategyName === 'offline' ? 'OFFLINE' : 'ONLINE';
  els.subtitle.textContent = displayName() + ' · ' + chLabel(currentCh());
  els.openTalk.href = joinLink();
  renderQr();
  applySettingsToBoard();
  renderRooms();
  renderDevices();
  renderActivity();
}
function sendStatus(text) {
  const payload = { name: displayName(), text, ts: Date.now() };
  try { if (sendLobbyStatus) sendLobbyStatus(payload); } catch {}
  recordActivity({ type: 'status', from: displayName(), text, ts: Date.now(), local: true });
  toast('Sent: ' + text);
  beep('message');
}
function pingPeer(peerId) {
  const payload = { name: displayName(), ts: Date.now() };
  try { if (sendLobbyPing) sendLobbyPing(payload, peerId); } catch {}
  const name = peerName(peerId);
  recordActivity({ type: 'ping', from: displayName(), text: 'Ping sent to ' + name, ts: Date.now(), local: true });
  toast('Ping sent to ' + name);
  beep('ping');
}
function pingAll() {
  const payload = { name: displayName(), ts: Date.now() };
  try { if (sendLobbyPing) sendLobbyPing(payload); } catch {}
  recordActivity({ type: 'ping', from: displayName(), text: 'Ping sent to all seen devices', ts: Date.now(), local: true });
  toast('Ping all sent');
  beep('ping');
}
function alertAll() {
  const payload = { name: displayName(), text: 'Attention needed', ts: Date.now() };
  try { if (sendLobbyEmergency) sendLobbyEmergency(payload); } catch {}
  recordActivity({ type: 'alert', from: displayName(), text: 'Emergency alert sent to all devices', ts: Date.now(), local: true });
  toast('Emergency alert sent');
  beep('emergency');
  vibrate([120,80,120,80,180]);
}
async function copyJoinLink() {
  const link = joinLink();
  try {
    await navigator.clipboard.writeText(link);
    toast('Join link copied');
  } catch {
    if (els.qrLink) els.qrLink.textContent = link;
    toast('Copy failed · link shown below');
    showQrModal();
  }
}
function exportTextFile(filename, content) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 800);
}
function exportActivity() {
  const activity = loadActivity().slice().reverse();
  const lines = activity.map(item => {
    const who = item.local ? 'You' : (item.from || 'Device');
    const type = (item.type || 'event').toUpperCase();
    const stamp = new Date(item.ts || Date.now()).toLocaleString();
    return '[' + stamp + '] ' + type + ' · ' + who + ': ' + (item.text || '');
  });
  exportTextFile('walktalk-activity-' + new Date().toISOString().slice(0,10) + '.txt', lines.join('\n') || 'No activity.');
  toast('Activity exported');
}
function clearActivity() {
  if (!confirm('Clear Activity Inbox on this device?')) return;
  localStorage.setItem(ACTIVITY_KEY, '[]');
  renderActivity();
  toast('Inbox cleared');
}

els.pingAll?.addEventListener('click', pingAll);
els.alertAll?.addEventListener('click', alertAll);
els.showQr?.addEventListener('click', showQrModal);
els.closeQr?.addEventListener('click', hideQrModal);
els.qrModal?.addEventListener('click', (e) => { if (e.target === els.qrModal) hideQrModal(); });
els.clearInbox?.addEventListener('click', clearActivity);
els.exportInbox?.addEventListener('click', exportActivity);
els.copyLink?.addEventListener('click', copyJoinLink);
els.copyLinkModal?.addEventListener('click', copyJoinLink);
els.saveSettings?.addEventListener('click', saveBoardSettings);
window.addEventListener('hashchange', focusSettingsFromHash);
window.addEventListener('storage', renderActivity);
window.addEventListener('beforeunload', () => {
  try { if (sendPresence) sendPresence({ ...buildPresence(), status: 'idle' }); } catch {}
  try { if (lobbyRoom) lobbyRoom.leave(); } catch {}
});
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./service-worker.js').catch(() => {}));
}
renderQuickMessages();
renderBoard();
initLobby();
focusSettingsFromHash();
