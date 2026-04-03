const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

// Store room states
const rooms = {};

function generateCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

io.on('connection', (socket) => {

    // --- Room Management ---

    socket.on('create_room', () => {
        const code = generateCode();
        rooms[code] = {
            moderatorId: socket.id,
            attendees: []
        };
        socket.join(code);
        socket.emit('room_created', code);
        console.log(`Room created: ${code} by ${socket.id}`);
    });

    socket.on('join_room', ({ code, name }) => {
        const room = rooms[code];
        if (room) {
            socket.join(code);
            room.attendees.push({ id: socket.id, name: name, handRaised: false });
            socket.emit('joined_success', {
                name,
                code,
                moderatorId: room.moderatorId
            });
            io.to(room.moderatorId).emit('update_attendees', room.attendees);
        } else {
            socket.emit('error_msg', 'Invalid Conference Code');
        }
    });

    // --- Hand Logic ---

    socket.on('raise_hand', (code) => {
        const room = rooms[code];
        if (room) {
            const attendee = room.attendees.find(a => a.id === socket.id);
            if (attendee) {
                attendee.handRaised = true;
                io.to(room.moderatorId).emit('update_attendees', room.attendees);
            }
        }
    });

    socket.on('lower_hand', (code) => {
        const room = rooms[code];
        if (room) {
            const attendee = room.attendees.find(a => a.id === socket.id);
            if (attendee) {
                attendee.handRaised = false;
                io.to(room.moderatorId).emit('update_attendees', room.attendees);
            }
        }
    });

    // --- Moderation Logic ---

    socket.on('moderator_action', ({ action, targetId, code }) => {
        const room = rooms[code];
        if (!room) return;

        if (action === 'reject') {
            // Tell the attendee to stop their mic AND reset their hand
            io.to(targetId).emit('mic_stopped');
            io.to(targetId).emit('hand_rejected');
            const attendee = room.attendees.find(a => a.id === targetId);
            if (attendee) attendee.handRaised = false;
            io.to(room.moderatorId).emit('update_attendees', room.attendees);
        }
        else if (action === 'approve') {
            io.to(targetId).emit('mic_approved', { moderatorId: room.moderatorId });
        }
        else if (action === 'stop') {
            io.to(targetId).emit('mic_stopped');
            const attendee = room.attendees.find(a => a.id === targetId);
            if (attendee) attendee.handRaised = false;
            io.to(room.moderatorId).emit('update_attendees', room.attendees);
        }
    });

    // --- Audio Chunk Relay ---

    socket.on('audio_chunk', (data) => {
        io.to(data.targetId).emit('audio_chunk', {
            buffer: data.buffer
        });
    });

    // --- Disconnect ---

    socket.on('disconnect', () => {
        for (const code in rooms) {
            const room = rooms[code];
            if (room.moderatorId === socket.id) {
                io.to(code).emit('error_msg', 'Host has disconnected. Room closed.');
                delete rooms[code];
            } else {
                const index = room.attendees.findIndex(a => a.id === socket.id);
                if (index !== -1) {
                    room.attendees.splice(index, 1);
                    io.to(room.moderatorId).emit('update_attendees', room.attendees);
                }
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Listening on *:${PORT}`);
});