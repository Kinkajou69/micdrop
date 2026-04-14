const socket = io();

// 1. Priming the Audio
const clickSound = new Audio('click.mp3');
clickSound.load(); // Forces the browser to start fetching the file immediately

const playClick = () => {
    // Some browsers need a kick to play audio
    clickSound.currentTime = 0;
    const playPromise = clickSound.play();
    
    if (playPromise !== undefined) {
        playPromise.catch(error => {
            console.warn("Click sound blocked or file not found:", error);
        });
    }
};

// 2. Event Delegation (The "Smart" way)
// This listens for clicks on the ENTIRE document and only triggers if a button is hit.
// This fixes the issue where 'Approve/Deny' buttons weren't making sound!
document.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;

    // Trigger Sound
    playClick();

    // Trigger Bouncy Animation
    btn.classList.remove('bouncy-active');
    void btn.offsetWidth; // Force reflow
    btn.classList.add('bouncy-active');
});

// State
let myRole = '';
let currentRoom = '';
let currentModeratorId = '';
let localStream = null;
let mediaRecorder = null;
let audioQueue = [];
let isPlaying = false;
let audioContext = null;

// DOM Elements
const views = {
    landing: document.getElementById('view-landing'),
    join: document.getElementById('view-join'),
    moderator: document.getElementById('view-moderator'),
    attendee: document.getElementById('view-attendee')
};

const statusText = document.getElementById('attendee-status-text');
const btnRaise = document.getElementById('btn-raise-hand');
const btnStop = document.getElementById('btn-stop-talking');
const audioGate = document.getElementById('audio-gate');
const unlockBtn = document.getElementById('btn-unlock-audio');
const navTrigger = document.getElementById('nav-trigger');
const sideNav = document.getElementById('side-nav');
const micStatusIndicator = document.getElementById('mic-status-pill');
const micStatusText = document.getElementById('mic-status-text');

// --- Navigation Helpers ---
function showView(viewName) {
    Object.values(views).forEach(el => el.classList.add('hidden'));
    views[viewName].classList.remove('hidden');
}

// --- Mic Status UI Update ---
function updateMicUI(status) {
    const indicator = document.getElementById('mic-status-indicator');
    indicator.classList.remove('mic-off', 'mic-on');
    if (status === 'on') {
        indicator.classList.add('mic-on');
        micStatusText.innerText = "MIC: ACTIVE 🎙️";
    } else {
        indicator.classList.add('mic-off');
        micStatusText.innerText = "MIC: DISCONNECTED";
    }
}

// --- Audio Context Unlock ---
function unlockAudioContext() {
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioContext.state === 'suspended') {
        audioContext.resume();
    }
}

if (unlockBtn) {
    unlockBtn.onclick = () => {
        playClick();
        unlockAudioContext();
        if (audioGate) audioGate.classList.add('hidden');
    };
}

// --- Mic Warm-Up ---
async function warmUpAudio() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        localStream = stream;
        console.log("Mic access granted ✅");
        updateMicUI('on');
        return true;
    } catch (err) {
        console.error("Mic access denied:", err);
        updateMicUI('off');
        alert("Microphone access is required.");
        return false;
    }
}

// --- Button Listeners ---
document.getElementById('btn-start').onclick = async () => {
    unlockAudioContext();
    const ready = await warmUpAudio();
    if (ready) socket.emit('create_room');
};

document.getElementById('btn-join').onclick = () => showView('join');
document.getElementById('btn-back').onclick = () => showView('landing');

document.getElementById('btn-enter').onclick = async () => {
    const name = document.getElementById('input-name').value.trim();
    const code = document.getElementById('input-code').value.toUpperCase().trim();
    if (name && code) {
        unlockAudioContext();
        const ready = await warmUpAudio();
        if (ready) socket.emit('join_room', { code, name });
    } else {
        alert("Please fill in both fields.");
    }
};

// Hamburger Toggle
navTrigger.onclick = () => sideNav.classList.toggle('active');

// --- Socket Events: General ---
socket.on('room_created', (code) => {
    unlockAudioContext();
    myRole = 'moderator';
    currentRoom = code;
    currentModeratorId = socket.id;
    document.getElementById('room-display').innerText = code;
    document.getElementById('role-display').innerText = 'HOST';
    document.getElementById('status-bar').classList.remove('hidden');
    showView('moderator');
});

socket.on('error_msg', (msg) => {
    alert(msg);
    location.reload();
});

socket.on('joined_success', (data) => {
    myRole = 'attendee';
    currentRoom = data.code;
    currentModeratorId = data.moderatorId;
    document.getElementById('room-display').innerText = data.code;
    document.getElementById('role-display').innerText = data.name;
    document.getElementById('status-bar').classList.remove('hidden');
    showView('attendee');
});

