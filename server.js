// server.js (versione 1.3 - completo)
// Note: integra timer 60s per domanda/risposta/tentativo, espulsione dopo 3 timeout,
// e grace period 30s per il Pensatore che si disconnette.

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

/*
 Room structure:
 rooms: Map(code -> {
   code,
   status: 'waiting'|'playing'|'guessing',
   players: Map(socketId -> { name, role, timeouts }),
   thinkerSocketId,
   pendingThinker: { name, timeoutId } | null,
   secretWord,
   questions: [{id,by,text,answer}],
   guesses: [{by,text,correct}],
   turnOrder: [socketId,...], // excludes thinker
   turnIdx,
   maxQuestions,
   asked,
   guessAttempts: { socketId: attemptsLeft } | null,
   logs: [],
   chat: [],
   timer: { id, type, targetId, questionId } | null,
   lastQuestionId: null
 })
*/
const rooms = new Map();

/* Helpers */
function createRoom(code) {
  rooms.set(code, {
    code,
    status: 'waiting',
    players: new Map(),
    thinkerSocketId: null,
    pendingThinker: null,
    secretWord: null,
    questions: [],
    guesses: [],
    turnOrder: [],
    turnIdx: 0,
    maxQuestions: 20,
    asked: 0,
    guessAttempts: null,
    logs: [],
    chat: [],
    timer: null,
    lastQuestionId: null
  });
}
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

/* Timer management: server triggers one timer per room (room.timer) */
function clearRoomTimer(room) {
  if (!room) return;
  if (room.timer && room.timer.id) {
    clearTimeout(room.timer.id);
  }
  room.timer = null;
}
function startRoomTimer(room, type, targetId = null, questionId = null, durationMs = 60000) {
  // clear existing timer
  clearRoomTimer(room);
  if (!room) return;
  // emit timer:start to the target actor (so client shows local progress)
  if (targetId) {
    io.to(targetId).emit('timer:start', { duration: durationMs, type });
  }
  // create timeout handler
  const tid = setTimeout(() => {
    room.timer = null;
    if (type === 'ask') {
      handleAskTimeout(room, targetId);
    } else if (type === 'answer') {
      handleAnswerTimeout(room, targetId, questionId);
    } else if (type === 'guess') {
      handleGuessTimeout(room, targetId);
    }
  }, durationMs);
  room.timer = { id: tid, type, targetId, questionId };
}

/* Utility: pick next guesser in guessAttempts map order that still has attempts > 0 */
function getNextGuesserId(room, currentId = null) {
  if (!room || !room.guessAttempts) return null;
  const ids = Object.keys(room.guessAttempts).filter(id => room.players.has(id)); // keep only present players
  if (ids.length === 0) return null;
  // if currentId not provided, return first with attempts > 0
  if (!currentId) {
    for (const id of ids) if ((room.guessAttempts[id] || 0) > 0) return id;
    return null;
  }
  // otherwise find next circularly
  const idx = ids.indexOf(currentId);
  for (let i = 1; i <= ids.length; i++) {
    const next = ids[(idx + i) % ids.length];
    if ((room.guessAttempts[next] || 0) > 0) return next;
  }
  return null;
}

