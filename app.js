// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  WALKIE / WalkTalk v2 — app.js                                          ║
// ║  Same simple web-app architecture, upgraded with device names,          ║
// ║  dashboard, status messages, chat, pings, alerts, QR pairing, and PWA.  ║
// ╚══════════════════════════════════════════════════════════════════════════╝

// ── Trystero CDN strategies (tried in order, first to load wins) ──────────
const STRATEGIES = [
{ name: 'nostr',   urls: ['https://esm.sh/trystero/nostr',   'https://cdn.skypack.dev/trystero/nostr']   },
{ name: 'mqtt',    urls: ['https://esm.sh/trystero/mqtt',    'https://cdn.skypack.dev/trystero/mqtt']    },
{ name: 'torrent', urls: ['https://esm.sh/trystero/torrent', 'https://cdn.skypack.dev/trystero/torrent'] },
];

const NOSTR_RELAYS = [
'wss://relay.damus.io',
'wss://nos.lol',
'wss://relay.snort.social',
'wss://relay.nostr.band',
];

const APP_ID      = 'walkie-ptt-v3';
const LOBBY_CODE  = 'walkie-lobby-v1';
const TICK_W      = 28;
const TOTAL_CH    = 40;
const BASE_FREQ   = 462.5625;
const FREQ_STEP   = 0.025;
const SETTINGS_KEY = 'walktalk-v2-settings';
const CHAT_KEY     = 'walktalk-v2-chat';

const DEFAULT_SETTINGS = {
    deviceName: '',
    defaultChannel: 7,
    audioAlerts: true,
    vibration: true,
    autoJoin: false,
    tapLock: false,
};

// ── DOM references ────────────────────────────────────────────────────────
const pttBtn        = document.getElementById('ptt-button');
const pttLabel      = document.getElementById('ptt-label');
const pttModeBtn    = document.getElementById('ptt-mode-btn');
const emergencyBtn  = document.getElementById('emergency-btn');
const feedbackEl    = document.getElementById('feedback-display');
const peerIdDisplay = document.getElementById('peer-id-display');
const tunerPanel    = document.getElementById('tuner-panel');
const lockedBadge   = document.getElementById('locked-badge');
const lockedFreqEl  = document.getElementById('locked-freq');
const lockedChEl    = document.getElementById('locked-ch');
const squelchLed    = document.getElementById('squelch-led');
const tuneBtn       = document.getElementById('tune-btn');
const chDownBtn     = document.getElementById('ch-down');
const chUpBtn       = document.getElementById('ch-up');
const disconnectRow = document.getElementById('disconnect-row');
const disconnectBtn = document.getElementById('disconnect-btn');
const busyModal     = document.getElementById('busy-modal');
const modalCancel   = document.getElementById('modal-cancel');
const modalJoin     = document.getElementById('modal-join');
const countdownBar  = document.getElementById('countdown-bar');
const countdownFill = document.getElementById('countdown-fill');
const deviceChip    = document.getElementById('device-chip');
const settingsBtn   = document.getElementById('settings-btn');
const dashboardBtn  = document.getElementById('dashboard-btn');
const chatBtn       = document.getElementById('chat-btn');
const qrBtn         = document.getElementById('qr-btn');
const settingsPanel = document.getElementById('settings-panel');
const dashboardPanel= document.getElementById('dashboard-panel');
const chatPanel     = document.getElementById('chat-panel');
const qrPanel       = document.getElementById('qr-panel');
const deviceNameInput = document.getElementById('device-name-input');
const defaultChannelSelect = document.getElementById('default-channel-select');
const audioAlertsToggle = document.getElementById('audio-alerts-toggle');
const vibrationToggle = document.getElementById('vibration-toggle');
const autoJoinToggle = document.getElementById('auto-join-toggle');
const tapLockToggle = document.getElementById('tap-lock-toggle');
const saveSettingsBtn = document.getElementById('save-settings-btn');
const deviceList    = document.getElementById('device-list');
const dashboardSubtitle = document.getElementById('dashboard-subtitle');
const chatLog       = document.getElementById('chat-log');
const chatInput     = document.getElementById('chat-input');
const sendChatBtn   = document.getElementById('send-chat-btn');
const qrImg         = document.getElementById('qr-img');
const qrLink        = document.getElementById('qr-link');
const copyLinkBtn   = document.getElementById('copy-link-btn');
const attentionModal= document.getElementById('attention-modal');
const attentionMsg  = document.getElementById('attention-msg');
const dismissAttentionBtn = document.getElementById('dismiss-attention-btn');
const offlineBanner = document.getElementById('offline-banner');

// ── App state ─────────────────────────────────────────────────────────────
let settings      = loadSettings();
let currentCh     = getInitialChannel();
let lobbyRoom     = null;
let channelRoom   = null;
let localStream   = null;
let sendPresence  = null;
let sendLobbyPing = null;
let sendLobbyStatus = null;
let sendLobbyEmergency = null;
let sendChat      = null;
let sendStatus    = null;
let sendPing      = null;
let sendEmergency = null;
let peerMap       = {}; // peerId → { ch, status, name, lastSeen, speaking }
let roomPeers     = new Set();
let countdownTimer = null;
let audioCtx      = null;
let tapLocked     = false;
let chatMessages  = loadChat();
let lastKnownStrategy = null;
let myPresence = buildPresence('idle');

