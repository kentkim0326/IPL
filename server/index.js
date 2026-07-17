// IPL Holdem — Game Server
// Socket.io + Node.js
// Deploy on Railway: railway up

const { createServer } = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3001;

const httpServer = createServer();
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// ═══════════════════════════════════════
// GAME STATE
// ═══════════════════════════════════════
const tables = {};      // tableId => Table
const players = {};     // socketId => Player

// ═══════════════════════════════════════
// DECK
// ═══════════════════════════════════════
const SUITS = ['♠','♥','♦','♣'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];

function createDeck() {
  const deck = [];
  for (const suit of SUITS)
    for (const rank of RANKS)
      deck.push({ rank, suit, isRed: suit === '♥' || suit === '♦' });
  return shuffle(deck);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ═══════════════════════════════════════
// TABLE
// ═══════════════════════════════════════
function createTable(tableId, config) {
  return {
    id: tableId,
    config,                    // { type, blinds: [sb, bb], maxPlayers, buyin }
    players: [],               // [{ socketId, wallet, nick, flag, stack, cards, bet, folded, allIn }]
    deck: [],
    community: [],             // 5 community cards
    pot: 0,
    sidePots: [],
    currentBet: 0,
    turnIndex: 0,
    dealerIndex: 0,
    phase: 'waiting',          // waiting | preflop | flop | turn | river | showdown
    turnTimer: null,
    chat: []
  };
}

// ═══════════════════════════════════════
// SOCKET EVENTS
// ═══════════════════════════════════════
io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  // ── Join Table ──
  socket.on('join_table', ({ tableId, wallet, nick, flag, stack }) => {
    if (!tables[tableId]) {
      tables[tableId] = createTable(tableId, {
        type: 'cash', blinds: [2, 5], maxPlayers: 6, buyin: 100
      });
    }
    const table = tables[tableId];
    if (table.players.length >= table.config.maxPlayers) {
      socket.emit('error', { msg: 'Table is full' });
      return;
    }

    const player = { socketId: socket.id, wallet, nick, flag, stack, cards: [], bet: 0, folded: false, allIn: false };
    table.players.push(player);
    players[socket.id] = { tableId, wallet, nick, flag };

    socket.join(tableId);
    io.to(tableId).emit('player_joined', { nick, flag, playerCount: table.players.length });
    io.to(tableId).emit('table_update', sanitizeTable(table, socket.id));

    // Start game if enough players
    if (table.players.length >= 2 && table.phase === 'waiting') {
      setTimeout(() => startHand(tableId), 2000);
    }
  });

  // ── Player Action ──
  socket.on('action', ({ tableId, action, amount }) => {
    const table = tables[tableId];
    if (!table) return;

    const pIdx = table.players.findIndex(p => p.socketId === socket.id);
    if (pIdx !== table.turnIndex) {
      socket.emit('error', { msg: 'Not your turn' });
      return;
    }

    handleAction(tableId, pIdx, action, amount || 0);
  });

  // ── Chat ──
  socket.on('chat', ({ tableId, msg }) => {
    const p = players[socket.id];
    if (!p) return;
    const chatMsg = { flag: p.flag, nick: p.nick, msg, ts: Date.now() };
    if (tables[tableId]) tables[tableId].chat.push(chatMsg);
    io.to(tableId).emit('chat', chatMsg);
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    const p = players[socket.id];
    if (p && tables[p.tableId]) {
      const table = tables[p.tableId];
      const pl = table.players.find(x => x.socketId === socket.id);
      const handInProgress = table.phase && table.phase !== 'waiting' && table.phase !== 'showdown';

      if (pl && handInProgress && !pl.folded) {
        // 핸드 진행 중 연결 끊김 → 자동 폴드 (팟에 넣은 칩은 몰수 = 표준 규칙)
        // "질 것 같으니 끄고 나가기"로 이득 볼 수 없게 함
        pl.folded = true;
        pl.disconnected = true;
        io.to(p.tableId).emit('player_left', { nick: p.nick, reason: 'disconnect_fold' });

        const pIdx = table.players.findIndex(x => x.socketId === socket.id);
        if (table.turnIndex === pIdx) {
          // 자기 차례에 끊김 → 즉시 폴드로 진행
          clearTurnTimer(p.tableId);
          handleAction(p.tableId, pIdx, 'fold', 0);
        } else {
          io.to(p.tableId).emit('table_update', sanitizeTable(table, null));
          checkHandOver(p.tableId);
        }
        // 소켓 매핑만 정리, 좌석은 핸드 종료 후 정리
        pl.socketId = null;
      } else {
        // 대기 중이거나 이미 폴드 → 좌석에서 제거해도 안전
        table.players = table.players.filter(pl => pl.socketId !== socket.id);
        io.to(p.tableId).emit('player_left', { nick: p.nick });
        io.to(p.tableId).emit('table_update', sanitizeTable(table, null));
      }
    }
    delete players[socket.id];
  });
});