/* TIMEOUT HANDLERS */
function handleAskTimeout(room, playerId) {
  if (!room || room.status !== 'playing') return;
  // validate current player
  const currentId = room.turnOrder[room.turnIdx];
  if (currentId !== playerId) return; // stale timer
  const player = room.players.get(playerId);
  if (!player) {
    // player missing -> remove from turnOrder and adjust
    room.turnOrder = room.turnOrder.filter(id => id !== playerId);
    if (room.turnIdx >= room.turnOrder.length) room.turnIdx = 0;
    if (room.turnOrder.length > 0) {
      const nextId = room.turnOrder[room.turnIdx];
      io.to(room.code).emit('turn:now', { socketId: nextId, name: room.players.get(nextId)?.name });
      startRoomTimer(room, 'ask', nextId);
    }
    return;
  }

  // increment consecutive timeouts
  player.timeouts = (player.timeouts || 0) + 1;

  // if >= 3, expel
  if (player.timeouts >= 3) {
    pushLog(room, `⛔ ${player.name} espulso per inattività (3 timeout).`);
    room.players.delete(playerId);
    room.turnOrder = room.turnOrder.filter(id => id !== playerId);
    if (room.turnIdx >= room.turnOrder.length) room.turnIdx = 0;
    io.to(room.code).emit('room:state', publicRoomState(room));
    io.emit('rooms:update', listRooms());
    // if no players left, clear timer
    if (room.turnOrder.length === 0) { clearRoomTimer(room); return; }
    // otherwise continue with current index (which might now point at next player)
    const nextId = room.turnOrder[room.turnIdx];
    io.to(room.code).emit('turn:now', { socketId: nextId, name: room.players.get(nextId)?.name });
    startRoomTimer(room, 'ask', nextId);
    return;
  }

  // skip their turn: increase asked counter
  room.asked++;
  pushLog(room, `⏱ ${player.name} non ha fatto la domanda in tempo — turno saltato.`);
  io.to(room.code).emit('counter:update', { asked: room.asked, max: room.maxQuestions });

  // check question limit
  if (room.asked >= room.maxQuestions) {
    clearRoomTimer(room);
    startGuessPhase(room.code);
    return;
  }

  // advance to next player
  if (room.turnOrder.length > 0) {
    room.turnIdx = (room.turnIdx + 1) % room.turnOrder.length;
    const nextId = room.turnOrder[room.turnIdx];
    io.to(room.code).emit('turn:now', { socketId: nextId, name: room.players.get(nextId)?.name });
    startRoomTimer(room, 'ask', nextId);
  } else {
    clearRoomTimer(room);
  }
}