// ── Settings / storage ────────────────────────────────────────────────────
function loadSettings() {
    try {
        const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
        return { ...DEFAULT_SETTINGS, ...saved };
    } catch (e) {
        return { ...DEFAULT_SETTINGS };
    }
}

function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function loadChat() {
    try {
        const saved = JSON.parse(localStorage.getItem(CHAT_KEY) || '[]');
        return Array.isArray(saved) ? saved.slice(-80) : [];
    } catch (e) {
        return [];
    }
}

function saveChat() {
    localStorage.setItem(CHAT_KEY, JSON.stringify(chatMessages.slice(-80)));
}

function defaultDeviceName() {
    const ua = navigator.userAgent || '';
    if (/iPad/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'iPad';
    if (/iPhone/i.test(ua)) return 'iPhone';
    return 'Device';
}

function displayName() {
    return (settings.deviceName || defaultDeviceName()).trim();
}

function getInitialChannel() {
    const params = new URLSearchParams(location.search);
    const paramCh = Number(params.get('ch'));
    if (Number.isFinite(paramCh) && paramCh >= 1 && paramCh <= TOTAL_CH) return Math.round(paramCh);
    return Math.max(1, Math.min(TOTAL_CH, Number(settings.defaultChannel) || 7));
}

function buildPresence(status) {
    return {
        ch: currentCh,
        status,
        name: displayName(),
        speaking: document.body.classList.contains('state-tx'),
        lastSeen: Date.now(),
    };
}

function applySettingsToUi() {
    deviceChip.textContent = displayName().toUpperCase();
    deviceNameInput.value = settings.deviceName || '';
    defaultChannelSelect.value = String(settings.defaultChannel || currentCh);
    audioAlertsToggle.checked = !!settings.audioAlerts;
    vibrationToggle.checked = !!settings.vibration;
    autoJoinToggle.checked = !!settings.autoJoin;
    tapLockToggle.checked = !!settings.tapLock;
    pttModeBtn.textContent = settings.tapLock ? 'MODE: TAP LOCK' : 'MODE: HOLD';
    pttLabel.textContent = tapLocked ? 'TAP TO STOP' : (settings.tapLock ? 'TAP TO TALK' : 'PUSH TO TALK');
}

// ── Strategy loader ───────────────────────────────────────────────────────
async function loadStrategy() {
    if (lastKnownStrategy) return lastKnownStrategy;
    for (const strat of STRATEGIES) {
        for (const url of strat.urls) {
            try {
                log('Trying ' + strat.name + ' (' + url + ')…');
                const mod = await import(url);
                log(strat.name + ' loaded ✓', 'ok');
                lastKnownStrategy = { joinRoom: mod.joinRoom, name: strat.name };
                return lastKnownStrategy;
            } catch (e) {
                log(strat.name + ' failed: ' + (e.message || e), 'warn');
            }
        }
    }
    throw new Error('All signaling strategies failed');
}

// ── Helpers ───────────────────────────────────────────────────────────────
function freqForCh(ch) {
    return (BASE_FREQ + (ch - 1) * FREQ_STEP).toFixed(4);
}
function roomCodeForCh(ch) {
    return 'walkie-frs-ch' + String(ch).padStart(2, '0');
}
function chLabel(ch) {
    return 'CHANNEL ' + String(ch).padStart(2, '0');
}
function setState(name) {
    document.body.className = 'state-' + name;
    log('State → ' + name);
}
function feedback(msg) {
    feedbackEl.textContent = msg;
}
function vibrate(pattern) {
    if (settings.vibration && navigator.vibrate) navigator.vibrate(pattern);
}
function shortPeer(peerId) {
    return peerId ? peerId.slice(0, 8) : 'local';
}
function escapeText(value) {
    return String(value || '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}
function prettyTime(ts) {
    return new Date(ts || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ── Audio alerts ──────────────────────────────────────────────────────────
function unlockAudio() {
    if (!audioCtx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (Ctx) audioCtx = new Ctx();
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
}

function beep(kind) {
    if (!settings.audioAlerts) return;
    unlockAudio();
    if (!audioCtx) return;

    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    const map = {
        txStart: [620, 0.08, 0.05],
        txEnd: [330, 0.07, 0.04],
        ping: [880, 0.12, 0.07],
        emergency: [420, 0.35, 0.12],
        message: [520, 0.08, 0.04],
        error: [180, 0.16, 0.06],
    };
    const [freq, duration, volume] = map[kind] || map.message;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(volume, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + duration + 0.02);

    if (kind === 'emergency') {
        setTimeout(() => beep('ping'), 180);
        setTimeout(() => beep('ping'), 360);
    }
}

document.addEventListener('pointerdown', unlockAudio, { once: true });
document.addEventListener('keydown', unlockAudio, { once: true });

// ── Lobby presence / app actions ──────────────────────────────────────────
function broadcastPresence(ch, status) {
    myPresence = buildPresence(status);
    myPresence.ch = ch;
    if (sendPresence) {
        try { sendPresence(myPresence); } catch (e) { /* lobby not ready */ }
    }
    renderDashboard();
}

function channelCount(ch) {
    return Object.values(peerMap).filter(p => p.ch === ch && p.status !== 'idle').length;
}
function channelBusyCount(ch) {
    return Object.values(peerMap).filter(p => p.ch === ch && (p.status === 'locked' || p.status === 'connected')).length;
}

function updateHeatMap() {
    document.querySelectorAll('.ch-tick').forEach((tick, i) => {
        const ch = i + 1;
        const total = channelCount(ch);
        const busy = channelBusyCount(ch);
        const badge = tick.querySelector('.tick-badge');
        tick.classList.remove('heat-low', 'heat-busy');
        if (busy >= 2) tick.classList.add('heat-busy');
        else if (total > 0) tick.classList.add('heat-low');
        if (total > 0) {
            badge.classList.remove('hidden');
            badge.classList.toggle('busy', busy >= 2);
            badge.textContent = busy >= 2 ? 'BUSY' : String(total);
        } else {
            badge.classList.add('hidden');
            badge.classList.remove('busy');
        }
    });
}

async function ensureLobby() {
    if (lobbyRoom) return true;
    let strategy;
    try {
        strategy = await loadStrategy();
    } catch (e) {
        log('Lobby unavailable: ' + e.message, 'warn');
        return false;
    }
    await initLobby(strategy);
    return !!lobbyRoom;
}

async function initLobby(strategy) {
    if (lobbyRoom) return;
    log('Joining lobby room…');
    const config = { appId: APP_ID };
    if (strategy.name === 'nostr') config.relayUrls = NOSTR_RELAYS;

    try {
        lobbyRoom = strategy.joinRoom(config, LOBBY_CODE);
    } catch (e) {
        log('Lobby join failed: ' + e.message, 'warn');
        return;
    }

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
        log('Lobby peer joined: ' + shortPeer(peerId), 'info');
        try { sendPresence(myPresence, peerId); } catch (e) {}
    });

    getPresence((data, peerId) => {
        peerMap[peerId] = { ...data, lastSeen: Date.now() };
        updateHeatMap();
        renderDashboard();
    });

    getLobbyPing((data, peerId) => {
        const sender = data && data.name ? data.name : peerName(peerId);
        addChatMessage({ type: 'ping', from: sender, text: 'Pinged this device', ts: Date.now(), local: false });
        feedback('PING FROM ' + sender.toUpperCase());
        beep('ping');
        vibrate([80, 50, 80]);
    });

    getLobbyStatus((data, peerId) => {
        const sender = data && data.name ? data.name : peerName(peerId);
        addChatMessage({ type: 'status', from: sender, text: data.text, ts: Date.now(), local: false });
        feedback(sender.toUpperCase() + ': ' + String(data.text || '').toUpperCase());
        beep('message');
    });

    getLobbyEmergency((data, peerId) => {
        const sender = data && data.name ? data.name : peerName(peerId);
        showAttention(sender, data && data.text ? data.text : 'Emergency attention requested');
    });

    lobbyRoom.onPeerLeave(peerId => {
        log('Lobby peer left: ' + shortPeer(peerId), 'info');
        delete peerMap[peerId];
        updateHeatMap();
        renderDashboard();
    });

    log('Lobby ready ✓', 'ok');
    broadcastPresence(currentCh, 'idle');
}

function peerName(peerId) {
    const peer = peerMap[peerId];
    return peer && peer.name ? peer.name : 'Device ' + shortPeer(peerId);
}

// ── Microphone ────────────────────────────────────────────────────────────
async function setupMedia() {
    log('Requesting microphone…');
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 }
        });
        localStream.getAudioTracks()[0].enabled = false;
        pttBtn.disabled = false;
        feedback('SCANNING…');
        log('Microphone granted ✓', 'ok');
    } catch (e) {
        log('Mic denied: ' + e.name + ' — ' + e.message, 'error');
        feedback('MIC DENIED');
        beep('error');
    }
}

