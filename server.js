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
    code,
    status: 'waiting',
    players: new Map(),
    thinkerSocketId: null,
    secretWord: null,
    questions: [],
    guesses: [],
    turnOrder: [],
    turnIdx: 0,
    maxQuestions: 20,
    asked: 0,
    guessAttempts: null // aggiunto: gestisce tentativi extra
  });
}

io.on('connection', (socket) => {
  // Creazione stanza
  socket.on('room:create', ({ code, name }) => {
    if (rooms.has(code)) return socket.emit('system:error', 'Codice stanza già esistente');
    createRoom(code);
    const room = rooms.get(code);
    room.players.set(socket.id, { name, role: 'thinker' });
    room.thinkerSocketId = socket.id;
    socket.join(code);
    io.to(code).emit('room:state', publicRoomState(room));
    io.emit('rooms:update', listRooms());
  });

  // Join stanza
  socket.on('room:join', ({ code, name }) => {
    const room = rooms.get(code);
    if (!room) return socket.emit('system:error', 'Stanza non trovata');
    if (room.status !== 'waiting') return socket.emit('system:error', 'Partita già iniziata');
    room.players.set(socket.id, { name, role: 'guesser' });
    socket.join(code);
    io.to(code).emit('room:state', publicRoomState(room));
    io.emit('rooms:update', listRooms());
  });

  // Uscita volontaria
  socket.on('room:leave', ({ code }) => {
    const room = rooms.get(code);
    if (!room) return;
    room.players.delete(socket.id);
    socket.leave(code);
    io.to(code).emit('room:state', publicRoomState(room));
    if (room.players.size === 0) rooms.delete(code);
    io.emit('rooms:update', listRooms());
  });

  // Start round
  socket.on('round:start', ({ code, secretWord }) => {
    const room = rooms.get(code);
    if (!room) return;
    if (socket.id !== room.thinkerSocketId) return;
    room.secretWord = String(secretWord || '').trim();
    if (!room.secretWord) return socket.emit('system:error', 'Parola segreta vuota');
    room.status = 'playing';
    room.questions = [];
    room.guesses = [];
    room.asked = 0;
    room.guessAttempts = null;
    room.turnOrder = Array.from(room.players.keys()).filter(id => id !== room.thinkerSocketId);
    room.turnIdx = 0;

    io.to(code).emit('round:started', { maxQuestions: room.maxQuestions, players: getPlayers(room) });
    io.to(room.thinkerSocketId).emit('round:secret', { secretWord: room.secretWord });

    if (room.turnOrder.length > 0) {
      const nextId = room.turnOrder[room.turnIdx];
      io.to(code).emit('turn:now', { socketId: nextId, name: room.players.get(nextId)?.name });
    }
  });

  // Domanda
  socket.on('question:ask', ({ code, text }) => {
    const room = rooms.get(code);
    if (!room || room.status !== 'playing') return;
    const isTurn = room.turnOrder[room.turnIdx] === socket.id;
    if (!isTurn) return socket.emit('system:error', 'Non è il tuo turno');
    if (room.asked >= room.maxQuestions) return socket.emit('system:error', 'Limite domande raggiunto');

    const q = { id: room.questions.length + 1, by: socket.id, text: String(text).trim(), answer: null };
    room.questions.push(q);
    io.to(code).emit('question:new', { ...q, byName: room.players.get(socket.id)?.name });
  });

  // Risposta
  socket.on('question:answer', ({ code, id, answer }) => {
    const room = rooms.get(code);
    if (!room || socket.id !== room.thinkerSocketId) return;
    const q = room.questions.find(x => x.id === id);
    if (!q) return;
    if (q.answer) return;

    q.answer = answer;
    io.to(code).emit('question:update', q);

    if (answer !== "Non so") {
      room.asked++;
      io.to(code).emit('counter:update', { asked: room.asked, max: room.maxQuestions });
    }

    // prossimo turno
    if (room.turnOrder.length > 0) {
      room.turnIdx = (room.turnIdx + 1) % room.turnOrder.length;
      const nextId = room.turnOrder[room.turnIdx];
      io.to(code).emit('turn:now', { socketId: nextId, name: room.players.get(nextId)?.name });
    }

    // fine domande
    if (room.asked >= room.maxQuestions) {
      startGuessPhase(code);
    }
  });

  // Tentativo
  socket.on('guess:submit', ({ code, text }) => {
    const room = rooms.get(code);
    if (!room || room.status !== 'playing') return;
    const guess = String(text).trim();
    const correct = guess.toLowerCase() === room.secretWord.toLowerCase();

    // se è la fase guess finale -> gestisci tentativi
    if (room.guessAttempts) {
      const attemptsLeft = room.guessAttempts[socket.id];
      if (attemptsLeft <= 0) {
        return socket.emit('system:error', 'Hai esaurito i tentativi');
      }
      room.guessAttempts[socket.id]--;
      io.to(code).emit('log:message', `${room.players.get(socket.id)?.name} ha tentato: "${guess}" ${correct?'✅':'❌'} — Tentativi rimasti: ${room.guessAttempts[socket.id]}`);
      if (correct) return endRound(code, true, `${room.players.get(socket.id)?.name} ha indovinato!`);
      const allOut = Object.values(room.guessAttempts).every(x => x <= 0);
      if (allOut) return endRound(code, false, 'Nessuno ha indovinato. Tentativi esauriti.');
      return;
    }

    // fase normale
    room.guesses.push({ by: socket.id, text: guess, correct });
    io.to(code).emit('guess:new', { by: socket.id, name: room.players.get(socket.id)?.name, text: guess, correct });
    if (correct) endRound(code, true, `${room.players.get(socket.id)?.name} ha indovinato!`);
    else {
      room.asked++;
      io.to(code).emit('counter:update', { asked: room.asked, max: room.maxQuestions });
      if (room.asked >= room.maxQuestions) startGuessPhase(code);
    }
  });

  // Disconnect
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
    io.emit('rooms:update', listRooms());
  });

  // Helpers
  function startGuessPhase(code) {
    const room = rooms.get(code);
    if (!room) return;
    room.guessAttempts = {};
    for (const [id, player] of room.players.entries()) {
      if (id !== room.thinkerSocketId) {
        room.guessAttempts[id] = 2;
      }
    }
    io.to(code).emit('log:message', '🔔 Domande finite! Ogni giocatore ha 2 tentativi per indovinare.');
  }

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
  function listRooms() {
    return Array.from(rooms.values()).map(r => ({ code:r.code, players:r.players.size, status:r.status }));
  }
});

// static
app.use(express.static(path.join(__dirname, 'public')));
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log('Server listening on http://localhost:'+PORT));
