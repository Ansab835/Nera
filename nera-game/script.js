const pieceChoices = [
  { symbol: '●', name: 'Circle' }, { symbol: '▲', name: 'Triangle' },
  { symbol: '★', name: 'Star' }, { symbol: '◆', name: 'Diamond' },
  { symbol: '♥', name: 'Heart' }, { symbol: '■', name: 'Square' }
];

const points = [
  { name: 'top-left', x: 8, y: 8 }, { name: 'top-middle', x: 50, y: 8 }, { name: 'top-right', x: 92, y: 8 },
  { name: 'middle-left', x: 8, y: 50 }, { name: 'center', x: 50, y: 50 }, { name: 'middle-right', x: 92, y: 50 },
  { name: 'bottom-left', x: 8, y: 92 }, { name: 'bottom-middle', x: 50, y: 92 }, { name: 'bottom-right', x: 92, y: 92 }
];
const adjacency = { 0: [1, 3, 4], 1: [0, 2, 4], 2: [1, 4, 5], 3: [0, 4, 6], 4: [0, 1, 2, 3, 5, 6, 7, 8], 5: [2, 4, 8], 6: [3, 4, 7], 7: [4, 6, 8], 8: [4, 5, 7] };
const winningLines = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];

const state = { currentPlayer: 0, gamePhase: 'placement', board: Array(9).fill(null), players: [{ piece: null, remaining: 3 }, { piece: null, remaining: 3 }], selectedPiece: null, gameOver: false, draw: false, muted: false };
const el = id => document.getElementById(id);
const socket = io();
const setupScreen = el('setup-screen'); const gameScreen = el('game-screen'); const boardEl = el('board');
const modeScreen = el('mode-screen'); const onlineMenu = el('online-menu'); const onlineStatus = el('online-status');
let onlineMode = false; let roomCode = null; let playerNumber = null;
let onlineGameReady = false;
let audioContext;

function showScreen(screen) {
  [modeScreen, onlineMenu, onlineStatus, setupScreen, gameScreen].forEach(view => view.classList.add('hidden'));
  screen.classList.remove('hidden');
}
function showSetupScreen() { showScreen(setupScreen); updateSetupChoices(); }
function showOnlineStatus(title, detail, kicker = 'Room status') {
  el('online-status-kicker').textContent = kicker;
  el('online-status-title').textContent = title;
  el('online-status-detail').textContent = detail;
  el('room-code-display').textContent = roomCode || '------';
  el('copy-feedback').textContent = '';
  showScreen(onlineStatus);
}
function showOpponentDisconnected() {
  roomCode = null; playerNumber = null; onlineMode = false;
  el('online-status-kicker').textContent = 'Connection ended';
  el('online-status-title').textContent = 'Opponent disconnected';
  el('room-code-display').textContent = '';
  el('room-code-display').classList.add('hidden');
  el('copy-code').classList.add('hidden');
  el('online-status-detail').textContent = 'Your friend left the game.';
  showScreen(onlineStatus);
}
function resetOnlineStatusControls() {
  el('room-code-display').classList.remove('hidden');
  el('copy-code').classList.remove('hidden');
}