function playStream(stream) {
    let audio = document.getElementById('remote-audio');
    if (!audio) {
        audio = document.createElement('audio');
        audio.id = 'remote-audio';
        audio.autoplay = true;
        audio.setAttribute('playsinline', '');
        document.body.appendChild(audio);
    }
    audio.srcObject = stream;
    audio.play().catch(e => log('Audio play: ' + e.message, 'warn'));
    log('Remote audio playing ✓', 'ok');
}

// ── Countdown / disconnect ────────────────────────────────────────────────
function startCountdown(onComplete) {
    let remaining = 3;
    countdownBar.classList.remove('hidden');
    countdownFill.style.transition = 'none';
    countdownFill.style.width = '100%';
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            countdownFill.style.transition = 'width ' + remaining + 's linear';
            countdownFill.style.width = '0%';
        });
    });
    function tick() {
        remaining--;
        if (remaining <= 0) {
            countdownBar.classList.add('hidden');
            onComplete();
        } else {
            feedback('RETURNING IN ' + remaining + '...');
            countdownTimer = setTimeout(tick, 1000);
        }
    }
    feedback('RETURNING IN ' + remaining + '...');
    countdownTimer = setTimeout(tick, 1000);
}

function clearCountdown() {
    if (countdownTimer) { clearTimeout(countdownTimer); countdownTimer = null; }
    countdownBar.classList.add('hidden');
}