function handleAnswerTimeout(room, thinkerId, questionId) {
  if (!room || room.status !== 'playing') return;
  // if pending question exists and unanswered, set 'Non so'
  const q = room.questions.find(x => x.id === questionId);
  if (q && q.answer == null) {
    q.answer = 'Non so';
    io.to(room.code).emit('question:update', q);
    pushLog(room, `⏱ Il Pensatore non ha risposto in tempo → "Non so".`);
  }

  // increment thinker's timeouts (if still in players map)
  const thinker = room.players.get(thinkerId);
  if (thinker) {
    thinker.timeouts = (thinker.timeouts || 0) + 1;
    if (thinker.timeouts >= 3) {
      // expel thinker -> end game
      pushLog(room, `⛔ Il Pensatore (${thinker.name}) espulso per inattività.`);
      clearRoomTimer(room);
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

  // advance to next asker's turn
  if (room.turnOrder.length > 0) {
    room.turnIdx = (room.turnIdx + 1) % room.turnOrder.length;
    const nextId = room.turnOrder[room.turnIdx];
    io.to(room.code).emit('turn:now', { socketId: nextId, name: room.players.get(nextId)?.name });
    startRoomTimer(room, 'ask', nextId);
  } else {
    clearRoomTimer(room);
  }
}

function handleGuessTimeout(room, playerId) {
  if (!room || room.status !== 'guessing' || !room.guessAttempts) return;
  // validate that player still has attempts
  if (!(playerId in room.guessAttempts)) return;
  const player = room.players.get(playerId);
  if (!player) {
    delete room.guessAttempts[playerId];
    const next = getNextGuesserId(room, playerId);
    if (next) {
      io.to(room.code).emit('turn:now', { socketId: next, name: room.players.get(next)?.name });
      startRoomTimer(room, 'guess', next);
    }
    return;
  }

  // increment their timeout count
  player.timeouts = (player.timeouts || 0) + 1;

  // if >= 3 -> expel
  if (player.timeouts >= 3) {
    pushLog(room, `⛔ ${player.name} espulso per inattività (3 timeout).`);
    delete room.guessAttempts[playerId];
    room.players.delete(playerId);
    room.turnOrder = room.turnOrder.filter(id => id !== playerId);
    io.to(room.code).emit('room:state', publicRoomState(room));
    io.emit('rooms:update', listRooms());
    const next = getNextGuesserId(room, playerId);
    if (next) { io.to(room.code).emit('turn:now', { socketId: next, name: room.players.get(next)?.name }); startRoomTimer(room, 'guess', next); }
    else {
      // no guessers left -> thinker wins
      return endRoundAndRotate(room.code, 'Nessuno ha indovinato. Tentativi esauriti.', room.thinkerSocketId);
    }
    return;
  }

  // decrement attempts for inactivity
  if (room.guessAttempts[playerId] > 0) {
    room.guessAttempts[playerId]--;
    pushLog(room, `⏱ ${player.name} non ha fatto il tentativo in tempo — tentativi rimasti: ${room.guessAttempts[playerId]}`);
    io.to(room.code).emit('guess:new', { by: playerId, name: player.name, text: '(timeout)', correct: false });
  }

  // check all out
  const allOut = Object.values(room.guessAttempts).every(x => x <= 0);
  if (allOut) {
    return endRoundAndRotate(room.code, 'Nessuno ha indovinato. Tentativi esauriti.', room.thinkerSocketId);
  }

  // move to next guesser
  const next = getNextGuesserId(room, playerId);
  if (next) {
    io.to(room.code).emit('turn:now', { socketId: next, name: room.players.get(next)?.name });
    startRoomTimer(room, 'guess', next);
  } else {
    clearRoomTimer(room);
  }
}

/* Game flow helpers */
function startGuessPhase(code) {
  const room = rooms.get(code);
  if (!room) return;
  room.status = 'guessing';
  room.guessAttempts = {};
  // initialize attempts for current players (exclude thinker)
  for (const [id] of room.players) {
    if (id !== room.thinkerSocketId) room.guessAttempts[id] = 2;
  }
  pushLog(room, '🔔 Domande finite! Ogni giocatore ha 2 tentativi per indovinare.');
  io.to(code).emit('room:state', publicRoomState(room));

  // start with the first valid guesser
  const first = getNextGuesserId(room);
  if (first) {
    room.turnIdx = room.turnOrder.indexOf(first); // not strictly necessary, but keep relative
    io.to(code).emit('turn:now', { socketId: first, name: room.players.get(first)?.name });
    startRoomTimer(room, 'guess', first);
  }
}

function endRoundAndRotate(code, message, winnerId = null) {
  const room = rooms.get(code);
  if (!room) return;
  clearRoomTimer(room);
  io.to(code).emit('round:ended', {
    message,
    secretWord: room.secretWord,
    questions: room.questions,
    guesses: room.guesses,
    winnerId: winnerId || null
  });
  // rotate thinker if room still exists
  rotateThinker(room);
  room.status = 'waiting';
  room.secretWord = null;
  room.questions = [];
  room.guesses = [];
  room.asked = 0;
  room.guessAttempts = null;
  room.lastQuestionId = null;
  clearRoomTimer(room);
  pushLog(room, message);
  io.to(code).emit('room:state', publicRoomState(room));
  io.emit('rooms:update', listRooms());
}

function rotateThinker(room) {
  if (!room) return;
  // pick next thinker as the player at turnIdx in turnOrder (if any), else any other
  let nextThinkerId = null;
  if (room.turnOrder.length > 0) {
    if (room.turnIdx >= room.turnOrder.length) room.turnIdx = 0;
    nextThinkerId = room.turnOrder[room.turnIdx];
  } else {
    nextThinkerId = Array.from(room.players.keys()).find(id => id !== room.thinkerSocketId) || room.thinkerSocketId;
  }
  for (const [id, p] of room.players) {
    p.role = (id === nextThinkerId) ? 'thinker' : 'guesser';
  }
  room.thinkerSocketId = nextThinkerId;
  room.turnOrder = Array.from(room.players.keys()).filter(id => id !== room.thinkerSocketId);
  room.turnIdx = 0;
}

/* When a non-thinker leaves during round, remove from turnOrder & adjust */
function handlePlayerExitDuringRound(room, socketId) {
  if (!room) return;
  const idx = room.turnOrder.indexOf(socketId);
  if (idx !== -1) {
    room.turnOrder.splice(idx, 1);
    if (room.status === 'playing') {
      if (room.turnOrder.length === 0) {
        clearRoomTimer(room);
        return;
      }
      if (idx < room.turnIdx) {
        room.turnIdx = Math.max(0, room.turnIdx - 1);
      }
      if (idx === room.turnIdx) {
        if (room.turnIdx >= room.turnOrder.length) room.turnIdx = 0;
        const nextId = room.turnOrder[room.turnIdx];
        io.to(room.code).emit('turn:now', { socketId: nextId, name: room.players.get(nextId)?.name });
        startRoomTimer(room, 'ask', nextId);
      }
    }
  }
}

/* SOCKET.IO handlers */
io.on('connection', (socket) => {
  // send list on request (clients call this at connect)
  socket.on('rooms:list', () => socket.emit('rooms:update', listRooms()));

  socket.on('room:create', ({ code, name }) => {
    if (rooms.has(code)) return socket.emit('system:error', 'Codice stanza già esistente');
    createRoom(code);
    const room = rooms.get(code);
    room.players.set(socket.id, { name, role: 'thinker', timeouts: 0 });
    room.thinkerSocketId = socket.id;
    socket.join(code);

    // cancel any pending thinker grace if existed (unlikely)
    if (room.pendingThinker && room.pendingThinker.timeoutId) {
      clearTimeout(room.pendingThinker.timeoutId);
      room.pendingThinker = null;
    }

    pushLog(room, `👤 ${name} ha creato la stanza ed è il Pensatore`);
    socket.emit('log:history', room.logs);
    socket.emit('chat:history', room.chat);
    io.to(code).emit('room:state', publicRoomState(room));
    io.emit('rooms:update', listRooms());
  });

  socket.on('room:join', ({ code, name }) => {
    const room = rooms.get(code);
    if (!room) return socket.emit('system:error', 'Stanza non trovata');

    // If there's a pendingThinker (grace) and name matches, treat as thinker return
    if (room.pendingThinker && room.pendingThinker.name === name) {
      // cancel grace
      clearTimeout(room.pendingThinker.timeoutId);
      room.pendingThinker = null;
      // assign new socket as thinker
      room.players.set(socket.id, { name, role: 'thinker', timeouts: 0 });
      room.thinkerSocketId = socket.id;
      socket.join(code);
      pushLog(room, `🔁 ${name} è rientrato come Pensatore entro il grace period`);
      socket.emit('log:history', room.logs);
      socket.emit('chat:history', room.chat);
      io.to(code).emit('room:state', publicRoomState(room));
      io.emit('rooms:update', listRooms());

      // If there was a pending question waiting answer (room.lastQuestionId), start answer timer
      if (room.lastQuestionId != null && room.status === 'playing') {
        startRoomTimer(room, 'answer', room.thinkerSocketId, room.lastQuestionId);
      }
      return;
    }

    // Normal join as guesser
    room.players.set(socket.id, { name, role: 'guesser', timeouts: 0 });
    socket.join(code);

    // send histories
    socket.emit('log:history', room.logs);
    socket.emit('chat:history', room.chat);

    pushLog(room, `👋 ${name} è entrato nella stanza`);
    io.to(code).emit('room:state', publicRoomState(room));
    io.emit('rooms:update', listRooms());

    // If playing, append to turnOrder if not present and not thinker
    if (room.status === 'playing') {
      if (socket.id !== room.thinkerSocketId && !room.turnOrder.includes(socket.id)) {
        room.turnOrder.push(socket.id);
        pushLog(room, `➕ ${name} si è unito in corsa e verrà servito quando arriverà il suo turno`);
        io.to(code).emit('room:state', publicRoomState(room));
      }
    }

    // If guessing phase active, ensure guessAttempts entry
    if (room.status === 'guessing' && room.guessAttempts) {
      if (!(socket.id in room.guessAttempts)) room.guessAttempts[socket.id] = 2;
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
      // start grace period: let them return within 30s
      const name = player ? player.name : null;
      pushLog(room, `⚠️ Il Pensatore (${name}) si è disconnesso: grace period 30s per rientrare.`);
      // remove from players map (we already deleted), mark pendingThinker
      const timeoutId = setTimeout(() => {
        // if still pending -> end round and delete room
        const r = rooms.get(code);
        if (!r) return;
        if (r.pendingThinker && r.pendingThinker.name === name) {
          pushLog(r, `⏳ Il Pensatore non è rientrato entro 30s. Round terminato.`);
          io.to(code).emit('round:ended', {
            message: 'Il Pensatore non è tornato in tempo. Round terminato.',
            secretWord: r.secretWord,
            questions: r.questions,
            guesses: r.guesses,
            winnerId: null
          });
          rooms.delete(code);
          io.emit('rooms:update', listRooms());
        }
      }, 30000);
      room.pendingThinker = { name, timeoutId };
      // notify others
      io.to(code).emit('room:state', publicRoomState(room));
      io.emit('rooms:update', listRooms());
      return;
    } else {
      // non-thinker left: remove from turnOrder & adjust
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
    for (const [, p] of room.players) p.timeouts = 0;

    io.to(code).emit('round:started', { maxQuestions: room.maxQuestions, players: getPlayers(room) });
    io.to(room.thinkerSocketId).emit('round:secret', { secretWord: room.secretWord });

    if (room.turnOrder.length > 0) {
      const nextId = room.turnOrder[room.turnIdx];
      io.to(code).emit('turn:now', { socketId: nextId, name: room.players.get(nextId)?.name });
      startRoomTimer(room, 'ask', nextId);
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
    clearRoomTimer(room);

    const q = { id: room.questions.length + 1, by: socket.id, text: String(text).trim(), answer: null };
    room.questions.push(q);
    room.lastQuestionId = q.id;
    io.to(code).emit('question:new', { ...q, byName: room.players.get(socket.id)?.name });

    // start thinker answer timer
    startRoomTimer(room, 'answer', room.thinkerSocketId, q.id);
  });

  socket.on('question:answer', ({ code, id, answer }) => {
    const room = rooms.get(code);
    if (!room || socket.id !== room.thinkerSocketId) return;
    const q = room.questions.find(x => x.id === id);
    if (!q || q.answer) return;

    // reset thinker's timeouts
    const thinker = room.players.get(socket.id);
    if (thinker) thinker.timeouts = 0;

    // stop answer timer
    clearRoomTimer(room);

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
      io.to(room.code).emit('turn:now', { socketId: nextId, name: room.players.get(nextId)?.name });
      startRoomTimer(room, 'ask', nextId);
    }

    if (room.asked >= room.maxQuestions && room.status === 'playing') startGuessPhase(room.code);
  });

  socket.on('guess:submit', ({ code, text }) => {
    const room = rooms.get(code);
    if (!room || (room.status !== 'playing' && room.status !== 'guessing')) return;
    const guess = String(text || '').trim();
    const player = room.players.get(socket.id);
    if (player) player.timeouts = 0; // reset inactivity on action

    const correct = room.secretWord && guess.toLowerCase() === room.secretWord.toLowerCase();

    if (room.status === 'guessing' && room.guessAttempts) {
      if (socket.id === room.thinkerSocketId) return;
      if (room.guessAttempts[socket.id] == null) room.guessAttempts[socket.id] = 2;
      if (room.guessAttempts[socket.id] <= 0) return;

      // stop current guess timer
      clearRoomTimer(room);

      room.guessAttempts[socket.id]--;
      pushLog(room, `${player?.name} ha tentato: "${guess}" ${correct ? '✅' : '❌'} — Tentativi rimasti: ${room.guessAttempts[socket.id]}`);
      io.to(code).emit('guess:new', { by: socket.id, name: player?.name, text: guess, correct });

      if (correct) return endRoundAndRotate(code, `${player?.name} ha indovinato!`, socket.id);

      // check all out
      const allOut = Object.values(room.guessAttempts).every(x => x <= 0);
      if (allOut) return endRoundAndRotate(code, 'Nessuno ha indovinato. Tentativi esauriti.', room.thinkerSocketId);

      // next guesser
      const next = getNextGuesserId(room, socket.id);
      if (next) {
        io.to(code).emit('turn:now', { socketId: next, name: room.players.get(next)?.name });
        startRoomTimer(room, 'guess', next);
      }
      return;
    }

    // playing-phase premature guess (counts as question if wrong)
    room.guesses.push({ by: socket.id, text: guess, correct });
    io.to(code).emit('guess:new', { by: socket.id, name: player?.name, text: guess, correct });
    if (correct) return endRoundAndRotate(code, `${player?.name} ha indovinato!`, socket.id);

    // wrong guess -> counts as used question
    room.asked++;
    io.to(code).emit('counter:update', { asked: room.asked, max: room.maxQuestions });
    if (room.asked >= room.maxQuestions) startGuessPhase(room.code);
    else {
      // advance turn
      if (room.turnOrder.length > 0) {
        room.turnIdx = (room.turnIdx + 1) % room.turnOrder.length;
        const nextId = room.turnOrder[room.turnIdx];
        io.to(room.code).emit('turn:now', { socketId: nextId, name: room.players.get(nextId)?.name });
        startRoomTimer(room, 'ask', nextId);
      }
    }
  });

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
        // start grace period 30s for thinker to return by joining with same name
        const name = player ? player.name : null;
        pushLog(room, `⚠️ Il Pensatore (${name}) si è disconnesso: grace period 30s`);
        // clear any room timer (pause)
        clearRoomTimer(room);
        // set pendingThinker record
        const timeoutId = setTimeout(() => {
          // if still pending, end round and delete room
          const r = rooms.get(code);
          if (!r) return;
          if (r.pendingThinker && r.pendingThinker.name === name) {
            pushLog(r, `⏳ Il Pensatore non è rientrato entro 30s. Round terminato.`);
            io.to(code).emit('round:ended', {
              message: 'Il Pensatore non è tornato in tempo. Round terminato.',
              secretWord: r.secretWord,
              questions: r.questions,
              guesses: r.guesses,
              winnerId: null
            });
            rooms.delete(code);
            io.emit('rooms:update', listRooms());
          }
        }, 30000);
        room.pendingThinker = { name, timeoutId };
        room.thinkerSocketId = null;
        io.to(code).emit('room:state', publicRoomState(room));
      } else {
        // normal player disconnect
        // remove from turnOrder
        room.turnOrder = room.turnOrder.filter(id => id !== socket.id);
        if (room.turnIdx >= room.turnOrder.length) room.turnIdx = 0;
        // if it was their turn, advance
        if (room.status === 'playing') {
          if (room.turnOrder.length > 0) {
            io.to(code).emit('room:state', publicRoomState(room));
            io.to(code).emit('turn:now', { socketId: room.turnOrder[room.turnIdx], name: room.players.get(room.turnOrder[room.turnIdx])?.name });
            startRoomTimer(room, 'ask', room.turnOrder[room.turnIdx]);
          } else {
            clearRoomTimer(room);
            io.to(code).emit('room:state', publicRoomState(room));
          }
        } else {
          io.to(code).emit('room:state', publicRoomState(room));
        }
      }
    }
    io.emit('rooms:update', listRooms());
  });

}); // end io.on connection

/* Start server */
app.use(express.static(path.join(__dirname, 'public')));
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log('Server listening on http://localhost:' + PORT));
