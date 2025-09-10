// server.js (versione 1.2)
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

/**
 * Room structure (Map)
 * rooms: Map(code -> {
 *   code,
 *   status: 'waiting'|'playing'|'guessing',
 *   players: Map(socketId -> { name, role, timeouts }),
 *   thinkerSocketId,
 *   secretWord,
 *   questions: [{id,by,text,answer}],
 *   guesses: [{by,text,correct}],
 *   turnOrder: [socketId,...] (EXCLUDES thinker),
 *   turnIdx,
 *   maxQuestions,
 *   asked,
 *   guessAttempts: {socketId: attemptsLeft} OR null,
 *   logs: [],
 *   chat: [],
 *   turnTimer: numeric timeout id (or null),
 *   lastQuestionId: id of current question waiting for answer
 * })
 */
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
    guessAttempts: null,
    guessTimers: {}, // aggiunto
    logs: [],
    chat: [],
    turnTimer: null,
    lastQuestionId: null
  });
}

/* Helper utilities */
function listRooms() {
  return Array.from(rooms.values()).map(r => ({ code: r.code, players: r.players.size, status: r.status }));
}
function getPlayers(room) {
  return Array.from(room.players.entries()).map(([id, p]) => ({ id, name: p.name, role: p.role }));
}
function publicRoomState(room) {
  return { code: room.code, status: room.status, players: getPlayers(room), maxQuestions: room.maxQuestions };
}
function pushLog(room, message) {
  room.logs.push(message);
  io.to(room.code).emit('log:message', message);
}

/* Timer helpers - server emits 'timer:start' to specific player, then acts on timeout */
function clearTurnTimer(room) {
  if (!room) return;
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
}
function startAskTimer(room) {
  clearTurnTimer(room);
  if (!room || room.status !== 'playing') return;
  if (!room.turnOrder || room.turnOrder.length === 0) return;
  if (room.turnIdx >= room.turnOrder.length) room.turnIdx = 0;
  const currentId = room.turnOrder[room.turnIdx];
  io.to(currentId).emit('timer:start', { duration: 60000, type: 'ask' });
  room.turnTimer = setTimeout(() => handleAskTimeout(room, currentId), 60000);
}
function startAnswerTimer(room, questionId) {
  clearTurnTimer(room);
  if (!room || room.status !== 'playing') return;
  const thinkerId = room.thinkerSocketId;
  if (!thinkerId) return;
  io.to(thinkerId).emit('timer:start', { duration: 60000, type: 'answer' });
  room.turnTimer = setTimeout(() => handleAnswerTimeout(room, thinkerId, questionId), 60000);
}

function handleAskTimeout(room, playerId) {
  if (!room || room.status !== 'playing') return;
  // ensure current is same player
  const current = room.turnOrder[room.turnIdx];
  if (current !== playerId) return; // out of date timer
  const player = room.players.get(playerId);
  // safety: if player missing, remove and adjust
  if (!player) {
    // remove from turnOrder and continue
    room.turnOrder = room.turnOrder.filter(id => id !== playerId);
    if (room.turnIdx >= room.turnOrder.length) room.turnIdx = 0;
    if (room.turnOrder.length > 0) {
      io.to(room.code).emit('turn:now', { socketId: room.turnOrder[room.turnIdx], name: room.players.get(room.turnOrder[room.turnIdx])?.name });
      startAskTimer(room);
    } else {
      clearTurnTimer(room);
    }
    return;
  }

  // increment their timeout counter
  player.timeouts = (player.timeouts || 0) + 1;

  // if reached 3 -> expel
  if (player.timeouts >= 3) {
    pushLog(room, `⛔ ${player.name} espulso per inattività (3 timeout).`);
    // remove from players and turnOrder
    room.players.delete(playerId);
    const removedIdx = room.turnOrder.indexOf(playerId);
    room.turnOrder = room.turnOrder.filter(id => id !== playerId);
    if (removedIdx !== -1 && removedIdx < room.turnIdx) {
      room.turnIdx = Math.max(0, room.turnIdx - 1);
    }
    // if no players left -> clear timer
    if (room.turnOrder.length === 0) {
      clearTurnTimer(room);
    } else {
      if (room.turnIdx >= room.turnOrder.length) room.turnIdx = 0;
      const nextId = room.turnOrder[room.turnIdx];
      io.to(room.code).emit('turn:now', { socketId: nextId, name: room.players.get(nextId)?.name });
      startAskTimer(room);
    }
    io.to(room.code).emit('room:state', publicRoomState(room));
    io.emit('rooms:update', listRooms());
    return;
  }

  // skip their turn: increment question counter and advance
  room.asked++;
  pushLog(room, `⏱ ${player.name} non ha fatto la domanda in tempo — turno saltato.`);
  io.to(room.code).emit('counter:update', { asked: room.asked, max: room.maxQuestions });

  if (room.asked >= room.maxQuestions) {
    clearTurnTimer(room);
    startGuessPhase(room.code);
    return;
  }

  // advance to next player
  if (room.turnOrder.length > 0) {
    room.turnIdx = (room.turnIdx + 1) % room.turnOrder.length;
    const nextId = room.turnOrder[room.turnIdx];
    io.to(room.code).emit('turn:now', { socketId: nextId, name: room.players.get(nextId)?.name });
    startAskTimer(room);
  } else {
    clearTurnTimer(room);
  }
}

