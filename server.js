const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "nera-game")));

// Store active rooms
const rooms = {};
const winningLines = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
const adjacency = { 0: [1, 3, 4], 1: [0, 2, 4], 2: [1, 4, 5], 3: [0, 4, 6], 4: [0, 1, 2, 3, 5, 6, 7, 8], 5: [2, 4, 8], 6: [3, 4, 7], 7: [4, 6, 8], 8: [4, 5, 7] };
const RECONNECT_GRACE_MS = 30000;

function createGameState() {
    return {
        pieces: [null, null],
        board: Array(9).fill(null),
        currentPlayer: 0,
        gamePhase: "placement",
        remaining: [3, 3],
        gameOver: false,
        winner: null,
        winningLine: null,
        rematchRequests: []
    };
}

function broadcastGameState(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    io.to(roomCode).emit("gameState", publicGameState(room));
}

function publicGameState(room) {
    const game = room.game;
    return {
        board: game.board,
        currentPlayer: game.currentPlayer,
        gamePhase: game.gamePhase,
        remaining: game.remaining,
        gameOver: game.gameOver,
        winner: game.winner,
        winningLine: game.winningLine,
        pieces: game.pieces
    };
}

function findWinner(board, player) {
    return winningLines.find(line => line.every(position => board[position] === player)) || null;
}

function playerIndex(room, socket) {
    return room.players.indexOf(socket.id);
}

function roomForSocket(socket) {
    const roomCode = socket.data.roomCode;
    const room = roomCode ? rooms[roomCode] : null;
    const player = room && room.players.indexOf(socket.id);
    return room && player >= 0 ? { roomCode, room, player } : null;
}

function logAction(roomCode, player, action, room) {
    console.log(`[${roomCode}] Player ${player + 1} ${action}`, {
        board: room.game.board,
        currentPlayer: room.game.currentPlayer,
        gamePhase: room.game.gamePhase
    });
}

function emitStateToSocket(socket, room) {
    socket.emit("gameState", publicGameState(room));
}

function resetRoomGame(room) {
    const pieces = [...room.game.pieces];
    room.game = {
        ...createGameState(),
        pieces,
        rematchRequests: []
    };
}

function resetRoomForNewGame(room) {
    room.game = createGameState();
}

function generateRoomCode() {
    const characters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";

    for (let i = 0; i < 6; i++) {
        code += characters[Math.floor(Math.random() * characters.length)];
    }

    return code;
}