function disconnect(reason) {
    reason = reason || 'USER';
    log('Disconnecting (' + reason + ')…', 'warn');
    clearCountdown();
    stopTX(true);

    if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
    }
    if (channelRoom) {
        try { channelRoom.leave(); } catch (e) {}
        channelRoom = null;
    }

    roomPeers.clear();
    sendChat = sendStatus = sendPing = sendEmergency = null;
    const audio = document.getElementById('remote-audio');
    if (audio) audio.srcObject = null;

    pttBtn.disabled = true;
    squelchLed.classList.remove('open');
    lockedBadge.classList.add('hidden', 'scanning');
    disconnectRow.classList.add('hidden');
    tunerPanel.classList.remove('hidden');
    tuneBtn.disabled = false;
    chDownBtn.disabled = false;
    chUpBtn.disabled = false;
    feedback('STANDBY');
    setState('idle');
    broadcastPresence(currentCh, 'idle');
    renderDashboard();
    log('Disconnected — tuner restored ✓', 'ok');
}

disconnectBtn.addEventListener('click', () => disconnect('USER'));

// ── Channel room ──────────────────────────────────────────────────────────
async function enterRoom(code) {
    log('Loading signaling library…');
    let strategy;
    try {
        strategy = await loadStrategy();
    } catch (e) {
        log('No strategy available: ' + e.message, 'error');
        feedback('NETWORK BLOCKED');
        disconnect('LOAD_FAIL');
        return;
    }

    if (!lobbyRoom) initLobby(strategy).catch(e => log('Lobby error: ' + e.message, 'warn'));

    const config = { appId: APP_ID };
    if (strategy.name === 'nostr') config.relayUrls = NOSTR_RELAYS;

    log('Joining channel room "' + code + '"...');
    try {
        channelRoom = strategy.joinRoom(config, code);
    } catch (e) {
        log('joinRoom failed: ' + e.message, 'error');
        feedback('JOIN FAILED');
        disconnect('JOIN_FAIL');
        return;
    }

    setupChannelActions();

    channelRoom.onPeerJoin(peerId => {
        roomPeers.add(peerId);
        log('Peer joined ✓ ' + shortPeer(peerId), 'ok');
        feedback('PEER CONNECTED');
        lockedChEl.textContent = chLabel(currentCh) + ' · LIVE';
        lockedBadge.classList.remove('scanning');
        squelchLed.classList.add('open');
        setState('connected');
        broadcastPresence(currentCh, 'connected');
        beep('message');

        if (localStream) {
            try { channelRoom.addStream(localStream, peerId); log('Stream sent ✓', 'ok'); }
            catch (e) { log('addStream: ' + e.message, 'warn'); }
        }
        renderDashboard();
    });

    channelRoom.onPeerLeave(peerId => {
        roomPeers.delete(peerId);
        log('Peer left: ' + shortPeer(peerId), 'warn');
        pttBtn.disabled = true;
        squelchLed.classList.remove('open');
        lockedBadge.classList.add('scanning');
        lockedChEl.textContent = chLabel(currentCh) + ' · DISCONNECTED';
        setState('connected');
        broadcastPresence(currentCh, 'locked');
        feedback('PEER DISCONNECTED');
        beep('error');
        renderDashboard();
        startCountdown(() => disconnect('PEER_LEFT'));
    });

    channelRoom.onPeerStream((stream, peerId) => {
        log('Stream received from ' + shortPeer(peerId) + ' ✓', 'ok');
        playStream(stream);
    });

    log('Channel room joined — setting up mic...');
    await setupMedia();

    if (channelRoom.getPeers) {
        const existing = channelRoom.getPeers();
        if (existing && existing.length > 0) {
            existing.forEach(pid => roomPeers.add(pid));
            log('Sending stream to ' + existing.length + ' existing peer(s)', 'ok');
            existing.forEach(pid => {
                if (!localStream) return;
                try { channelRoom.addStream(localStream, pid); } catch (e) { log('existing addStream: ' + e.message, 'warn'); }
            });
            lockedChEl.textContent = chLabel(currentCh) + ' · LIVE';
            lockedBadge.classList.remove('scanning');
            squelchLed.classList.add('open');
        }
    }
    renderDashboard();
}