function handleAnswerTimeout(room, thinkerId, questionId) {
  if (!room || room.status !== 'playing') return;
  // verify pending question
  const q = room.questions.find(x => x.id === questionId);
  if (q && !q.answer) {
    q.answer = 'Non so';
    io.to(room.code).emit('question:update', q);
    pushLog(room, `⏱ Il Pensatore non ha risposto in tempo → risposto automaticamente "Non so".`);
  }
  // increment thinker's timeouts
  const thinker = room.players.get(thinkerId);
  if (thinker) {
    thinker.timeouts = (thinker.timeouts || 0) + 1;
    if (thinker.timeouts >= 3) {
      // expel thinker -> end round
      clearTurnTimer(room);
      io.to(room.code).emit('round:ended', {
        message: 'Il Pensatore è stato espulso per inattività. Round terminato.',
        secretWord: room.secretWord,
        questions: room.questions,
        guesses: room.guesses,
        winnerId: null
      });
      rooms.delete(room.code);
      io.emit('rooms:update', listRooms());
      return;
    }
  }

  // advance to next player
  if (room.turnOrder.length > 0) {
    room.turnIdx = (room.turnIdx + 1) % room.turnOrder.length;
    const nextId = room.turnOrder[room.turnIdx];
    io.to(room.code).emit('turn:now', { socketId: nextId, name: room.players.get(nextId)?.name });
    startAskTimer(room);
  } else {
    clearTurnTimer(room);
  }
}

/* Round/guess helpers */
function startGuessPhase(code) {
  const room = rooms.get(code);
  if (!room) return;
  room.status = 'guessing';
  room.guessAttempts = {};
  room.guessTimers = {};
  clearTurnTimer(room);
  for (const [id] of room.players) {
    if (id !== room.thinkerSocketId) room.guessAttempts[id] = 2;
  }
  pushLog(room, '🔔 Domande finite! Ogni giocatore ha 2 tentativi per indovinare.');
  io.to(code).emit('room:state', publicRoomState(room));
  startGuessTimers(room); // lancia timer individuali
}


function endRoundAndRotate(code, message, winnerId = null) {
  const room = rooms.get(code);
  if (!room) return;
  clearTurnTimer(room);
  io.to(code).emit('round:ended', {
    message,
    secretWord: room.secretWord,
    questions: room.questions,
    guesses: room.guesses,
    winnerId
  });
  rotateThinker(room);
  room.status = 'waiting';
  room.secretWord = null;
  room.questions = [];
  room.guesses = [];
  room.asked = 0;
  room.guessAttempts = null;
  room.lastQuestionId = null;
  clearTurnTimer(room);
  pushLog(room, message);
  io.to(code).emit('room:state', publicRoomState(room));
  io.emit('rooms:update', listRooms());
}

