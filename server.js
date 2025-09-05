const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const rooms = new Map();

function createRoom(code) {
  rooms.set(code, {
    code, status: 'waiting', players: new Map(),
    thinkerSocketId: null, secretWord: null,
    questions: [], guesses: [], turnOrder: [], turnIdx: 0, maxQuestions: 20, asked: 0
  });
}

io.on('connection', (socket) => {
  socket.on('rooms:list', () => {
    io.emit('rooms:update', Array.from(rooms.values()).map(r => ({
      code: r.code, players: r.players.size, status: r.status
    })));
  });

  socket.on('room:create', ({ code, name }) => {
    if (rooms.has(code)) return socket.emit('system:error', 'Codice stanza già esistente');
    createRoom(code);
    const room = rooms.get(code);
    room.players.set(socket.id, { name, role: 'thinker' });
    room.thinkerSocketId = socket.id;
    socket.join(code);
    io.to(code).emit('room:state', publicRoomState(room));
    io.emit('rooms:update', getRoomsList());
  });

  socket.on('room:join', ({ code, name }) => {
    const room = rooms.get(code);
    if (!room) return socket.emit('system:error', 'Stanza non trovata');
    if (room.status !== 'waiting') return socket.emit('system:error', 'Partita già iniziata');
    room.players.set(socket.id, { name, role: 'guesser' });
    socket.join(code);
    io.to(code).emit('room:state', publicRoomState(room));
    io.emit('rooms:update', getRoomsList());
  });

  socket.on('room:leave', ({ code }) => {
    const room = rooms.get(code);
    if (!room) return;
    room.players.delete(socket.id);
    socket.leave(code);
    if (room.players.size === 0) rooms.delete(code);
    else io.to(code).emit('room:state', publicRoomState(room));
    io.emit('rooms:update', getRoomsList());
  });

  socket.on('round:start', ({ code, secretWord }) => {
    const room = rooms.get(code);
    if (!room) return;
    if (socket.id !== room.thinkerSocketId) return;
    room.secretWord = String(secretWord || '').trim();
    if (!room.secretWord) return socket.emit('system:error', 'Parola segreta vuota');
    room.status = 'playing';
    room.questions = [];
    room.guesses = [];
    room.turnOrder = Array.from(room.players.keys()).filter(id => id !== room.thinkerSocketId);
    room.turnIdx = 0;
    room.asked = 0;
    io.to(code).emit('round:started', { maxQuestions: room.maxQuestions, players: getPlayers(room) });
    io.to(room.thinkerSocketId).emit('round:secret', { secretWord: room.secretWord });
    if (room.turnOrder.length > 0) {
      const nextId = room.turnOrder[room.turnIdx];
      io.to(code).emit('turn:now', { socketId: nextId, name: room.players.get(nextId)?.name });
    }
    io.emit('rooms:update', getRoomsList());
  });

  socket.on('question:ask', ({ code, text }) => {
    const room = rooms.get(code);
    if (!room || room.status !== 'playing') return;
    const isTurn = room.turnOrder[room.turnIdx] === socket.id;
    if (!isTurn) return socket.emit('system:error', 'Non è il tuo turno');
    if (room.asked >= room.maxQuestions) return socket.emit('system:error', 'Limite di 20 domande raggiunto');

    const q = { id: room.questions.length + 1, by: socket.id, text: String(text).trim(), answer: null };
    room.questions.push(q);
    io.to(code).emit('question:new', { ...q, byName: room.players.get(socket.id)?.name });
  });

  socket.on('question:answer', ({ code, id, answer }) => {
    const room = rooms.get(code);
    if (!room || socket.id !== room.thinkerSocketId) return;
    const q = room.questions.find(x => x.id === id);
    if (!q) return;
    q.answer = answer;
    io.to(code).emit('question:update', q);

    if (answer !== 'Non so') {
      room.asked++;
      io.to(code).emit('counter:update', { asked: room.asked, max: room.maxQuestions });
    }

    if (room.turnOrder.length > 0) {
      room.turnIdx = (room.turnIdx + 1) % room.turnOrder.length;
      const nextId = room.turnOrder[room.turnIdx];
      io.to(code).emit('turn:now', { socketId: nextId, name: room.players.get(nextId)?.name });
    }

    if (room.asked >= room.maxQuestions) {
      endRound(code, false, 'Domande esaurite. Nessuno ha indovinato.');
    }
  });

  socket.on('guess:submit', ({ code, text }) => {
    const room = rooms.get(code);
    if (!room || room.status !== 'playing') return;
    const guess = String(text).trim();
    const correct = guess.toLowerCase() === room.secretWord.toLowerCase();
    room.guesses.push({ by: socket.id, text: guess, correct });
    io.to(code).emit('guess:new', { by: socket.id, name: room.players.get(socket.id)?.name, text: guess, correct });

    // il tentativo conta come domanda
    room.asked++;
    io.to(code).emit('counter:update', { asked: room.asked, max: room.maxQuestions });

    if (correct) endRound(code, true, `${room.players.get(socket.id)?.name} ha indovinato!`);
    else if (room.asked >= room.maxQuestions) {
      endRound(code, false, 'Domande esaurite. Nessuno ha indovinato.');
    }
  });

  socket.on('chat:message', ({ code, name, text }) => {
    const room = rooms.get(code);
    if (!room) return;
    io.to(code).emit('chat:message', { name, text });
  });

  socket.on('disconnect', () => {
    for (const [code, room] of rooms) {
      if (!room.players.has(socket.id)) continue;
      room.players.delete(socket.id);
      if (socket.id === room.thinkerSocketId) {
        io.to(code).emit('system:error', 'Il Pensatore ha lasciato la stanza. Round terminato.');
        rooms.delete(code);
      } else {
        io.to(code).emit('room:state', publicRoomState(room));
      }
    }
    io.emit('rooms:update', getRoomsList());
  });

  function endRound(code, someoneWon, message) {
    const room = rooms.get(code);
    if (!room) return;
    room.status = 'ended';
    io.to(code).emit('round:ended', { message, secretWord: room.secretWord, questions: room.questions, guesses: room.guesses });
  }

  function publicRoomState(room) {
    return { code: room.code, status: room.status, players: getPlayers(room), maxQuestions: room.maxQuestions };
  }
  function getPlayers(room) {
    return Array.from(room.players.entries()).map(([id, p]) => ({ id, name: p.name, role: p.role }));
  }
  function getRoomsList() {
    return Array.from(rooms.values()).map(r => ({
      code: r.code, players: r.players.size, status: r.status
    }));
  }
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log('Server listening on http://localhost:' + PORT));