function setupChannelActions() {
    const chatPair = channelRoom.makeAction('chat');
    sendChat = chatPair[0];
    const getChat = chatPair[1];

    const statusPair = channelRoom.makeAction('status');
    sendStatus = statusPair[0];
    const getStatus = statusPair[1];

    const pingPair = channelRoom.makeAction('ping');
    sendPing = pingPair[0];
    const getPing = pingPair[1];

    const emergencyPair = channelRoom.makeAction('emergency');
    sendEmergency = emergencyPair[0];
    const getEmergency = emergencyPair[1];

    getChat((data, peerId) => {
        const sender = data && data.name ? data.name : peerName(peerId);
        addChatMessage({ type: 'chat', from: sender, text: data.text, ts: Date.now(), local: false });
        feedback('MESSAGE FROM ' + sender.toUpperCase());
        beep('message');
    });

    getStatus((data, peerId) => {
        const sender = data && data.name ? data.name : peerName(peerId);
        addChatMessage({ type: 'status', from: sender, text: data.text, ts: Date.now(), local: false });
        feedback(sender.toUpperCase() + ': ' + String(data.text || '').toUpperCase());
        beep('message');
    });

    getPing((data, peerId) => {
        const sender = data && data.name ? data.name : peerName(peerId);
        addChatMessage({ type: 'ping', from: sender, text: 'Pinged this room', ts: Date.now(), local: false });
        feedback('PING FROM ' + sender.toUpperCase());
        beep('ping');
        vibrate([80, 50, 80]);
    });

    getEmergency((data, peerId) => {
        const sender = data && data.name ? data.name : peerName(peerId);
        showAttention(sender, data && data.text ? data.text : 'Emergency attention requested');
    });
}

// ── Tune In ───────────────────────────────────────────────────────────────
function showBusyModal(ch, onJoinAnyway) {
    document.getElementById('modal-ch-num').textContent = String(ch).padStart(2, '0');
    busyModal.classList.remove('hidden');

    function cleanup() {
        busyModal.classList.add('hidden');
        modalCancel.removeEventListener('click', onCancel);
        modalJoin.removeEventListener('click', onJoin);
    }
    function onCancel() {
        cleanup();
        tuneBtn.disabled = false;
        chDownBtn.disabled = false;
        chUpBtn.disabled = false;
        tunerPanel.classList.remove('hidden');
        lockedBadge.classList.add('hidden');
        disconnectRow.classList.add('hidden');
    }
    function onJoin() {
        cleanup();
        onJoinAnyway();
    }

    modalCancel.addEventListener('click', onCancel);
    modalJoin.addEventListener('click', onJoin);
}

async function tuneIn() {
    const ch = currentCh;
    const freq = freqForCh(ch);
    const code = roomCodeForCh(ch);

    tuneBtn.disabled = true;
    chDownBtn.disabled = true;
    chUpBtn.disabled = true;
    tunerPanel.classList.add('hidden');
    lockedBadge.classList.remove('hidden');
    lockedBadge.classList.add('scanning');
    lockedFreqEl.textContent = freq + ' MHz';
    lockedChEl.textContent = chLabel(ch) + ' · SCANNING...';
    disconnectRow.classList.remove('hidden');

    const busyCount = channelBusyCount(ch);
    if (busyCount >= 2) {
        showBusyModal(ch, () => proceedToJoin(ch, freq, code));
        return;
    }
    proceedToJoin(ch, freq, code);
}

async function proceedToJoin(ch, freq, code) {
    feedback('TUNING ' + freq + ' MHz…');
    setState('connected');
    broadcastPresence(ch, 'locked');
    localStorage.setItem('walktalk-v2-last-channel', String(ch));
    await enterRoom(code);
}

tuneBtn.addEventListener('click', tuneIn);

// ── Frequency tuner UI ────────────────────────────────────────────────────
function updateTape(animate) {
    const tape = document.getElementById('freq-tape');
    const wrapper = document.getElementById('tape-wrapper');
    if (animate) tape.classList.add('animated');
    else tape.classList.remove('animated');

    const offset = wrapper.offsetWidth / 2 - (currentCh - 0.5) * TICK_W;
    tape.style.transform = 'translateX(' + offset + 'px)';

    document.querySelectorAll('.ch-tick').forEach((tick, i) => {
        const d = Math.abs((i + 1) - currentCh);
        tick.classList.toggle('active', d === 0);
        tick.classList.toggle('near-one', d === 1);
        tick.classList.toggle('near-two', d === 2);
    });

    document.getElementById('tuner-ch').textContent = 'CH ' + String(currentCh).padStart(2, '0');
    document.getElementById('tuner-freq').textContent = freqForCh(currentCh);
    peerIdDisplay.textContent = String(currentCh).padStart(2, '0');
    updateQr();
}

function buildTape() {
    const tape = document.getElementById('freq-tape');
    tape.innerHTML = '';
    for (let ch = 1; ch <= TOTAL_CH; ch++) {
        const isMajor = (ch % 5 === 0 || ch === 1);
        const el = document.createElement('div');
        el.className = 'ch-tick' + (isMajor ? ' major' : '') + (ch === currentCh ? ' active' : '');
        el.innerHTML = '<div class="tick-badge hidden"></div>' +
            '<div class="tick-num">' + (isMajor ? String(ch).padStart(2, '0') : '') + '</div>' +
            '<div class="tick-bar"></div>';
        tape.appendChild(el);
    }
    updateTape(false);
}