function rotateThinker(room) {
  if (!room) return;
  let nextThinkerId = null;
  if (room.turnOrder.length > 0) {
    // ensure turnIdx valid
    if (room.turnIdx >= room.turnOrder.length) room.turnIdx = 0;
    nextThinkerId = room.turnOrder[room.turnIdx];
  } else {
    nextThinkerId = Array.from(room.players.keys()).find(id => id !== room.thinkerSocketId) || room.thinkerSocketId;
  }
  for (const [id, p] of room.players) {
    p.role = (id === nextThinkerId) ? 'thinker' : 'guesser';
  }
  room.thinkerSocketId = nextThinkerId;
  // rebuild turnOrder excluding new thinker
  room.turnOrder = Array.from(room.players.keys()).filter(id => id !== room.thinkerSocketId);
  room.turnIdx = 0;
}

/* When a player leaves while round in progress, adjust turnOrder & maybe advance */
function handlePlayerExitDuringRound(room, socketId) {
  if (!room) return;
  const idx = room.turnOrder.indexOf(socketId);
  if (idx !== -1) {
    room.turnOrder.splice(idx, 1);
    if (room.status === 'playing') {
      if (room.turnOrder.length === 0) {
        clearTurnTimer(room);
        return;
      }
      if (idx < room.turnIdx) {
        room.turnIdx = Math.max(0, room.turnIdx - 1);
      }
      if (idx === room.turnIdx) {
        if (room.turnIdx >= room.turnOrder.length) room.turnIdx = 0;
        const nextId = room.turnOrder[room.turnIdx];
        io.to(room.code).emit('turn:now', { socketId: nextId, name: room.players.get(nextId)?.name });
        startAskTimer(room);
      }
    }
  }
}

/* --- Timer individuale per fase guessing --- */
function startGuessTimers(room) {
  if (!room || !room.guessAttempts) return;
  for (const id in room.guessAttempts) {
    startSingleGuessTimer(room, id);
  }
}

function startSingleGuessTimer(room, playerId) {
  if (room.guessTimers[playerId]) clearTimeout(room.guessTimers[playerId]);
  room.guessTimers[playerId] = setTimeout(() => {
    room.guessAttempts[playerId]--;
    pushLog(room, `⏱ ${room.players.get(playerId)?.name} non ha tentato in tempo — tentativi rimasti: ${room.guessAttempts[playerId]}`);
    io.to(room.code).emit('guess:new', {
      by: playerId,
      name: room.players.get(playerId)?.name,
      text: '(timeout)',
      correct: false
    });
    if (room.guessAttempts[playerId] <= 0) delete room.guessTimers[playerId];
    checkGuessPhaseEnd(room);
  }, 60000);
}

function checkGuessPhaseEnd(room) {
  if (!room.guessAttempts) return;
  const allOut = Object.values(room.guessAttempts).every(x => x <= 0);
  if (allOut) endRoundAndRotate(room.code, 'Nessuno ha indovinato. Tentativi esauriti.', room.thinkerSocketId);
}

