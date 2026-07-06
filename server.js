const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// In-memory user store (demo only)
const users = {};
const STARTING_BALANCE = 10000;

function getOrCreateUser(id) {
  if (!users[id]) {
    users[id] = { balance: STARTING_BALANCE, bets: [] };
  }
  return users[id];
}

// Provably fair seed generation
function generateServerSeed() {
  return crypto.randomBytes(32).toString('hex');
}

function hashSeed(seed) {
  return crypto.createHash('sha256').update(seed).digest('hex');
}

// ==================== CRASH GAME ====================
let crashState = {
  status: 'waiting', // waiting, running, crashed
  multiplier: 1.00,
  serverSeed: generateServerSeed(),
  crashPoint: 0,
  bets: [],
  history: [],
  timer: null,
  startTime: 0
};

function calculateCrashPoint(seed) {
  const hash = crypto.createHmac('sha256', seed).update('crash').digest('hex');
  const h = parseInt(hash.slice(0, 8), 16);
  const e = Math.pow(2, 32);
  const result = Math.floor((100 * e - h) / (e - h)) / 100;
  return Math.max(1.00, result);
}

function startCrashRound() {
  crashState.serverSeed = generateServerSeed();
  crashState.crashPoint = calculateCrashPoint(crashState.serverSeed);
  crashState.multiplier = 1.00;
  crashState.bets = [];
  crashState.status = 'waiting';

  io.emit('crash:status', {
    status: 'waiting',
    countdown: 5,
    history: crashState.history.slice(-20)
  });

  setTimeout(() => {
    crashState.status = 'running';
    crashState.startTime = Date.now();
    io.emit('crash:status', { status: 'running', multiplier: 1.00 });
    runCrashTick();
  }, 5000);
}

function runCrashTick() {
  if (crashState.status !== 'running') return;

  const elapsed = (Date.now() - crashState.startTime) / 1000;
  crashState.multiplier = Math.pow(Math.E, 0.07 * elapsed);
  crashState.multiplier = Math.round(crashState.multiplier * 100) / 100;

  if (crashState.multiplier >= crashState.crashPoint) {
    crashState.status = 'crashed';
    crashState.multiplier = crashState.crashPoint;

    crashState.bets.forEach(bet => {
      if (!bet.cashedOut) {
        bet.result = 'lost';
      }
    });

    crashState.history.unshift({
      crashPoint: crashState.crashPoint,
      hash: hashSeed(crashState.serverSeed)
    });

    io.emit('crash:crashed', {
      crashPoint: crashState.crashPoint,
      hash: hashSeed(crashState.serverSeed),
      seed: crashState.serverSeed,
      history: crashState.history.slice(-20)
    });

    setTimeout(startCrashRound, 3000);
  } else {
    io.emit('crash:tick', { multiplier: crashState.multiplier });
    setTimeout(runCrashTick, 50);
  }
}

// ==================== DICE GAME ====================
function rollDice(target, isOver, seed) {
  const hash = crypto.createHmac('sha256', seed).update('dice').digest('hex');
  const roll = (parseInt(hash.slice(0, 8), 16) % 10001) / 100;
  return Math.round(roll * 100) / 100;
}

// ==================== MINES GAME ====================
function generateMineField(mineCount, seed) {
  const positions = [];
  for (let i = 0; i < 25; i++) positions.push(i);

  // Shuffle using seed
  for (let i = 24; i > 0; i--) {
    const hash = crypto.createHmac('sha256', seed).update(`mine-${i}`).digest('hex');
    const j = parseInt(hash.slice(0, 8), 16) % (i + 1);
    [positions[i], positions[j]] = [positions[j], positions[i]];
  }

  return new Set(positions.slice(0, mineCount));
}

const mineGames = {};