io.on("connection", (socket) => {

    console.log("Player connected:", socket.id);

    // CREATE ROOM
    socket.on("createRoom", () => {

        let roomCode;

        do {
            roomCode = generateRoomCode();
        } while (rooms[roomCode]);

        rooms[roomCode] = {
            players: [socket.id, null],
            sessions: [crypto.randomUUID(), null],
            disconnectTimers: [null, null],
            game: createGameState()
        };

        socket.join(roomCode);
        socket.data.roomCode = roomCode;
        socket.data.player = 0;

        socket.emit("roomCreated", {
            roomCode: roomCode,
            playerNumber: 1,
            sessionToken: rooms[roomCode].sessions[0]
        });

        console.log(`Room created: ${roomCode}`);
    });

    // JOIN ROOM
    socket.on("joinRoom", (roomCode) => {

        roomCode = roomCode.toUpperCase().trim();

        const room = rooms[roomCode];

        if (!room) {
            socket.emit("joinError", "Room not found.");
            return;
        }

        const player = room.players.findIndex(playerSocket => playerSocket === null);
        if (player < 0 || room.disconnectTimers.some(timer => timer !== null)) {
            socket.emit("joinError", "Room is already full.");
            return;
        }

        room.players[player] = socket.id;
        room.sessions[player] = crypto.randomUUID();

        socket.join(roomCode);
        socket.data.roomCode = roomCode;
        socket.data.player = player;

        socket.emit("roomJoined", {
            roomCode: roomCode,
            playerNumber: player + 1,
            sessionToken: room.sessions[player]
        });

        // Tell both players that the room is ready
        io.to(roomCode).emit("roomReady");
        broadcastGameState(roomCode);

        console.log(`Player 2 joined room: ${roomCode}`);
    });

    socket.on("resumeRoom", data => {
        const code = data && typeof data.roomCode === "string" ? data.roomCode.toUpperCase().trim() : "";
        const room = rooms[code];
        const player = room && data && typeof data.sessionToken === "string" ? room.sessions.indexOf(data.sessionToken) : -1;
        if (!room || player < 0) {
            socket.emit("resumeError");
            return;
        }
        if (room.disconnectTimers[player]) clearTimeout(room.disconnectTimers[player]);
        room.disconnectTimers[player] = null;
        room.players[player] = socket.id;
        socket.join(code);
        socket.data.roomCode = code;
        socket.data.player = player;
        socket.emit("roomResumed", { roomCode: code, playerNumber: player + 1 });
        broadcastGameState(code);
        console.log(`[${code}] Player ${player + 1} resumed on socket ${socket.id}`);
    });

    socket.on("requestGameState", () => {
        const membership = roomForSocket(socket);
        if (membership) {
            emitStateToSocket(socket, membership.room);
            console.log(`[${membership.roomCode}] State requested by Player ${membership.player + 1}`);
        }
    });

    socket.on("selectPiece", (pieceIndex, acknowledge) => {
        const membership = roomForSocket(socket);
        if (!membership) return typeof acknowledge === "function" && acknowledge({ ok: false, message: "You are not in a game room." });
        const { roomCode, room, player } = membership;
        if (room.players.some(playerSocket => playerSocket === null) || room.game.board.some(position => position !== null) || !Number.isInteger(pieceIndex) || pieceIndex < 0 || pieceIndex > 5) {
            socket.emit("invalidMove", "Invalid piece selection.");
            return typeof acknowledge === "function" && acknowledge({ ok: false, message: "Invalid piece selection." });
        }
        if (room.game.pieces[1 - player] === pieceIndex) {
            socket.emit("invalidMove", "That piece is already selected.");
            return typeof acknowledge === "function" && acknowledge({ ok: false, message: "That piece is already selected." });
        }
        room.game.pieces[player] = pieceIndex;
        io.to(roomCode).emit("setupUpdate", { pieces: room.game.pieces });
        logAction(roomCode, player, `selected piece ${pieceIndex}`, room);
        broadcastGameState(roomCode);
        if (room.game.pieces.every(piece => piece !== null)) io.to(roomCode).emit("gameReady");
        if (typeof acknowledge === "function") acknowledge({ ok: true });
    });

    socket.on("placePiece", (data, acknowledge) => {
        const membership = roomForSocket(socket);
        if (!membership) return typeof acknowledge === "function" && acknowledge({ ok: false, message: "You are not in a game room." });
        const { roomCode, room, player } = membership;
        const position = data && data.position;
        const game = room.game;
        if (game.gameOver || game.gamePhase !== "placement" || game.currentPlayer !== player || !Number.isInteger(position) || position < 0 || position > 8 || game.board[position] !== null || game.remaining[player] === 0) {
            socket.emit("invalidMove", "Invalid move.");
            return typeof acknowledge === "function" && acknowledge({ ok: false, message: "Invalid move." });
        }
        game.board[position] = player;
        game.remaining[player]--;
        const winningLine = findWinner(game.board, player);
        if (winningLine) {
            game.gameOver = true;
            game.winner = player;
            game.winningLine = winningLine;
        } else if (game.remaining[0] === 0 && game.remaining[1] === 0) {
            game.gamePhase = "movement";
            game.currentPlayer = 1 - player;
        } else {
            game.currentPlayer = 1 - player;
        }
        logAction(roomCode, player, `placed at ${position}`, room);
        broadcastGameState(roomCode);
        if (typeof acknowledge === "function") acknowledge({ ok: true });
    });

    socket.on("movePiece", (data, acknowledge) => {
        const membership = roomForSocket(socket);
        if (!membership) return typeof acknowledge === "function" && acknowledge({ ok: false, message: "You are not in a game room." });
        const { roomCode, room, player } = membership;
        const from = data && data.from;
        const to = data && data.to;
        const game = room.game;
        if (game.gameOver || game.gamePhase !== "movement" || game.currentPlayer !== player || !Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from > 8 || to < 0 || to > 8 || game.board[from] !== player || game.board[to] !== null || !adjacency[from].includes(to)) {
            socket.emit("invalidMove", "Invalid move.");
            return typeof acknowledge === "function" && acknowledge({ ok: false, message: "Invalid move." });
        }
        game.board[from] = null;
        game.board[to] = player;
        const winningLine = findWinner(game.board, player);
        if (winningLine) {
            game.gameOver = true;
            game.winner = player;
            game.winningLine = winningLine;
        } else {
            game.currentPlayer = 1 - player;
        }
        logAction(roomCode, player, `moved from ${from} to ${to}`, room);
        broadcastGameState(roomCode);
        if (typeof acknowledge === "function") acknowledge({ ok: true });
    });

    socket.on("restartGame", acknowledge => {
        for (const roomCode in rooms) {
            const room = rooms[roomCode];
            const player = playerIndex(room, socket);
            if (player < 0) return typeof acknowledge === "function" && acknowledge({ ok: false, message: "You are not in a game room." });
            if (!room.game.rematchRequests.includes(player)) room.game.rematchRequests.push(player);
            if (room.game.rematchRequests.length === 2) {
                resetRoomGame(room);
                io.to(roomCode).emit("roomReady");
                io.to(roomCode).emit("setupUpdate", { pieces: room.game.pieces });
                broadcastGameState(roomCode);
                if (typeof acknowledge === "function") acknowledge({ ok: true });
            } else {
                socket.emit("rematchWaiting");
                if (typeof acknowledge === "function") acknowledge({ ok: true });
            }
            return;
        }
    });

    socket.on("playAgain", acknowledge => {
        const membership = roomForSocket(socket);
        if (!membership) {
            if (typeof acknowledge === "function") acknowledge({ ok: false, message: "You are not in a game room." });
            return;
        }
        resetRoomGame(membership.room);
        logAction(membership.roomCode, membership.player, "requested Play Again", membership.room);
        broadcastGameState(membership.roomCode);
        if (typeof acknowledge === "function") acknowledge({ ok: true });
    });

    socket.on("newGame", acknowledge => {
        const membership = roomForSocket(socket);
        if (!membership) {
            if (typeof acknowledge === "function") acknowledge({ ok: false, message: "You are not in a game room." });
            return;
        }
        resetRoomForNewGame(membership.room);
        logAction(membership.roomCode, membership.player, "requested New Game", membership.room);
        io.to(membership.roomCode).emit("setupUpdate", { pieces: membership.room.game.pieces });
        broadcastGameState(membership.roomCode);
        if (typeof acknowledge === "function") acknowledge({ ok: true });
    });

    // DISCONNECT
    socket.on("disconnect", () => {

        console.log("Player disconnected:", socket.id);

        for (const roomCode in rooms) {

            const room = rooms[roomCode];

            if (room.players.includes(socket.id)) {

                const player = room.players.indexOf(socket.id);
                room.players[player] = null;
                console.log(`[${roomCode}] Player ${player + 1} disconnected; keeping state for ${RECONNECT_GRACE_MS}ms`);
                room.disconnectTimers[player] = setTimeout(() => {
                    if (!rooms[roomCode] || rooms[roomCode].players[player] !== null) return;
                    room.sessions[player] = null;
                    room.disconnectTimers[player] = null;
                    io.to(roomCode).emit("opponentDisconnected");
                    if (room.players.every(playerSocket => playerSocket === null)) {
                        delete rooms[roomCode];
                        console.log(`Room deleted: ${roomCode}`);
                    }
                }, RECONNECT_GRACE_MS);

                break;
            }
        }
    });

});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`Nera server running on port ${PORT}`);
});