/* --- Socket handlers --- */
io.on('connection', (socket) => {
  // initial list on demand
  socket.on('rooms:list', () => socket.emit('rooms:update', listRooms()));

  socket.on('room:create', ({ code, name }) => {
    if (rooms.has(code)) return socket.emit('system:error', 'Codice stanza già esistente');
    createRoom(code);
    const room = rooms.get(code);
    room.players.set(socket.id, { name, role: 'thinker', timeouts: 0 });
    room.thinkerSocketId = socket.id;
    socket.join(code);

    pushLog(room, `👤 ${name} ha creato la stanza ed è il Pensatore`);
    socket.emit('log:history', room.logs);
    socket.emit('chat:history', room.chat);
    io.to(code).emit('room:state', publicRoomState(room));
    io.emit('rooms:update', listRooms());
  });

  socket.on('room:join', ({ code, name }) => {
    const room = rooms.get(code);
    if (!room) return socket.emit('system:error', 'Stanza non trovata');

    room.players.set(socket.id, { name, role: 'guesser', timeouts: 0 });
    socket.join(code);

    // send histories
    socket.emit('log:history', room.logs);
    socket.emit('chat:history', room.chat);

    pushLog(room, `👋 ${name} è entrato nella stanza`);
    io.to(code).emit('room:state', publicRoomState(room));
    io.emit('rooms:update', listRooms());

    // if playing, append to turnOrder if not present
    if (room.status === 'playing' && socket.id !== room.thinkerSocketId && !room.turnOrder.includes(socket.id)) {
      room.turnOrder.push(socket.id);
      pushLog(room, `➕ ${name} si è unito in corsa e verrà servito quando arriverà il suo turno`);
      io.to(code).emit('room:state', publicRoomState(room));
    }
  });

  socket.on('room:leave', ({ code }) => {
    const room = rooms.get(code);
    if (!room) return;
    const player = room.players.get(socket.id);
    room.players.delete(socket.id);
    socket.leave(code);

    if (player) pushLog(room, `🚪 ${player.name} ha lasciato la stanza`);

    if (socket.id === room.thinkerSocketId) {
      // thinker leaves -> reveal and end
      clearTurnTimer(room);
      io.to(code).emit('round:ended', {
        message: 'Il Pensatore ha lasciato la stanza. Round terminato.',
        secretWord: room.secretWord,
        questions: room.questions,
        guesses: room.guesses,
        winnerId: null
      });
      rooms.delete(code);
      io.emit('rooms:update', listRooms());
      return;
    } else {
      // remove from turnOrder and possibly advance
      handlePlayerExitDuringRound(room, socket.id);
      io.to(code).emit('room:state', publicRoomState(room));
      io.emit('rooms:update', listRooms());
      if (room.players.size === 0) rooms.delete(code);
    }
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
    room.asked = 0;
    room.guessAttempts = null;
    room.turnOrder = Array.from(room.players.keys()).filter(id => id !== room.thinkerSocketId);
    room.turnIdx = 0;
    room.lastQuestionId = null;
    // reset timeouts counts
    for (const [,p] of room.players) p.timeouts = 0;

    io.to(code).emit('round:started', { maxQuestions: room.maxQuestions, players: getPlayers(room) });
    io.to(room.thinkerSocketId).emit('round:secret', { secretWord: room.secretWord });

    if (room.turnOrder.length > 0) {
      const nextId = room.turnOrder[room.turnIdx];
      io.to(code).emit('turn:now', { socketId: nextId, name: room.players.get(nextId)?.name });
      startAskTimer(room);
    }

    pushLog(room, '▶️ Round iniziato!');
    io.emit('rooms:update', listRooms());
    io.to(code).emit('room:state', publicRoomState(room));
  });

  socket.on('question:ask', ({ code, text }) => {
    const room = rooms.get(code);
    if (!room || room.status !== 'playing') return;
    const isTurn = room.turnOrder[room.turnIdx] === socket.id;
    if (!isTurn) return socket.emit('system:error', 'Non è il tuo turno');
    if (room.asked >= room.maxQuestions) return socket.emit('system:error', 'Limite domande raggiunto');

    // reset asker's timeout count
    const asker = room.players.get(socket.id);
    if (asker) asker.timeouts = 0;

    // stop ask timer
    clearTurnTimer(room);

    const q = { id: room.questions.length + 1, by: socket.id, text: String(text).trim(), answer: null };
    room.questions.push(q);
    room.lastQuestionId = q.id;
    io.to(code).emit('question:new', { ...q, byName: room.players.get(socket.id)?.name });

    // start answer timer for thinker
    startAnswerTimer(room, q.id);
  });

  socket.on('question:answer', ({ code, id, answer }) => {
    const room = rooms.get(code);
    if (!room || socket.id !== room.thinkerSocketId) return;
    const q = room.questions.find(x => x.id === id);
    if (!q || q.answer) return;

    // reset thinker's timeout count
    const thinker = room.players.get(socket.id);
    if (thinker) thinker.timeouts = 0;

    // stop answer timer
    clearTurnTimer(room);

    q.answer = answer;
    io.to(code).emit('question:update', q);
    if (answer !== 'Non so') {
      room.asked++;
      io.to(code).emit('counter:update', { asked: room.asked, max: room.maxQuestions });
    }

    // advance to next player
    if (room.turnOrder.length > 0) {
      room.turnIdx = (room.turnIdx + 1) % room.turnOrder.length;
      const nextId = room.turnOrder[room.turnIdx];
      io.to(code).emit('turn:now', { socketId: nextId, name: room.players.get(nextId)?.name });
      startAskTimer(room);
    }

    if (room.asked >= room.maxQuestions && room.status === 'playing') startGuessPhase(code);
  });

  socket.on('guess:submit', ({ code, text }) => {
  const room = rooms.get(code);
  if (!room || (room.status !== 'playing' && room.status !== 'guessing')) return;
  const guess = String(text).trim();
  const correct = room.secretWord && guess.toLowerCase() === room.secretWord.toLowerCase();

  // reset player's timeout count (any action resets)
  const player = room.players.get(socket.id);
  if (player) player.timeouts = 0;

  if (room.status === 'guessing' && room.guessAttempts) {
    if (socket.id === room.thinkerSocketId) return;

    // Se il giocatore non ha tentativi, ignora (già finiti)
    if (!room.guessAttempts.hasOwnProperty(socket.id) || room.guessAttempts[socket.id] <= 0) return;

    // stop timer del giocatore
    if (room.guessTimers[socket.id]) clearTimeout(room.guessTimers[socket.id]);

    room.guessAttempts[socket.id]--;
    pushLog(room, `⏱ ${player.name} ha tentato: "${guess}" -- Tentativi rimasti: ${room.guessAttempts[socket.id]}`);
    io.to(code).emit('guess:new', {
      by: socket.id,
      name: player.name,
      text: guess,
      correct: correct
    });

    if (correct) {
      return endRoundAndRotate(code, `${player.name} ha indovinato!`, socket.id);
    }

    if (room.guessAttempts[socket.id] > 0) startSingleGuessTimer(room, socket.id);

    checkGuessPhaseEnd(room);
    return;
  }

  // playing-phase guess
  room.guesses.push({ by: socket.id, text: guess, correct });
  io.to(code).emit('guess:new', { by: socket.id, name: player.name, text: guess, correct });
  if (correct) return endRoundAndRotate(code, `${player.name} ha indovinato!`, socket.id);

  // wrong guess counts as used question
  room.asked++;
  io.to(code).emit('counter:update', { asked: room.asked, max: room.maxQuestions });
  if (room.asked >= room.maxQuestions) startGuessPhase(code);
  else {
    // advance turn
    if (room.turnOrder.length > 0) {
      room.turnIdx = (room.turnIdx + 1) % room.turnOrder.length;
      const nextId = room.turnOrder[room.turnIdx];
      io.to(code).emit('turn:now', { socketId: nextId, name: room.players.get(nextId)?.name });
      startAskTimer(room);
    }
  }
});


  // chat
  socket.on('chat:message', ({ code, name, text }) => {
    const room = rooms.get(code);
    if (!room) return;
    const msg = { name, text };
    room.chat.push(msg);
    io.to(code).emit('chat:message', msg);
  });

  socket.on('disconnect', () => {
    for (const [code, room] of rooms) {
      if (!room.players.has(socket.id)) continue;
      const player = room.players.get(socket.id);
      room.players.delete(socket.id);
      if (player) pushLog(room, `🚪 ${player.name} si è disconnesso`);

      if (socket.id === room.thinkerSocketId) {
        clearTurnTimer(room);
        io.to(code).emit('round:ended', {
          message: 'Il Pensatore ha lasciato la stanza. Round terminato.',
          secretWord: room.secretWord,
          questions: room.questions,
          guesses: room.guesses,
          winnerId: null
        });
        rooms.delete(code);
      } else {
        // remove from turnOrder
        room.turnOrder = room.turnOrder.filter(id => id !== socket.id);
        if (room.turnIdx >= room.turnOrder.length) room.turnIdx = 0;
        if (room.status === 'playing') {
          // if it was that player's turn, advance
          if (room.turnOrder.length > 0) {
            io.to(code).emit('room:state', publicRoomState(room));
            io.to(code).emit('turn:now', { socketId: room.turnOrder[room.turnIdx], name: room.players.get(room.turnOrder[room.turnIdx])?.name });
            startAskTimer(room);
          } else {
            clearTurnTimer(room);
            io.to(code).emit('room:state', publicRoomState(room));
          }
        } else {
          io.to(code).emit('room:state', publicRoomState(room));
        }
      }
    }
    io.emit('rooms:update', listRooms());
  });

});

/* Start server static + listen */
app.use(express.static(path.join(__dirname, 'public')));
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log('Server listening on http://localhost:' + PORT));
