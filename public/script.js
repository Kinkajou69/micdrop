const socket = io();

// State
let myRole = '';
let currentRoom = '';
let currentModeratorId = ''; // FIX: Store the specific socket ID of the host
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

// --- Navigation Helpers ---
function showView(viewName) {
    Object.values(views).forEach(el => el.classList.add('hidden'));
    views[viewName].classList.remove('hidden');
}

// --- Button Listeners ---
document.getElementById('btn-start').onclick = () => socket.emit('create_room');
document.getElementById('btn-join').onclick = () => showView('join');
document.getElementById('btn-back').onclick = () => showView('landing');

document.getElementById('btn-enter').onclick = () => {
    const name = document.getElementById('input-name').value;
    const code = document.getElementById('input-code').value.toUpperCase();
    if(name && code) socket.emit('join_room', { code, name });
    else alert("Please fill in both fields");
};

// --- Socket Events: General ---

socket.on('room_created', (code) => {
    myRole = 'moderator';
    currentRoom = code;
    // Moderator is their own moderator, technically
    currentModeratorId = socket.id; 
    
    document.getElementById('room-display').innerText = code;
    document.getElementById('role-display').innerText = 'HOST';
    document.getElementById('status-bar').classList.remove('hidden');
    showView('moderator');
});

socket.on('joined_success', (data) => {
    myRole = 'attendee';
    currentRoom = data.code;
    // FIX: Save the moderator's ID for WebRTC targeting
    currentModeratorId = data.moderatorId;
    
    document.getElementById('room-display').innerText = data.code;
    document.getElementById('role-display').innerText = data.name;
    document.getElementById('status-bar').classList.remove('hidden');
    showView('attendee');
});

socket.on('error_msg', (msg) => {
    alert(msg);
    location.reload(); // Hard reset on critical error
});

// --- MODERATOR UI LOGIC ---

socket.on('update_attendees', (attendees) => {
    if(myRole !== 'moderator') return;
    
    const list = document.getElementById('attendee-list');
    list.innerHTML = '';
    
    // Sort: Hand raised moves to top
    attendees.sort((a, b) => (b.handRaised === true) - (a.handRaised === true));

    attendees.forEach(att => {
        const div = document.createElement('div');
        div.className = `attendee-item ${att.handRaised ? 'hand-raised' : ''}`;
        
        let controls = '';
        if(att.handRaised) {
            controls = `
                <div class="mod-controls">
                    <button class="primary-btn" onclick="approveSpeaker('${att.id}')">✅ Speak</button>
                    <button class="danger-btn" onclick="rejectSpeaker('${att.id}')">❌ Deny</button>
                </div>
            `;
        } else {
             controls = `<span style="font-size:0.8rem; opacity:0.6; margin-right:10px">Listening</span>`;
             // If we wanted to forcefully mute someone currently speaking, we'd add a "Stop" button here for active speakers
        }

        div.innerHTML = `<span>${att.name}</span>${controls}`;
        list.appendChild(div);
    });
});

window.approveSpeaker = (id) => {
    // Reset any previous connections first to be safe
    resetConnection(); 
    socket.emit('moderator_action', { action: 'approve', targetId: id, code: currentRoom });
};

window.rejectSpeaker = (id) => {
    socket.emit('moderator_action', { action: 'reject', targetId: id, code: currentRoom });
};

// --- ATTENDEE UI LOGIC ---

btnRaise.onclick = () => {
    // Simple cooldown check
    const lastRejection = localStorage.getItem('micdrop_reject_time');
    if (lastRejection && (Date.now() - parseInt(lastRejection) < 30000)) {
        alert("Please wait a moment before raising your hand again.");
        return;
    }
    socket.emit('raise_hand', currentRoom);
    statusText.innerText = "Hand Raised! Waiting for host...";
    btnRaise.classList.add('hidden');
};

btnStop.onclick = () => {
    stopStreaming(); // User clicked "Done"
};