function buildDefaultChannelOptions() {
    defaultChannelSelect.innerHTML = '';
    for (let ch = 1; ch <= TOTAL_CH; ch++) {
        const opt = document.createElement('option');
        opt.value = String(ch);
        opt.textContent = 'CH ' + String(ch).padStart(2, '0') + ' · ' + freqForCh(ch) + ' MHz';
        defaultChannelSelect.appendChild(opt);
    }
}

function setChannel(ch, animate = true) {
    currentCh = Math.max(1, Math.min(TOTAL_CH, ch));
    updateTape(animate);
    vibrate(8);
    broadcastPresence(currentCh, 'tuning');
}

(function initDrag() {
    const wrapper = document.getElementById('tape-wrapper');
    let dragging = false, startX = 0, startCh = currentCh, lastCh = currentCh;

    wrapper.addEventListener('pointerdown', e => {
        dragging = true; startX = e.clientX; startCh = currentCh; lastCh = currentCh;
        wrapper.setPointerCapture(e.pointerId);
        document.getElementById('freq-tape').classList.remove('animated');
    });
    wrapper.addEventListener('pointermove', e => {
        if (!dragging) return;
        const newCh = Math.max(1, Math.min(TOTAL_CH, startCh + Math.round((startX - e.clientX) / TICK_W)));
        if (newCh !== lastCh) {
            lastCh = newCh;
            currentCh = newCh;
            updateTape(false);
            broadcastPresence(currentCh, 'tuning');
            vibrate(6);
        }
    });
    wrapper.addEventListener('pointerup', () => { dragging = false; });
    wrapper.addEventListener('pointercancel', () => { dragging = false; });
})();

chDownBtn.addEventListener('click', () => setChannel(currentCh - 1));
chUpBtn.addEventListener('click', () => setChannel(currentCh + 1));

document.addEventListener('keydown', e => {
    if (tunerPanel.classList.contains('hidden')) return;
    if (e.key === 'ArrowLeft') { setChannel(currentCh - 1); e.preventDefault(); }
    if (e.key === 'ArrowRight') { setChannel(currentCh + 1); e.preventDefault(); }
});

// ── PTT ───────────────────────────────────────────────────────────────────
function updateSpeakingPresence(isSpeaking) {
    myPresence = buildPresence(isSpeaking ? 'connected' : (channelRoom ? 'connected' : 'idle'));
    myPresence.speaking = isSpeaking;
    if (sendPresence) {
        try { sendPresence(myPresence); } catch (e) {}
    }
}

function startTX() {
    if (!localStream || pttBtn.disabled) return;
    vibrate(50);
    localStream.getAudioTracks()[0].enabled = true;
    setState('tx');
    feedback('TRANSMITTING…');
    pttBtn.classList.add('tx-locked');
    pttLabel.textContent = settings.tapLock ? 'TAP TO STOP' : 'TRANSMITTING';
    updateSpeakingPresence(true);
    beep('txStart');
}
function stopTX(silent = false) {
    if (!localStream) return;
    localStream.getAudioTracks()[0].enabled = false;
    tapLocked = false;
    pttBtn.classList.remove('tx-locked');
    setState(channelRoom ? 'connected' : 'idle');
    feedback(channelRoom ? 'STANDBY' : 'STANDBY');
    pttLabel.textContent = settings.tapLock ? 'TAP TO TALK' : 'PUSH TO TALK';
    updateSpeakingPresence(false);
    if (!silent) beep('txEnd');
}
function toggleTapTx() {
    if (tapLocked) stopTX();
    else { tapLocked = true; startTX(); }
}

pttBtn.addEventListener('touchstart', e => {
    e.preventDefault();
    if (settings.tapLock) return;
    startTX();
}, { passive: false });
pttBtn.addEventListener('touchend', e => {
    e.preventDefault();
    if (settings.tapLock) return;
    stopTX();
}, { passive: false });
pttBtn.addEventListener('touchcancel', e => {
    e.preventDefault();
    if (settings.tapLock) return;
    stopTX();
}, { passive: false });
pttBtn.addEventListener('mousedown', () => { if (!settings.tapLock) startTX(); });
pttBtn.addEventListener('mouseup', () => { if (!settings.tapLock) stopTX(); });
pttBtn.addEventListener('mouseleave', () => { if (!settings.tapLock) stopTX(); });
pttBtn.addEventListener('click', () => { if (settings.tapLock) toggleTapTx(); });

pttModeBtn.addEventListener('click', () => {
    settings.tapLock = !settings.tapLock;
    tapLockToggle.checked = settings.tapLock;
    saveSettings();
    stopTX(true);
    applySettingsToUi();
});