// ═══════════════════════════════════════
// GAME LOGIC
// ═══════════════════════════════════════
function startHand(tableId) {
  const table = tables[tableId];
  if (!table || table.players.length < 2) return;

  table.deck = createDeck();
  table.community = [];
  table.pot = 0;
  table.currentBet = 0;
  table.phase = 'preflop';
  table.players.forEach(p => { p.cards = []; p.bet = 0; p.folded = false; p.allIn = false; });

  // Deal 2 cards to each player
  for (let i = 0; i < 2; i++)
    table.players.forEach(p => p.cards.push(table.deck.pop()));

  // Post blinds
  const sb = table.config.blinds[0];
  const bb = table.config.blinds[1];
  const sbIdx = (table.dealerIndex + 1) % table.players.length;
  const bbIdx = (table.dealerIndex + 2) % table.players.length;

  postBlind(table, sbIdx, sb);
  postBlind(table, bbIdx, bb);
  table.currentBet = bb;
  table.turnIndex = (bbIdx + 1) % table.players.length;

  io.to(tableId).emit('hand_start', { dealerIndex: table.dealerIndex });

  // Send private cards
  table.players.forEach(p => {
    io.to(p.socketId).emit('your_cards', { cards: p.cards });
  });

  io.to(tableId).emit('table_update', sanitizeTable(table, null));
  startTurnTimer(tableId);
}

function postBlind(table, idx, amount) {
  const p = table.players[idx];
  const actual = Math.min(amount, p.stack);
  p.stack -= actual;
  p.bet = actual;
  table.pot += actual;
}

function handleAction(tableId, pIdx, action, amount) {
  const table = tables[tableId];
  const player = table.players[pIdx];

  clearTurnTimer(tableId);

  switch (action) {
    case 'fold':
      player.folded = true;
      break;

    case 'check':
      if (player.bet < table.currentBet) {
        // Invalid — treat as fold
        player.folded = true;
      }
      break;

    case 'call': {
      const toCall = Math.min(table.currentBet - player.bet, player.stack);
      player.stack -= toCall;
      player.bet += toCall;
      table.pot += toCall;
      if (player.stack === 0) player.allIn = true;
      break;
    }

    case 'raise': {
      const raiseAmt = Math.max(amount, table.currentBet * 2);
      const actual = Math.min(raiseAmt - player.bet, player.stack);
      player.stack -= actual;
      player.bet += actual;
      table.pot += actual;
      table.currentBet = player.bet;
      if (player.stack === 0) player.allIn = true;
      break;
    }

    case 'allin': {
      const all = player.stack;
      player.stack = 0;
      player.bet += all;
      table.pot += all;
      if (player.bet > table.currentBet) table.currentBet = player.bet;
      player.allIn = true;
      break;
    }
  }

  io.to(tableId).emit('action_taken', { nick: player.nick, flag: player.flag, action, amount: player.bet });
  io.to(tableId).emit('table_update', sanitizeTable(table, null));

  // Check if hand over
  if (checkHandOver(tableId)) return;

  // Advance turn
  advanceTurn(tableId);
}

// 남은 플레이어가 1명이면 그 사람이 팟을 가져가며 핸드 종료.
// 디스커넥트 자동 폴드 후에도 호출되어 "끄고 나가기"가 판을 멈추지 못하게 함.
function checkHandOver(tableId) {
  const table = tables[tableId];
  if (!table) return true;
  const notFolded = table.players.filter(p => !p.folded);
  if (notFolded.length === 1) {
    endHand(tableId, notFolded[0]);
    return true;
  }
  if (notFolded.length === 0) {
    // 이론상 없음 (안전장치)
    table.phase = 'waiting';
    return true;
  }
  return false;
}