// ==================== SOCKET HANDLERS ====================
io.on('connection', (socket) => {
  const userId = socket.id;
  const user = getOrCreateUser(userId);

  socket.emit('balance', { balance: user.balance });
  socket.emit('crash:status', {
    status: crashState.status,
    multiplier: crashState.multiplier,
    countdown: crashState.status === 'waiting' ? 5 : 0,
    history: crashState.history.slice(-20)
  });

  // --- CRASH ---
  socket.on('crash:bet', (data) => {
    const amount = parseFloat(data.amount);
    if (!amount || amount <= 0 || amount > user.balance) {
      socket.emit('error', { message: 'Invalid bet amount' });
      return;
    }
    if (crashState.status !== 'waiting') {
      socket.emit('error', { message: 'Round already started' });
      return;
    }
    const existing = crashState.bets.find(b => b.userId === userId);
    if (existing) {
      socket.emit('error', { message: 'Already placed a bet' });
      return;
    }

    user.balance -= amount;
    crashState.bets.push({ userId, amount, cashedOut: false, result: 'pending' });
    socket.emit('balance', { balance: user.balance });
    socket.emit('crash:betPlaced', { amount });
  });

  socket.on('crash:cashout', () => {
    if (crashState.status !== 'running') return;
    const bet = crashState.bets.find(b => b.userId === userId && !b.cashedOut);
    if (!bet) return;

    bet.cashedOut = true;
    bet.cashoutAt = crashState.multiplier;
    bet.result = 'won';
    const winnings = Math.floor(bet.amount * crashState.multiplier * 100) / 100;
    user.balance += winnings;
    socket.emit('balance', { balance: user.balance });
    socket.emit('crash:cashedOut', { multiplier: crashState.multiplier, winnings });
  });

  // --- DICE ---
  socket.on('dice:roll', (data) => {
    const amount = parseFloat(data.amount);
    const target = parseFloat(data.target);
    const isOver = data.isOver;

    if (!amount || amount <= 0 || amount > user.balance) {
      socket.emit('error', { message: 'Invalid bet amount' });
      return;
    }
    if (target < 1 || target > 98) {
      socket.emit('error', { message: 'Target must be between 1 and 98' });
      return;
    }

    const seed = generateServerSeed();
    const roll = rollDice(target, isOver, seed);
    const winChance = isOver ? (100 - target) : target;
    const multiplier = Math.floor((99 / winChance) * 100) / 100;
    const won = isOver ? (roll > target) : (roll < target);

    user.balance -= amount;
    if (won) {
      const winnings = Math.floor(amount * multiplier * 100) / 100;
      user.balance += winnings;
    }

    socket.emit('balance', { balance: user.balance });
    socket.emit('dice:result', {
      roll,
      target,
      isOver,
      won,
      multiplier,
      amount,
      winnings: won ? Math.floor(amount * multiplier * 100) / 100 : 0,
      hash: hashSeed(seed),
      seed
    });
  });

  // --- MINES ---
  socket.on('mines:start', (data) => {
    const amount = parseFloat(data.amount);
    const mineCount = parseInt(data.mines) || 3;

    if (!amount || amount <= 0 || amount > user.balance) {
      socket.emit('error', { message: 'Invalid bet amount' });
      return;
    }
    if (mineCount < 1 || mineCount > 24) {
      socket.emit('error', { message: 'Mine count must be 1-24' });
      return;
    }

    const seed = generateServerSeed();
    const mines = generateMineField(mineCount, seed);

    user.balance -= amount;
    mineGames[userId] = {
      amount,
      mineCount,
      mines,
      revealed: new Set(),
      seed,
      active: true,
      currentMultiplier: 1.00
    };

    socket.emit('balance', { balance: user.balance });
    socket.emit('mines:started', { mineCount, betAmount: amount });
  });

  socket.on('mines:reveal', (data) => {
    const game = mineGames[userId];
    if (!game || !game.active) {
      socket.emit('error', { message: 'No active game' });
      return;
    }

    const tile = parseInt(data.tile);
    if (tile < 0 || tile > 24 || game.revealed.has(tile)) {
      socket.emit('error', { message: 'Invalid tile' });
      return;
    }

    if (game.mines.has(tile)) {
      game.active = false;
      socket.emit('mines:boom', {
        tile,
        mines: Array.from(game.mines),
        seed: game.seed,
        hash: hashSeed(game.seed)
      });
      delete mineGames[userId];
    } else {
      game.revealed.add(tile);
      const safeTotal = 25 - game.mineCount;
      const revealedCount = game.revealed.size;

      // Calculate multiplier based on tiles revealed
      let mult = 1;
      for (let i = 0; i < revealedCount; i++) {
        mult *= (25 - i) / (25 - game.mineCount - i);
      }
      mult = Math.floor(mult * 0.97 * 100) / 100; // 3% house edge
      game.currentMultiplier = mult;

      socket.emit('mines:safe', {
        tile,
        multiplier: mult,
        revealed: revealedCount,
        potential: Math.floor(game.amount * mult * 100) / 100
      });

      if (revealedCount >= safeTotal) {
        // All safe tiles revealed - auto cashout
        const winnings = Math.floor(game.amount * mult * 100) / 100;
        user.balance += winnings;
        game.active = false;
        socket.emit('balance', { balance: user.balance });
        socket.emit('mines:cashout', {
          winnings,
          multiplier: mult,
          mines: Array.from(game.mines),
          seed: game.seed
        });
        delete mineGames[userId];
      }
    }
  });

  socket.on('mines:cashout', () => {
    const game = mineGames[userId];
    if (!game || !game.active || game.revealed.size === 0) {
      socket.emit('error', { message: 'Cannot cashout' });
      return;
    }

    const winnings = Math.floor(game.amount * game.currentMultiplier * 100) / 100;
    user.balance += winnings;
    game.active = false;

    socket.emit('balance', { balance: user.balance });
    socket.emit('mines:cashout', {
      winnings,
      multiplier: game.currentMultiplier,
      mines: Array.from(game.mines),
      seed: game.seed,
      hash: hashSeed(game.seed)
    });
    delete mineGames[userId];
  });

  // --- SLOTS ---
  socket.on('slots:spin', (data) => {
    const amount = parseFloat(data.amount);
    if (!amount || amount <= 0 || amount > user.balance) {
      socket.emit('error', { message: 'Invalid bet amount' });
      return;
    }

    const seed = generateServerSeed();
    const SYMBOLS = ['7', 'BAR', 'cherry', 'lemon', 'orange', 'plum', 'bell', 'diamond'];
    const WEIGHTS = [1, 2, 4, 5, 5, 4, 3, 2]; // rarer symbols have lower weight
    const totalWeight = WEIGHTS.reduce((a, b) => a + b, 0);

    function pickSymbol(seedStr, col) {
      const hash = crypto.createHmac('sha256', seedStr).update(`slot-${col}`).digest('hex');
      let val = parseInt(hash.slice(0, 8), 16) % totalWeight;
      for (let i = 0; i < SYMBOLS.length; i++) {
        val -= WEIGHTS[i];
        if (val < 0) return { symbol: SYMBOLS[i], index: i };
      }
      return { symbol: SYMBOLS[0], index: 0 };
    }

    const reels = [];
    for (let col = 0; col < 5; col++) {
      const row = [];
      for (let r = 0; r < 3; r++) {
        row.push(pickSymbol(seed, col * 3 + r));
      }
      reels.push(row);
    }

    // Middle row is the payline
    const payline = reels.map(col => col[1]);
    const paylineSymbols = payline.map(s => s.symbol);

    // Calculate win
    let winMultiplier = 0;
    const counts = {};
    paylineSymbols.forEach(s => { counts[s] = (counts[s] || 0) + 1; });

    // 5 of a kind
    if (Object.values(counts).includes(5)) {
      const sym = Object.keys(counts).find(k => counts[k] === 5);
      if (sym === '7') winMultiplier = 100;
      else if (sym === 'diamond') winMultiplier = 50;
      else if (sym === 'BAR') winMultiplier = 25;
      else if (sym === 'bell') winMultiplier = 15;
      else winMultiplier = 10;
    }
    // 4 of a kind
    else if (Object.values(counts).includes(4)) {
      const sym = Object.keys(counts).find(k => counts[k] === 4);
      if (sym === '7') winMultiplier = 20;
      else if (sym === 'diamond') winMultiplier = 12;
      else if (sym === 'BAR') winMultiplier = 8;
      else winMultiplier = 5;
    }
    // 3 of a kind
    else if (Object.values(counts).includes(3)) {
      const sym = Object.keys(counts).find(k => counts[k] === 3);
      if (sym === '7') winMultiplier = 5;
      else if (sym === 'diamond') winMultiplier = 3;
      else winMultiplier = 2;
    }
    // Two pair
    else if (Object.values(counts).filter(c => c === 2).length === 2) {
      winMultiplier = 1.5;
    }

    user.balance -= amount;
    const won = winMultiplier > 0;
    let winnings = 0;
    if (won) {
      winnings = Math.floor(amount * winMultiplier * 100) / 100;
      user.balance += winnings;
    }

    const grid = reels.map(col => col.map(s => s.symbol));

    socket.emit('balance', { balance: user.balance });
    socket.emit('slots:result', {
      grid,
      payline: paylineSymbols,
      won,
      winMultiplier,
      winnings,
      amount,
      hash: hashSeed(seed),
      seed
    });
  });

  // --- RESET ---
  socket.on('reset-balance', () => {
    user.balance = STARTING_BALANCE;
    socket.emit('balance', { balance: user.balance });
  });

  socket.on('disconnect', () => {
    delete mineGames[userId];
  });
});

// Start crash game loop
startCrashRound();

const PORT = process.env.PORT || 3777;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Gambling demo running on port ${PORT}`);
});