document.addEventListener('keydown', e => {
    const isLockedIn = tunerPanel.classList.contains('hidden');
    if (e.code === 'Space' && !e.repeat && isLockedIn) {
        e.preventDefault();
        if (settings.tapLock) toggleTapTx();
        else startTX();
    }
});
document.addEventListener('keyup', e => {
    if (e.code === 'Space' && !settings.tapLock) stopTX();
});

// ── Panels / dashboard ────────────────────────────────────────────────────
function openPanel(panel) {
    panel.classList.remove('hidden');
    if (panel === dashboardPanel) renderDashboard();
    if (panel === chatPanel) renderChat();
    if (panel === qrPanel) updateQr();
}
function closePanel(panel) {
    panel.classList.add('hidden');
}

document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', () => closePanel(document.getElementById(btn.dataset.close)));
});
settingsBtn.addEventListener('click', () => openPanel(settingsPanel));
deviceChip.addEventListener('click', () => openPanel(settingsPanel));
dashboardBtn.addEventListener('click', () => { ensureLobby(); openPanel(dashboardPanel); });
chatBtn.addEventListener('click', () => openPanel(chatPanel));
qrBtn.addEventListener('click', () => openPanel(qrPanel));

function renderDashboard() {
    if (!deviceList) return;
    const selfStatus = channelRoom ? (document.body.classList.contains('state-tx') ? 'speaking' : 'connected') : 'local';
    const rows = [{ id: 'me', name: displayName() + ' (You)', ch: currentCh, status: selfStatus, speaking: document.body.classList.contains('state-tx'), local: true }];
    Object.entries(peerMap).forEach(([id, peer]) => rows.push({ id, ...peer, local: false }));

    dashboardSubtitle.textContent = 'CH ' + String(currentCh).padStart(2, '0') + ' · ' + rows.length + ' device(s) seen';
    deviceList.innerHTML = rows.map(peer => {
        const inRoom = peer.ch === currentCh;
        const canPing = !peer.local;
        const state = peer.speaking ? 'SPEAKING' : String(peer.status || 'online').toUpperCase();
        return '<div class="device-row">' +
            '<div class="device-main">' +
                '<div class="device-name">' + escapeText(peer.name || ('Device ' + shortPeer(peer.id))) + '</div>' +
                '<div class="device-meta">CH ' + String(peer.ch || '--').padStart(2, '0') + ' · ' + state + (inRoom ? ' · SAME ROOM' : '') + '</div>' +
            '</div>' +
            '<button class="mini-btn ping-peer-btn" data-peer="' + escapeText(peer.id) + '" ' + (canPing ? '' : 'disabled') + '>PING</button>' +
        '</div>';
    }).join('');

    deviceList.querySelectorAll('.ping-peer-btn').forEach(btn => {
        btn.addEventListener('click', () => sendPingToPeer(btn.dataset.peer));
    });
}

function sendPingToPeer(peerId) {
    const payload = { name: displayName(), ts: Date.now() };
    try {
        if (sendLobbyPing) sendLobbyPing(payload, peerId);
        else if (sendPing) sendPing(payload, peerId);
        addChatMessage({ type: 'ping', from: displayName(), text: 'Ping sent to ' + peerName(peerId), ts: Date.now(), local: true });
        feedback('PING SENT');
        beep('ping');
    } catch (e) {
        log('Ping failed: ' + e.message, 'warn');
        feedback('PING FAILED');
        beep('error');
    }
}

// ── Chat / status / alerts ────────────────────────────────────────────────
function addChatMessage(message) {
    chatMessages.push(message);
    chatMessages = chatMessages.slice(-80);
    saveChat();
    renderChat();
}

function renderChat() {
    if (!chatLog) return;
    if (chatMessages.length === 0) {
        chatLog.innerHTML = '<div class="empty-state">No messages yet. Send a status or chat after devices connect.</div>';
        return;
    }
    chatLog.innerHTML = chatMessages.map(msg => {
        const type = msg.type ? msg.type.toUpperCase() : 'CHAT';
        return '<div class="chat-message ' + (msg.local ? 'local' : '') + '">' +
            '<div class="chat-head"><span>' + escapeText(msg.from || 'Device') + '</span><span>' + type + ' · ' + prettyTime(msg.ts) + '</span></div>' +
            '<div class="chat-text">' + escapeText(msg.text || '') + '</div>' +
        '</div>';
    }).join('');
    chatLog.scrollTop = chatLog.scrollHeight;
}

function sendRoomChat() {
    const text = chatInput.value.trim();
    if (!text) return;
    const payload = { name: displayName(), text, ts: Date.now() };
    try {
        if (sendChat) sendChat(payload);
        else if (sendLobbyStatus) sendLobbyStatus(payload);
        addChatMessage({ type: 'chat', from: displayName(), text, ts: Date.now(), local: true });
        chatInput.value = '';
        feedback('MESSAGE SENT');
        beep('message');
    } catch (e) {
        log('Chat send failed: ' + e.message, 'warn');
        feedback('MESSAGE FAILED');
        beep('error');
    }
}