function advanceTurn(tableId) {
  const table = tables[tableId];
  const notFolded = table.players.filter(p => !p.folded && !p.allIn);

  // Check if betting round complete
  const bettingDone = notFolded.every(p => p.bet === table.currentBet);

  if (bettingDone) {
    advancePhase(tableId);
    return;
  }

  // Next active player
  let next = (table.turnIndex + 1) % table.players.length;
  let tries = 0;
  while ((table.players[next].folded || table.players[next].allIn) && tries < table.players.length) {
    next = (next + 1) % table.players.length;
    tries++;
  }
  table.turnIndex = next;
  io.to(tableId).emit('turn_change', { turnIndex: next, nick: table.players[next].nick });
  startTurnTimer(tableId);
}

function advancePhase(tableId) {
  const table = tables[tableId];
  table.players.forEach(p => p.bet = 0);
  table.currentBet = 0;

  switch (table.phase) {
    case 'preflop':
      table.phase = 'flop';
      table.community.push(table.deck.pop(), table.deck.pop(), table.deck.pop());
      break;
    case 'flop':
      table.phase = 'turn';
      table.community.push(table.deck.pop());
      break;
    case 'turn':
      table.phase = 'river';
      table.community.push(table.deck.pop());
      break;
    case 'river':
      table.phase = 'showdown';
      showdown(tableId);
      return;
  }

  io.to(tableId).emit('community_cards', { cards: table.community, phase: table.phase });
  io.to(tableId).emit('table_update', sanitizeTable(table, null));

  // First active after dealer
  table.turnIndex = (table.dealerIndex + 1) % table.players.length;
  while (table.players[table.turnIndex].folded) {
    table.turnIndex = (table.turnIndex + 1) % table.players.length;
  }
  startTurnTimer(tableId);
}

function showdown(tableId) {
  const table = tables[tableId];
  const activePlayers = table.players.filter(p => !p.folded);

  // Simple winner: random for now (실제는 hand evaluator 필요)
  const winner = activePlayers[Math.floor(Math.random() * activePlayers.length)];

  io.to(tableId).emit('showdown', {
    players: activePlayers.map(p => ({ nick: p.nick, flag: p.flag, cards: p.cards })),
    community: table.community
  });

  endHand(tableId, winner);
}

function endHand(tableId, winner) {
  const table = tables[tableId];
  const pot = table.pot;

  // Rake: 3%, cap $3 (in USDC cents for display)
  const rake = Math.min(pot * 0.03, 3);
  const winAmount = pot - rake;
  winner.stack += winAmount;

  io.to(tableId).emit('hand_end', {
    winner: { nick: winner.nick, flag: winner.flag },
    pot, rake, winAmount
  });

  // Next hand after delay
  table.dealerIndex = (table.dealerIndex + 1) % table.players.length;
  table.phase = 'waiting';

  // 연결 끊긴 플레이어는 이번 판 폴드 정산 완료 → 다음 판 전에 좌석에서 제거
  table.players = table.players.filter(p => !p.disconnected && p.socketId !== null);

  setTimeout(() => {
    if (tables[tableId] && tables[tableId].players.length >= 2) {
      startHand(tableId);
    }
  }, 5000);
}

// ═══════════════════════════════════════
// TURN TIMER (30초)
// ═══════════════════════════════════════
function startTurnTimer(tableId) {
  clearTurnTimer(tableId);
  let seconds = 30;
  io.to(tableId).emit('timer_start', { seconds });

  tables[tableId].turnTimer = setInterval(() => {
    seconds--;
    io.to(tableId).emit('timer_tick', { seconds });
    if (seconds <= 0) {
      clearTurnTimer(tableId);
      const table = tables[tableId];
      if (table) handleAction(tableId, table.turnIndex, 'fold', 0);
    }
  }, 1000);
}

function clearTurnTimer(tableId) {
  if (tables[tableId]?.turnTimer) {
    clearInterval(tables[tableId].turnTimer);
    tables[tableId].turnTimer = null;
  }
}

// ═══════════════════════════════════════
// SANITIZE (상대방 카드 숨김)
// ═══════════════════════════════════════
function sanitizeTable(table, mySocketId) {
  return {
    ...table,
    turnTimer: null,
    players: table.players.map(p => ({
      nick: p.nick, flag: p.flag,
      stack: p.stack, bet: p.bet,
      folded: p.folded, allIn: p.allIn,
      cardCount: p.cards.length,
      // 본인 카드만 공개
      cards: p.socketId === mySocketId ? p.cards : p.cards.map(() => ({ hidden: true }))
    }))
  };
}

// ═══════════════════════════════════════
// START
// ═══════════════════════════════════════
httpServer.listen(PORT, () => {
  console.log(`IPL Game Server running on port ${PORT}`);
});