// --- Moderator UI: Update Attendees ---
socket.on('update_attendees', (attendees) => {
    if (myRole !== 'moderator') return;
    const list = document.getElementById('attendee-list');
    list.innerHTML = '';
    attendees.sort((a, b) => (b.handRaised === true) - (a.handRaised === true));
    attendees.forEach(att => {
        const div = document.createElement('div');
        div.className = `attendee-item ${att.handRaised ? 'hand-raised' : ''}`;
        let controls = att.handRaised
            ? `<div class="mod-controls">
                <button class="primary-btn" onclick="approveSpeaker('${att.id}')">✅ Speak</button>
                <button class="danger-btn" onclick="rejectSpeaker('${att.id}')">❌ Deny</button>
               </div>`
            : `<span style="font-size:0.8rem; opacity:0.6; margin-right:10px">Listening</span>`;
        div.innerHTML = `<span>${att.name}</span>${controls}`;
        list.appendChild(div);
    });
});

window.approveSpeaker = (id) => {
    audioQueue = [];
    isPlaying = false;
    socket.emit('moderator_action', { action: 'approve', targetId: id, code: currentRoom });
};

window.rejectSpeaker = (id) => {
    socket.emit('moderator_action', { action: 'reject', targetId: id, code: currentRoom });
};

// --- PCM Audio Streaming Logic (Restored) ---

let chunksSent = 0;
let chunksReceived = 0;

socket.on('mic_approved', async (data) => {
    if (mediaRecorder) return;
    if (data.moderatorId) currentModeratorId = data.moderatorId;
    console.log('[MicDrop] mic_approved — streaming to moderator:', currentModeratorId);
    statusText.innerText = "You are LIVE! 🎙️";
    btnStop.classList.remove('hidden');

    try {
        if (!localStream || !localStream.active) {
            localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        }
        const senderContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
        console.log('[MicDrop] senderContext sample rate:', senderContext.sampleRate);
        const source = senderContext.createMediaStreamSource(localStream);
        const processor = senderContext.createScriptProcessor(4096, 1, 1);

        source.connect(processor);
        processor.connect(senderContext.destination);

        processor.onaudioprocess = (e) => {
            const float32 = e.inputBuffer.getChannelData(0);
            const int16 = new Int16Array(float32.length);
            for (let i = 0; i < float32.length; i++) {
                int16[i] = Math.max(-32768, Math.min(32767, float32[i] * 32768));
            }
            chunksSent++;
            if (chunksSent <= 3 || chunksSent % 50 === 0) {
                console.log('[MicDrop] sending chunk #' + chunksSent, 'samples:', int16.length, 'to:', currentModeratorId);
            }
            socket.emit('audio_chunk', {
                targetId: currentModeratorId,
                buffer: int16.buffer
            });
        };
        mediaRecorder = {
            stop: () => { processor.disconnect(); source.disconnect(); senderContext.close(); }
        };
    } catch (err) {
        console.error("Streaming error:", err);
        alert("Could not start audio stream.");
        stopStreaming();
    }
});

socket.on('audio_chunk', async (data) => {
    if (myRole !== 'moderator') return;
    chunksReceived++;
    if (chunksReceived <= 3 || chunksReceived % 50 === 0) {
        console.log('[MicDrop] received chunk #' + chunksReceived, 'audioCtx state:', audioContext?.state, 'buffer type:', data.buffer?.constructor?.name, 'byteLength:', data.buffer?.byteLength);
    }
    if (!audioContext || audioContext.state === 'suspended') {
        console.warn('[MicDrop] AudioContext suspended — showing audio gate');
        if (audioGate) audioGate.classList.remove('hidden');
        return;
    }
    try {
        const int16 = new Int16Array(data.buffer);
        const audioBuffer = audioContext.createBuffer(1, int16.length, 16000);
        const channel = audioBuffer.getChannelData(0);
        for (let i = 0; i < int16.length; i++) { channel[i] = int16[i] / 32768; }
        audioQueue.push(audioBuffer);
        if (!isPlaying) playNextChunk();
    } catch (err) {
        console.error('[MicDrop] Error decoding audio chunk:', err, data);
    }
});

function playNextChunk() {
    if (audioQueue.length === 0) { isPlaying = false; return; }
    isPlaying = true;
    const buffer = audioQueue.shift();
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);
    source.onended = playNextChunk;
    source.start();
}

function stopStreaming() {
    if (mediaRecorder) { mediaRecorder.stop(); mediaRecorder = null; }
    audioQueue = [];
    isPlaying = false;
    socket.emit('lower_hand', currentRoom);
    btnStop.classList.add('hidden');
    btnRaise.classList.remove('hidden');
    statusText.innerText = "Ready to ask a question?";
}

socket.on('mic_stopped', () => stopStreaming());
socket.on('hand_rejected', () => {
    statusText.innerText = "Host declined. Try again later.";
    btnRaise.classList.remove('hidden');
    btnStop.classList.add('hidden');
});

// --- Attendee Controls ---
btnRaise.onclick = () => {
    socket.emit('raise_hand', currentRoom);
    statusText.innerText = "Hand raised! Waiting for host...";
    btnRaise.classList.add('hidden');
};

btnStop.onclick = () => {
    stopStreaming();
};