function sendQuickStatus(text) {
    const payload = { name: displayName(), text, ts: Date.now() };
    try {
        if (sendStatus) sendStatus(payload);
        if (sendLobbyStatus) sendLobbyStatus(payload);
        addChatMessage({ type: 'status', from: displayName(), text, ts: Date.now(), local: true });
        feedback('STATUS SENT: ' + text.toUpperCase());
        beep('message');
    } catch (e) {
        log('Status send failed: ' + e.message, 'warn');
        feedback('STATUS FAILED');
        beep('error');
    }
}

sendChatBtn.addEventListener('click', sendRoomChat);
chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') sendRoomChat();
});
document.querySelectorAll('.status-pill').forEach(btn => {
    btn.addEventListener('click', () => sendQuickStatus(btn.dataset.status));
});

function sendEmergencyAlert() {
    const payload = { name: displayName(), text: 'Attention needed', ts: Date.now() };
    let sent = false;
    try {
        if (sendEmergency) { sendEmergency(payload); sent = true; }
        if (sendLobbyEmergency) { sendLobbyEmergency(payload); sent = true; }
        addChatMessage({ type: 'alert', from: displayName(), text: 'Emergency alert sent', ts: Date.now(), local: true });
        feedback(sent ? 'ALERT SENT' : 'ALERT READY AFTER CONNECT');
        beep('emergency');
        vibrate([120, 80, 120, 80, 180]);
    } catch (e) {
        log('Emergency send failed: ' + e.message, 'warn');
        feedback('ALERT FAILED');
        beep('error');
    }
}

function showAttention(sender, text) {
    attentionMsg.textContent = sender + ': ' + text;
    attentionModal.classList.remove('hidden');
    addChatMessage({ type: 'alert', from: sender, text, ts: Date.now(), local: false });
    feedback('ATTENTION ALERT');
    beep('emergency');
    vibrate([150, 100, 150, 100, 250]);
}

emergencyBtn.addEventListener('click', sendEmergencyAlert);
dismissAttentionBtn.addEventListener('click', () => attentionModal.classList.add('hidden'));

// ── QR pairing ────────────────────────────────────────────────────────────
function joinLink() {
    const url = new URL(location.href);
    url.searchParams.set('ch', String(currentCh));
    return url.toString();
}

function updateQr() {
    if (!qrImg || !qrLink) return;
    const link = joinLink();
    qrLink.textContent = link;
    qrImg.src = 'https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=12&data=' + encodeURIComponent(link);
}

copyLinkBtn.addEventListener('click', async () => {
    const link = joinLink();
    try {
        await navigator.clipboard.writeText(link);
        copyLinkBtn.textContent = 'COPIED ✓';
        setTimeout(() => { copyLinkBtn.textContent = 'COPY JOIN LINK'; }, 1200);
    } catch (e) {
        qrLink.textContent = link;
    }
});

// ── Settings panel ────────────────────────────────────────────────────────
saveSettingsBtn.addEventListener('click', () => {
    settings.deviceName = deviceNameInput.value.trim();
    settings.defaultChannel = Number(defaultChannelSelect.value) || currentCh;
    settings.audioAlerts = !!audioAlertsToggle.checked;
    settings.vibration = !!vibrationToggle.checked;
    settings.autoJoin = !!autoJoinToggle.checked;
    settings.tapLock = !!tapLockToggle.checked;
    saveSettings();
    applySettingsToUi();
    broadcastPresence(currentCh, channelRoom ? 'connected' : 'idle');
    feedback('SETTINGS SAVED');
    closePanel(settingsPanel);
});

// ── Offline / PWA support ─────────────────────────────────────────────────
function updateOfflineBanner() {
    offlineBanner.classList.toggle('hidden', navigator.onLine);
}
window.addEventListener('online', updateOfflineBanner);
window.addEventListener('offline', updateOfflineBanner);

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./service-worker.js')
            .then(() => log('Service worker registered ✓', 'ok'))
            .catch(e => log('Service worker failed: ' + e.message, 'warn'));
    });
}

// ── Cleanup on page unload ────────────────────────────────────────────────
window.addEventListener('beforeunload', () => {
    broadcastPresence(null, 'idle');
    if (channelRoom) try { channelRoom.leave(); } catch (e) {}
    if (lobbyRoom) try { lobbyRoom.leave(); } catch (e) {}
    if (localStream) localStream.getTracks().forEach(t => t.stop());
});

// ── Init ──────────────────────────────────────────────────────────────────
buildDefaultChannelOptions();
buildTape();
applySettingsToUi();
renderChat();
renderDashboard();
updateOfflineBanner();
updateQr();
log('Tuner ready · ' + TOTAL_CH + ' channels ✓', 'ok');

// Join lobby shortly after load so dashboard/status/ping sees nearby devices.
setTimeout(() => ensureLobby().catch(e => log('Auto lobby failed: ' + e.message, 'warn')), 450);

if (settings.autoJoin) {
    setTimeout(() => tuneIn().catch(e => log('Auto-join failed: ' + e.message, 'warn')), 1200);
}