function initSetup() {
  document.querySelectorAll('.piece-options').forEach((container, playerIndex) => {
    container.innerHTML = pieceChoices.map((choice, choiceIndex) => `<button class="piece-option" type="button" data-piece="${choiceIndex}" title="${choice.name}">${choice.symbol}</button>`).join('');
    container.addEventListener('click', event => {
      const button = event.target.closest('.piece-option'); if (!button || button.classList.contains('unavailable')) return;
      if (onlineMode) {
        if (playerIndex !== playerNumber - 1) return invalidAction();
        socket.emit('selectPiece', Number(button.dataset.piece));
        return;
      }
      state.players[playerIndex].piece = Number(button.dataset.piece);
      updateSetupChoices(); playTone('select');
    });
  });
  updateSetupChoices();
}
function updateSetupChoices() {
  document.querySelectorAll('.player-choice').forEach((choiceCard, playerIndex) => {
    const selected = state.players[playerIndex].piece;
    choiceCard.querySelectorAll('.piece-option').forEach(button => {
      const piece = Number(button.dataset.piece); button.classList.toggle('selected', piece === selected); button.classList.toggle('unavailable', piece === state.players[1 - playerIndex].piece && piece !== selected);
    });
    const note = choiceCard.querySelector('.selection-note'); note.textContent = selected === null ? 'Choose a piece' : `${pieceChoices[selected].name} selected`; note.classList.toggle('chosen', selected !== null);
  });
  el('start-game').disabled = onlineMode || state.players.some(player => player.piece === null) || state.players[0].piece === state.players[1].piece;
}
function resetState() {
  state.currentPlayer = 0; state.gamePhase = 'placement'; state.board = Array(9).fill(null); state.selectedPiece = null; state.gameOver = false; state.draw = false;
  state.players.forEach(player => { player.remaining = 3; });
}
function startGame() { if (onlineMode) { showScreen(gameScreen); renderBoard(); updateStatus(); return; } resetState(); setupScreen.classList.add('hidden'); gameScreen.classList.remove('hidden'); renderBoard(); updateStatus(); }
function renderBoard() {
  boardEl.querySelectorAll('.point, .travel-piece').forEach(node => node.remove());
  points.forEach((point, index) => {
    const node = document.createElement('button'); node.className = 'point'; node.dataset.index = index; node.style.left = `${point.x}%`; node.style.top = `${point.y}%`; node.setAttribute('role', 'gridcell');
    const occupant = state.board[index];
    if (occupant !== null) { node.classList.add('occupied'); node.innerHTML = `<span class="piece player-${occupant}">${pieceChoices[state.players[occupant].piece].symbol}</span>`; node.setAttribute('aria-label', `${points[index].name}, Player ${occupant + 1}`); }
    else { node.classList.add('empty'); node.setAttribute('aria-label', `${points[index].name}, empty`); }
    if (state.selectedPiece === index) node.classList.add('selected');
    if (state.gamePhase === 'movement' && state.selectedPiece !== null) { if (adjacency[state.selectedPiece].includes(index) && state.board[index] === null) node.classList.add('valid'); else node.classList.add('invalid'); }
    node.addEventListener('click', () => handlePointClick(index)); boardEl.appendChild(node);
  });
}
function handlePointClick(index) {
  if (state.gameOver) return;
  if (onlineMode) {
    const localPlayerIndex = playerNumber - 1;
    if (state.currentPlayer !== localPlayerIndex) return invalidAction();
    if (state.gamePhase === 'placement') {
      if (state.board[index] !== null || state.players[localPlayerIndex].remaining === 0) return invalidAction();
      socket.emit('placePiece', { position: index });
      return;
    }
    if (state.selectedPiece === null) {
      if (state.board[index] !== localPlayerIndex) return invalidAction();
      state.selectedPiece = index; updateStatus(); renderBoard(); return;
    }
    if (index === state.selectedPiece) { state.selectedPiece = null; updateStatus(); renderBoard(); return; }
    if (state.board[index] === null && adjacency[state.selectedPiece].includes(index)) {
      socket.emit('movePiece', { from: state.selectedPiece, to: index });
      state.selectedPiece = null;
      return;
    }
    return invalidAction();
  }
  if (state.gamePhase === 'placement') { if (state.board[index] !== null || state.players[state.currentPlayer].remaining === 0) return invalidAction(); placePiece(index); return; }
  if (state.selectedPiece === null) { if (state.board[index] !== state.currentPlayer) return invalidAction(); state.selectedPiece = index; updateStatus(); renderBoard(); return; }
  if (index === state.selectedPiece) { state.selectedPiece = null; updateStatus(); renderBoard(); return; }
  if (state.board[index] === null && adjacency[state.selectedPiece].includes(index)) { movePiece(state.selectedPiece, index); return; }
  invalidAction();
}
function placePiece(index) {
  const player = state.currentPlayer;
  state.board[index] = player;
  renderBoard();
  playTone('place');
  state.players[player].remaining -= 1;
  advanceTurn();
}
function movePiece(from, to) {
  const player = state.currentPlayer; const fromPoint = points[from]; const toPoint = points[to];
  state.board[from] = null; state.board[to] = player; state.selectedPiece = null; renderBoard();
  const mover = document.createElement('span'); mover.className = `travel-piece player-${player}`; mover.textContent = pieceChoices[state.players[player].piece].symbol; mover.style.left = `${fromPoint.x}%`; mover.style.top = `${fromPoint.y}%`; boardEl.appendChild(mover);
  const travel = boardEl.querySelector('.travel-piece'); travel.style.left = `${toPoint.x}%`; travel.style.top = `${toPoint.y}%`; playTone('move');
  setTimeout(() => {
    travel.remove();
    const winningLine = checkWinner(player);
    if (winningLine) { finishGame(player, winningLine); return; }
    advanceTurn();
  }, 400);
}
function advanceTurn() {
  if (state.gamePhase === 'placement' && state.players.every(player => player.remaining === 0)) state.gamePhase = 'movement';
  state.currentPlayer = 1 - state.currentPlayer; updateStatus(); renderBoard();
}
function checkWinner(player) { return winningLines.find(line => line.every(index => state.board[index] === player)) || null; }
function finishGame(winner, winnerLine) { state.gameOver = true; document.querySelectorAll('.point').forEach((point, index) => point.classList.toggle('winner', winnerLine.includes(index))); updateStatus(); el('result-title').textContent = `Player ${winner + 1} wins!`; el('result-subtitle').textContent = 'Three in a row.'; el('result-overlay').classList.remove('hidden'); playTone('win'); }
function finishDraw() { if (state.gameOver) return; state.gameOver = true; state.draw = true; state.selectedPiece = null; updateStatus(); el('result-title').textContent = 'Game drawn'; el('result-subtitle').textContent = 'The players called a stalemate.'; el('result-overlay').classList.remove('hidden'); playTone('invalid'); }
function updateStatus() {
  const player = state.currentPlayer; const phase = state.gamePhase === 'placement' ? 'Place a piece' : state.selectedPiece === null ? 'Select a piece to move' : 'Select a destination';
  const turnLabel = onlineMode ? (player === playerNumber - 1 ? 'YOUR TURN' : "OPPONENT'S TURN") : `Player ${player + 1}: ${phase}`;
  el('status-title').textContent = state.draw ? 'Game drawn' : onlineMode ? turnLabel : `Player ${player + 1}: ${phase}`; el('status-detail').textContent = state.draw ? 'The players called a stalemate.' : state.gameOver ? 'The line is complete.' : state.gamePhase === 'placement' ? `Place all three pieces. ${state.players[player].remaining} remaining.` : state.selectedPiece === null ? 'Choose one of your pieces to begin.' : 'Only connected empty points are highlighted.';
  el('board-hint').textContent = state.gamePhase === 'placement' ? 'Place a piece on any open point' : state.selectedPiece === null ? 'Select one of your pieces' : 'Choose a glowing destination';
  document.querySelectorAll('.player-card').forEach((card, index) => { card.classList.toggle('active', index === player && !state.gameOver); card.querySelector('.turn-label').textContent = onlineMode ? (index === playerNumber - 1 ? 'YOU' : 'OPPONENT') : index === player && !state.gameOver ? 'YOUR TURN' : 'WAITING'; card.querySelector('.piece-count').textContent = state.gamePhase === 'placement' ? `${state.players[index].remaining} remaining` : '3 pieces'; card.querySelector('.chosen-piece').textContent = state.players[index].piece === null ? '●' : pieceChoices[state.players[index].piece].symbol; });
}