socket.on('hand_rejected', () => {
    resetConnection(); // <--- THIS is the missing piece!
    statusText.innerText = "Host declined. Try again later.";
    localStorage.setItem('micdrop_reject_time', Date.now());
    btnRaise.classList.remove('hidden');
    btnStop.classList.add('hidden'); // Hide the stop button if it was visible
});

// --- WebRTC LOGIC (The Hard Part) ---

const rtcConfig = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

function resetConnection() {
    if (myPeerConnection) {
        myPeerConnection.close();
        myPeerConnection = null;
    }
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
}

// 1. ATTENDEE: "You are approved"
socket.on('mic_approved', async (data) => {
    // Double check we have the latest mod ID
    if(data.moderatorId) currentModeratorId = data.moderatorId;

    statusText.innerText = "You are LIVE! 🎙️";
    btnStop.classList.remove('hidden');
    
    try {
        resetConnection();
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        
        myPeerConnection = new RTCPeerConnection(rtcConfig);
        localStream.getTracks().forEach(track => myPeerConnection.addTrack(track, localStream));

        // ICE Candidate: Send to Moderator
        myPeerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit('signal', {
                    target: currentModeratorId, // FIX: Using real ID
                    type: 'candidate',
                    payload: event.candidate
                });
            }
        };

        // Create Offer
        const offer = await myPeerConnection.createOffer();
        await myPeerConnection.setLocalDescription(offer);
        
        // Send Offer to Moderator
        socket.emit('signal', {
            target: currentModeratorId,
            type: 'offer',
            payload: offer
        });
        
    } catch (err) {
        console.error("Mic Error:", err);
        alert("Could not access microphone.");
        stopStreaming();
    }
});

// 2. MODERATOR: "Incoming Call" (Offer)
socket.on('signal', async (data) => {
    // If we are not the target, ignore (shouldn't happen with correct routing, but safety first)
    if(myRole === 'moderator' && data.type === 'offer') {
        
        resetConnection(); // Ensure we don't have old tracks playing
        myPeerConnection = new RTCPeerConnection(rtcConfig);
        
        // When audio arrives, play it
        myPeerConnection.ontrack = (event) => {
            const audioEl = document.getElementById('remote-audio');
            audioEl.srcObject = event.streams[0];
            // Vital: We need to handle the promise to avoid "uncaught promise" errors
            audioEl.play().catch(e => console.warn("Autoplay blocked. User interaction needed.", e));
        };

        myPeerConnection.onicecandidate = (event) => {
            if(event.candidate) {
                socket.emit('signal', {
                    target: data.sender, // Reply to the sender (Attendee)
                    type: 'candidate',
                    payload: event.candidate
                });
            }
        };

        // Handle the Offer
        await myPeerConnection.setRemoteDescription(new RTCSessionDescription(data.payload));
        const answer = await myPeerConnection.createAnswer();
        await myPeerConnection.setLocalDescription(answer);
        
        // Send Answer back
        socket.emit('signal', {
            target: data.sender,
            type: 'answer',
            payload: answer
        });
        
        // Show who is speaking (Optional UI polish)
        // We could look up data.sender in our attendee list to show "Bob is speaking"
    } 
    // Handle Answer (Attendee receiving back from Mod)
    else if (data.type === 'answer' && myPeerConnection) {
        await myPeerConnection.setRemoteDescription(new RTCSessionDescription(data.payload));
    } 
    // Handle ICE Candidates (Both sides)
    else if (data.type === 'candidate' && myPeerConnection) {
        try {
            await myPeerConnection.addIceCandidate(new RTCIceCandidate(data.payload));
        } catch (e) {
            console.error("Error adding ICE:", e);
        }
    }
});

// Global Stop
socket.on('mic_stopped', () => {
    stopStreaming();
    alert("Host stopped your audio.");
});

function stopStreaming() {
    resetConnection();
    socket.emit('lower_hand', currentRoom);
    
    // UI Reset
    btnStop.classList.add('hidden');
    btnRaise.classList.remove('hidden');
    statusText.innerText = "Ready to ask a question?";
}