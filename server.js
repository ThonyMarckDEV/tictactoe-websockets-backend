const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const corsOptions = {
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
};
app.use(cors(corsOptions));

const server = http.createServer(app);
const io = new Server(server, {
  cors: corsOptions,
  pingTimeout: 60000,
  pingInterval: 25000
});

const gameRooms = new Map();

io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  // Create Room Handler
  socket.on('createRoom', (username) => {
    try {
      const roomId = Math.random().toString(36).substring(7);
      
      const roomData = {
        id: roomId,
        players: [
          { 
            id: socket.id, 
            username, 
            symbol: 'X' 
          }
        ],
        board: new Array(9).fill(null),
        currentPlayerIndex: 0,
        status: 'waiting'
      };

      gameRooms.set(roomId, roomData);
      socket.join(roomId);
      
      socket.emit('roomCreated', {
        roomId,
        roomDetails: roomData
      });
      
      console.log(`Room created: ${roomId} by ${username}`);
    } catch (error) {
      console.error('Room creation error:', error);
      socket.emit('roomError', 'Failed to create room');
    }
  });

  // Join Room Handler
  socket.on('joinRoom', ({ roomId, username }) => {
    try {
      const room = gameRooms.get(roomId);
      
      if (!room) {
        return socket.emit('roomError', 'Room not found');
      }
      
      if (room.players.length >= 2) {
        return socket.emit('roomError', 'Room is full');
      }

      // Add second player
      room.players.push({
        id: socket.id,
        username,
        symbol: 'O'
      });
      room.status = 'playing';

      socket.join(roomId);
      
      // Broadcast game start
      io.to(roomId).emit('gameStarted', room);
      
      console.log(`Player ${username} joined room: ${roomId}`);
    } catch (error) {
      console.error('Join room error:', error);
      socket.emit('roomError', 'Failed to join room');
    }
  });

  // Chat Message Handler
  socket.on('sendChatMessage', ({ roomId, username, message }) => {
    try {
      io.to(roomId).emit('receiveChatMessage', {
        username,
        message,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Chat message error:', error);
    }
  });

  // Make Move Handler
  socket.on('makeMove', ({ roomId, position }) => {
    try {
      const room = gameRooms.get(roomId);
      if (!room) return;

      const currentPlayer = room.players[room.currentPlayerIndex];

      if (socket.id === currentPlayer.id && room.board[position] === null) {
        room.board[position] = currentPlayer.symbol;

        // Win check
        const winPatterns = [
          [0,1,2], [3,4,5], [6,7,8],  // Rows
          [0,3,6], [1,4,7], [2,5,8],  // Columns
          [0,4,8], [2,4,6]  // Diagonals
        ];

        const winner = winPatterns.some(pattern =>
          pattern.every(index => room.board[index] === currentPlayer.symbol)
        );

        if (winner) {
          room.status = 'finished';
          io.to(roomId).emit('gameEnded', {
            winner: currentPlayer.username,
            board: room.board
          });
        } else {
          // Draw check
          const isDraw = room.board.every(cell => cell !== null);
          if (isDraw) {
            room.status = 'draw';
            io.to(roomId).emit('gameEnded', {
              winner: 'Draw',
              board: room.board
            });
          } else {
            // Switch player
            room.currentPlayerIndex = 1 - room.currentPlayerIndex;
          }
        }

        io.to(roomId).emit('updateGame', room);
      }
    } catch (error) {
      console.error('Make move error:', error);
    }
  });

  socket.on('requestRematch', ({ roomId, username }) => {
    try {
      const room = gameRooms.get(roomId);
      if (!room) return;
  
      // Initialize rematch tracking if it doesn't exist
      if (!room.rematchRequests) {
        room.rematchRequests = new Set();
        room.rematchPlayers = [];
      }
  
      // Check if this player has already requested rematch
      if (!room.rematchRequests.has(socket.id)) {
        // Add current player to rematch requests
        room.rematchRequests.add(socket.id);
        room.rematchPlayers.push(username);
  
        // Update rematch status
        const rematchStatus = {
          current: room.rematchRequests.size,
          total: 2,
          players: room.rematchPlayers
        };
  
        // Notify all players about rematch status
        io.to(roomId).emit('rematchUpdate', rematchStatus);
  
        // If both players accepted
        if (room.rematchRequests.size === 2) {
          // Reset game state
          room.board = new Array(9).fill(null);
          room.status = 'playing';
          room.currentPlayerIndex = 0;
          room.rematchRequests.clear();
          room.rematchPlayers = [];
  
          // Notify start of new game
          io.to(roomId).emit('gameStarted', room);
        }
      }
    } catch (error) {
      console.error('Rematch error:', error);
    }
  });

  // Modify existing disconnect handler
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    
    for (const [roomId, room] of gameRooms.entries()) {
      const playerIndex = room.players.findIndex(p => p.id === socket.id);
      
      if (playerIndex !== -1) {
        // Remove the player from the room
        room.players.splice(playerIndex, 1);
        
        if (room.players.length === 0) {
          // Remove the room if empty
          gameRooms.delete(roomId);
        } else {
          // Notify remaining player about disconnection
          io.to(roomId).emit('playerLeft', { 
            username: room.players[0].username,
            intentionalExit: false 
          });
        }
        break;
      }
    }
  });

});

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});