function applyOnlineGameState(gameState) {
  state.board = [...gameState.board];
  state.currentPlayer = gameState.currentPlayer;
  state.gamePhase = gameState.gamePhase;
  state.gameOver = gameState.gameOver;
  state.draw = false;
  state.selectedPiece = null;
  gameState.remaining.forEach((remaining, index) => { state.players[index].remaining = remaining; });
  gameState.pieces.forEach((piece, index) => { state.players[index].piece = piece; });
  showScreen(gameScreen);
  renderBoard();
  updateStatus();
  document.querySelectorAll('.point').forEach((point, index) => point.classList.toggle('winner', Boolean(gameState.winningLine && gameState.winningLine.includes(index))));
  if (gameState.gameOver) {
    el('result-title').textContent = `Player ${gameState.winner + 1} wins!`;
    el('result-subtitle').textContent = 'Three in a row.';
    el('result-overlay').classList.remove('hidden');
  } else {
    el('result-overlay').classList.add('hidden');
  }
}
function invalidAction() { playTone('invalid'); boardEl.animate([{ transform: 'translateX(-3px)' }, { transform: 'translateX(3px)' }, { transform: 'none' }], { duration: 160 }); }
function playTone(type) { if (state.muted) return; audioContext ??= new (window.AudioContext || window.webkitAudioContext)(); const oscillator = audioContext.createOscillator(); const gain = audioContext.createGain(); const settings = { select: [440, .05], place: [560, .08], move: [680, .1], invalid: [150, .12], win: [820, .28] }[type]; oscillator.frequency.value = settings[0]; oscillator.type = type === 'invalid' ? 'sawtooth' : 'sine'; gain.gain.setValueAtTime(.045, audioContext.currentTime); gain.gain.exponentialRampToValueAtTime(.001, audioContext.currentTime + settings[1]); oscillator.connect(gain); gain.connect(audioContext.destination); oscillator.start(); oscillator.stop(audioContext.currentTime + settings[1]); }

