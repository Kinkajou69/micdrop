const socket = io();

// State
let myRole = '';
let currentRoom = '';
let currentModeratorId = ''; 
let myPeerConnection = null;
let localStream = null;

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

// --- MOBILE "WARM UP" FUNCTION ---
async function warmUpAudio() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        localStream = stream; 
        console.log("Hardware Unlocked 🎙️");
        return true;
    } catch (err) {
        console.error("Hardware Unlock Failed:", err);
        alert("Microphone access is REQUIRED. Please check settings.");
        return false;
    }
}

// --- Button Listeners ---

document.getElementById('btn-start').onclick = async () => {
    const ready = await warmUpAudio();
    if(ready) socket.emit('create_room');
};

document.getElementById('btn-join').onclick = () => showView('join');
document.getElementById('btn-back').onclick = () => showView('landing');

document.getElementById('btn-enter').onclick = async () => {
    const name = document.getElementById('input-name').value;
    const code = document.getElementById('input-code').value.toUpperCase();
    if(name && code) {
        const ready = await warmUpAudio();
        if(ready) socket.emit('join_room', { code, name });
    } else {
        alert("Please fill in both fields");
    }
};

// --- Socket Events: General ---

socket.on('room_created', (code) => {
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

// --- MODERATOR UI LOGIC ---

socket.on('update_attendees', (attendees) => {
    if(myRole !== 'moderator') return;
    const list = document.getElementById('attendee-list');
    list.innerHTML = '';
    attendees.sort((a, b) => (b.handRaised === true) - (a.handRaised === true));
    attendees.forEach(att => {
        const div = document.createElement('div');
        div.className = `attendee-item ${att.handRaised ? 'hand-raised' : ''}`;
        let controls = att.handRaised ? `
            <div class="mod-controls">
                <button class="primary-btn" onclick="approveSpeaker('${att.id}')">✅ Speak</button>
                <button class="danger-btn" onclick="rejectSpeaker('${att.id}')">❌ Deny</button>
            </div>
        ` : `<span style="font-size:0.8rem; opacity:0.6; margin-right:10px">Listening</span>`;
        div.innerHTML = `<span>${att.name}</span>${controls}`;
        list.appendChild(div);
    });
});

window.approveSpeaker = (id) => {
    if (myPeerConnection) {
        myPeerConnection.close();
        myPeerConnection = null;
    }
    socket.emit('moderator_action', { action: 'approve', targetId: id, code: currentRoom });
};

window.rejectSpeaker = (id) => {
    socket.emit('moderator_action', { action: 'reject', targetId: id, code: currentRoom });
};

// --- ATTENDEE UI LOGIC ---

btnRaise.onclick = () => {
    socket.emit('raise_hand', currentRoom);
    statusText.innerText = "Hand Raised! Waiting for host...";
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

// --- WebRTC LOGIC ---

const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        {
            urls: [
                'turn:openrelay.metered.ca:443?transport=tcp', 
                'turn:openrelay.metered.ca:443?transport=udp',
                'turn:openrelay.metered.ca:80?transport=tcp'
            ],
            username: 'openrelayproject',
            credential: 'openrelayproject'
        }
    ],
    iceTransportPolicy: 'relay', 
    iceCandidatePoolSize: 10 
};

function resetConnection() {
    if (myPeerConnection) {
        myPeerConnection.close();
        myPeerConnection = null;
    }
}

// 1. ATTENDEE: Approved
socket.on('mic_approved', async (data) => {
    if(data.moderatorId) currentModeratorId = data.moderatorId;
    statusText.innerText = "You are LIVE! 🎙️";
    btnStop.classList.remove('hidden');
    
    try {
        if (!localStream || !localStream.active) {
            localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        }
        myPeerConnection = new RTCPeerConnection(rtcConfig);
        localStream.getTracks().forEach(track => myPeerConnection.addTrack(track, localStream));

        myPeerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit('signal', {
                    target: currentModeratorId, 
                    type: 'candidate',
                    payload: event.candidate
                });
            }
        };

        const offer = await myPeerConnection.createOffer();
        await myPeerConnection.setLocalDescription(offer);
        socket.emit('signal', {
            target: currentModeratorId,
            type: 'offer',
            payload: offer
        });
    } catch (err) {
        console.error("WebRTC Error:", err);
        alert("Connection failed.");
        stopStreaming();
    }
});

// 2. MODERATOR: Incoming Call (Offer)
socket.on('signal', async (data) => {
    if(myRole === 'moderator' && data.type === 'offer') {
        if (myPeerConnection) myPeerConnection.close();
        myPeerConnection = new RTCPeerConnection(rtcConfig);
        
        myPeerConnection.ontrack = (event) => {
            const audioEl = document.getElementById('remote-audio');
            console.log("Track received! Setting up audio...");

            audioEl.srcObject = event.streams[0];
            audioEl.autoplay = true;
            audioEl.muted = false;
            audioEl.volume = 1.0;
            
            audioEl.play().then(() => {
                console.log("AUDIO IS PLAYING! 🎙️");
                audioGate.classList.add('hidden');
            }).catch(error => {
                console.warn("Autoplay blocked. Showing Gate.");
                audioGate.classList.remove('hidden');
                unlockBtn.onclick = () => {
                    audioEl.play().then(() => audioGate.classList.add('hidden'));
                };
            });
        };

        myPeerConnection.onicecandidate = (event) => {
            if(event.candidate) {
                socket.emit('signal', {
                    target: data.sender, 
                    type: 'candidate',
                    payload: event.candidate
                });
            }
        };

        await myPeerConnection.setRemoteDescription(new RTCSessionDescription(data.payload));
        const answer = await myPeerConnection.createAnswer();
        await myPeerConnection.setLocalDescription(answer);
        socket.emit('signal', {
            target: data.sender,
            type: 'answer',
            payload: answer
        });
    } 
    else if (data.type === 'answer' && myPeerConnection) {
        await myPeerConnection.setRemoteDescription(new RTCSessionDescription(data.payload));
    } 
    else if (data.type === 'candidate' && myPeerConnection) {
        try {
            await myPeerConnection.addIceCandidate(new RTCIceCandidate(data.payload));
        } catch (e) {}
    }
});

socket.on('mic_stopped', () => {
    stopStreaming();
    alert("Host stopped your audio.");
});

function stopStreaming() {
    if (myPeerConnection) {
        myPeerConnection.close();
        myPeerConnection = null;
    }
    socket.emit('lower_hand', currentRoom);
    btnStop.classList.add('hidden');
    btnRaise.classList.remove('hidden');
    statusText.innerText = "Ready to ask a question?";
}