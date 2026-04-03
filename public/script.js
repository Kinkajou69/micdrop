const socket = io();

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

// --- Navigation Helpers ---
function showView(viewName) {
    Object.values(views).forEach(el => el.classList.add('hidden'));
    views[viewName].classList.remove('hidden');
}

// --- Audio Context Unlock (handles mobile autoplay policy) ---
function unlockAudioContext() {
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioContext.state === 'suspended') {
        audioContext.resume();
    }
}

// Attach unlock to the gate button
if (unlockBtn) {
    unlockBtn.onclick = () => {
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
        return true;
    } catch (err) {
        console.error("Mic access denied:", err);
        alert("Microphone access is required. Please allow it in your browser settings.");
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

socket.on('joined_success', (data) => {
    myRole = 'attendee';
    currentRoom = data.code;
    currentModeratorId = data.moderatorId;
    document.getElementById('room-display').innerText = data.code;
    document.getElementById('role-display').innerText = data.name;
    document.getElementById('status-bar').classList.remove('hidden');
    showView('attendee');
});

socket.on('error_msg', (msg) => {
    alert(msg);
    location.reload();
});

// --- Moderator UI ---
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
    socket.emit('moderator_action', { action: 'approve', targetId: id, code: currentRoom });
};

window.rejectSpeaker = (id) => {
    socket.emit('moderator_action', { action: 'reject', targetId: id, code: currentRoom });
};

// --- Attendee UI ---
btnRaise.onclick = () => {
    socket.emit('raise_hand', currentRoom);
    statusText.innerText = "Hand raised! Waiting for host...";
    btnRaise.classList.add('hidden');
};

btnStop.onclick = () => {
    stopStreaming();
};

socket.on('hand_rejected', () => {
    statusText.innerText = "Host declined. Try again later.";
    btnRaise.classList.remove('hidden');
    btnStop.classList.add('hidden');
});

// --- MediaRecorder Audio Streaming (replaces WebRTC) ---

// ATTENDEE: Start streaming when approved
socket.on('mic_approved', async (data) => {
    if (data.moderatorId) currentModeratorId = data.moderatorId;
    statusText.innerText = "You are LIVE! 🎙️";
    btnStop.classList.remove('hidden');

    try {
        if (!localStream || !localStream.active) {
            localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        }

        // Pick a supported MIME type
        const senderContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
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
    socket.emit('audio_chunk', {
        targetId: currentModeratorId,
        buffer: int16.buffer,
        sampleRate: 16000
    });
};

mediaRecorder = { stop: () => { processor.disconnect(); source.disconnect(); senderContext.close(); } };
console.log("PCM streaming started ✅");

        // Fire every 250ms — low latency chunks
        mediaRecorder.start(250);
        console.log("MediaRecorder started ✅");

    } catch (err) {
        console.error("Streaming error:", err);
        alert("Could not start audio stream.");
        stopStreaming();
    }
});

// MODERATOR: Receive and play audio chunks
socket.on('audio_chunk', async (data) => {
    if (myRole !== 'moderator') return;
    if (!audioContext || audioContext.state === 'suspended') {
        if (audioGate) audioGate.classList.remove('hidden');
        return;
    }
    try {
        const int16 = new Int16Array(data.buffer);
        const audioBuffer = audioContext.createBuffer(1, int16.length, data.sampleRate);
        const channel = audioBuffer.getChannelData(0);
        for (let i = 0; i < int16.length; i++) {
            channel[i] = int16[i] / 32768;
        }
        audioQueue.push(audioBuffer);
        if (!isPlaying) playNextChunk();
    } catch (err) {
        console.warn("Could not decode audio chunk:", err);
    }
});

function playNextChunk() {
    if (audioQueue.length === 0) {
        isPlaying = false;
        return;
    }
    isPlaying = true;
    const buffer = audioQueue.shift();
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);
    source.onended = playNextChunk;
    source.start();
}

// --- Helpers ---

function getSupportedMimeType() {
    const types = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus',
        'audio/ogg',
        'audio/mp4',
    ];
    for (const type of types) {
        if (MediaRecorder.isTypeSupported(type)) return type;
    }
    return ''; // browser default
}

function stopStreaming() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
    }
    mediaRecorder = null;
    audioQueue = [];
    isPlaying = false;

    socket.emit('lower_hand', currentRoom);
    btnStop.classList.add('hidden');
    btnRaise.classList.remove('hidden');
    statusText.innerText = "Ready to ask a question?";
}

socket.on('mic_stopped', () => {
    stopStreaming();
    alert("Host stopped your audio.");
});