el('start-game').addEventListener('click', startGame); el('draw-game').addEventListener('click', finishDraw); el('new-game').addEventListener('click', () => { if (onlineMode) { socket.emit('restartGame'); return; } state.players.forEach(player => { player.piece = null; }); gameScreen.classList.add('hidden'); el('result-overlay').classList.add('hidden'); setupScreen.classList.remove('hidden'); updateSetupChoices(); }); el('play-again').addEventListener('click', () => { if (onlineMode) { el('result-overlay').classList.add('hidden'); socket.emit('restartGame'); return; } el('result-overlay').classList.add('hidden'); startGame(); }); el('mute-button').addEventListener('click', event => { state.muted = !state.muted; event.currentTarget.setAttribute('aria-pressed', state.muted); event.currentTarget.querySelector('span:last-child').textContent = state.muted ? 'Sound off' : 'Sound on'; });
el('play-local').addEventListener('click', () => { onlineMode = false; resetOnlineStatusControls(); showSetupScreen(); });
el('play-online').addEventListener('click', () => { onlineMode = true; el('join-error').textContent = ''; showScreen(onlineMenu); });
el('online-back').addEventListener('click', () => { onlineMode = false; showScreen(modeScreen); });
el('status-back').addEventListener('click', () => { onlineMode = false; resetOnlineStatusControls(); showScreen(modeScreen); });
el('create-game').addEventListener('click', () => { onlineMode = true; el('create-game').disabled = true; socket.emit('createRoom'); });
el('join-form').addEventListener('submit', event => { event.preventDefault(); const code = el('room-code-input').value.trim().toUpperCase(); if (!code) { el('join-error').textContent = 'Enter a room code.'; return; } onlineMode = true; socket.emit('joinRoom', code); });
el('copy-code').addEventListener('click', async () => { if (!roomCode || !navigator.clipboard) { el('copy-feedback').textContent = 'Copy the code manually.'; return; } try { await navigator.clipboard.writeText(roomCode); el('copy-feedback').textContent = 'Copied.'; } catch { el('copy-feedback').textContent = 'Copy the code manually.'; } });

socket.on('roomCreated', data => { roomCode = data.roomCode; playerNumber = data.playerNumber; el('create-game').disabled = false; resetOnlineStatusControls(); showOnlineStatus('Game created', 'Share this code with your friend. Waiting for Player 2...', 'Room ready'); });
socket.on('roomJoined', data => { roomCode = data.roomCode; playerNumber = data.playerNumber; resetOnlineStatusControls(); showOnlineStatus('Joined game', `You are Player ${playerNumber}. Waiting for game...`, 'Room joined'); });
socket.on('joinError', message => { el('create-game').disabled = false; el('join-error').textContent = message; showScreen(onlineMenu); });
socket.on('roomReady', () => { resetOnlineStatusControls(); showSetupScreen(); });
socket.on('setupUpdate', data => { data.pieces.forEach((piece, index) => { state.players[index].piece = piece; }); updateSetupChoices(); });
socket.on('gameReady', () => { onlineGameReady = true; showScreen(gameScreen); });
socket.on('gameState', applyOnlineGameState);
socket.on('invalidMove', message => { el('board-hint').textContent = message; invalidAction(); });
socket.on('rematchWaiting', () => { el('result-subtitle').textContent = 'Waiting for your opponent to agree to a rematch.'; el('result-overlay').classList.remove('hidden'); });
socket.on('opponentDisconnected', showOpponentDisconnected);
initSetup();
