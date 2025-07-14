require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const mysql = require('mysql2/promise');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const port = process.env.PORT || 3001;

// Database connection pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'safemedb',
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Test database connection on startup
async function testDbConnection() {
  try {
    const connection = await pool.getConnection();
    console.log('Successfully connected to MySQL database');
    connection.release();
  } catch (error) {
    console.error('Failed to connect to MySQL:', error.message);
    process.exit(1);
  }
}
testDbConnection();

// WebSocket server
const wss = new WebSocket.Server({ port: 3002 });

// Store active game rooms and their WebSocket clients
const gameRooms = new Map();

// Function to get player data from database
async function getPlayerData(idUsuario) {
  try {
    const [result] = await pool.query(
      'SELECT u.user_code, d.nombre, d.perfil FROM usuarios u LEFT JOIN datos d ON u.idDatos = d.idDatos WHERE u.idUsuario = ?',
      [idUsuario]
    );
    
    if (result.length > 0) {
      return {
        id: idUsuario,
        name: result[0].nombre || 'Player',
        picture: result[0].perfil || 'https://placehold.co/50x50'
      };
    }
    return {
      id: idUsuario,
      name: 'Player',
      picture: 'https://placehold.co/50x50'
    };
  } catch (error) {
    console.error('Error getting player data:', error);
    return {
      id: idUsuario,
      name: 'Player',
      picture: 'https://placehold.co/50x50'
    };
  }
}

// Function to send player data to both players
async function sendPlayerDataToRoom(room, idPartida) {
  const player1Data = await getPlayerData(room.player1);
  const player2Data = room.player2 ? await getPlayerData(room.player2) : {
    id: null,
    name: 'Esperando oponente...',
    picture: 'https://placehold.co/50x50'
  };

  const playerDataMessage = JSON.stringify({
    type: 'playerData',
    player1: player1Data,
    player2: player2Data
  });

  // Send to both players
  if (room.player1Ws && room.player1Ws.readyState === WebSocket.OPEN) {
    room.player1Ws.send(playerDataMessage);
  }
  if (room.player2Ws && room.player2Ws.readyState === WebSocket.OPEN) {
    room.player2Ws.send(playerDataMessage);
  }
}

// Handle WebSocket connections
wss.on('connection', (ws, req) => {
  console.log('Nueva conexión WebSocket establecida');

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      console.log('Mensaje recibido:', data.type);

      if (data.type === 'join') {
        const { idPartida, idUsuario } = data;
        let room = gameRooms.get(idPartida);

        console.log(`Usuario ${idUsuario} intentando unirse a partida ${idPartida}`);

        if (!room) {
          // Create new room if it doesn't exist
          room = {
            player1: idUsuario,
            player1Ws: ws,
            player2: null,
            player2Ws: null,
            board: Array(9).fill(null),
            isXNext: true,
            status: 'waiting',
            messages: []
          };
          gameRooms.set(idPartida, room);

          console.log(`Nueva sala creada para partida ${idPartida}`);

          // Create partida in database
          await pool.query(
            'INSERT INTO partidas (idPartida, juego, idUsuario, estado, created_at, updated_at) VALUES (?, ?, ?, 1, NOW(), NOW())',
            [idPartida, 'Triki', idUsuario]
          );

          // Send initial player data
          await sendPlayerDataToRoom(room, idPartida);
        } else if (room.player1 !== idUsuario && !room.player2) {
          // Join as second player
          room.player2 = idUsuario;
          room.player2Ws = ws;
          room.status = 'playing';

          console.log(`Usuario ${idUsuario} se unió como jugador 2`);

          // Update partida with idAmigo
          await pool.query(
            'UPDATE partidas SET idAmigo = ?, updated_at = NOW() WHERE idPartida = ?',
            [idUsuario, idPartida]
          );

          // Send updated player data to both players
          await sendPlayerDataToRoom(room, idPartida);

          // Send previous messages to new player
          if (room.messages.length > 0) {
            room.messages.forEach(msg => {
              if (room.player2Ws && room.player2Ws.readyState === WebSocket.OPEN) {
                room.player2Ws.send(JSON.stringify({
                  type: 'chat',
                  message: msg
                }));
              }
            });
          }

          // Notify both players to start the game
          const startMessage = JSON.stringify({ 
            type: 'start', 
            board: room.board, 
            isXNext: room.isXNext 
          });
          
          if (room.player1Ws && room.player1Ws.readyState === WebSocket.OPEN) {
            room.player1Ws.send(startMessage);
          }
          if (room.player2Ws && room.player2Ws.readyState === WebSocket.OPEN) {
            room.player2Ws.send(startMessage);
          }
        } else if (room.player1 === idUsuario || room.player2 === idUsuario) {
          // Player reconnecting
          console.log(`Usuario ${idUsuario} reconectándose`);
          
          if (room.player1 === idUsuario) {
            room.player1Ws = ws;
          } else {
            room.player2Ws = ws;
          }
          
          // Send current player data and game state
          await sendPlayerDataToRoom(room, idPartida);
          
          // Send previous messages to reconnected player
          if (room.messages.length > 0) {
            room.messages.forEach(msg => {
              if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                  type: 'chat',
                  message: msg
                }));
              }
            });
          }
          
          const gameStateMessage = JSON.stringify({
            type: room.status === 'playing' ? 'start' : 'waiting',
            board: room.board,
            isXNext: room.isXNext
          });
          
          ws.send(gameStateMessage);
        }
      }

      if (data.type === 'move') {
        const { idPartida, index, idUsuario } = data;
        const room = gameRooms.get(idPartida);

        if (!room || room.status !== 'playing') return;
        if ((room.isXNext && idUsuario !== room.player1) || (!room.isXNext && idUsuario !== room.player2)) return;

        if (!room.board[index]) {
          room.board[index] = room.isXNext ? 'X' : 'O';
          room.isXNext = !room.isXNext;

          console.log(`Movimiento realizado en posición ${index} por usuario ${idUsuario}`);

          // Broadcast move to both players
          const moveMessage = JSON.stringify({ 
            type: 'move', 
            board: room.board, 
            isXNext: room.isXNext 
          });
          
          if (room.player1Ws && room.player1Ws.readyState === WebSocket.OPEN) {
            room.player1Ws.send(moveMessage);
          }
          if (room.player2Ws && room.player2Ws.readyState === WebSocket.OPEN) {
            room.player2Ws.send(moveMessage);
          }

          // Check for winner
          const winner = calculateWinner(room.board);
          if (winner || !room.board.includes(null)) {
            room.status = 'finished';
            const idGanador = winner ? (winner === 'X' ? room.player1 : room.player2) : null;
            
            console.log(`Juego terminado. Ganador: ${idGanador}`);
            
            // Update database
            await pool.query(
              'UPDATE partidas SET idGanador = ?, estado = 2, updated_at = NOW() WHERE idPartida = ?',
              [idGanador, idPartida]
            );

            const gameOverMessage = JSON.stringify({ 
              type: 'gameOver', 
              winner, 
              idGanador 
            });
            
            if (room.player1Ws && room.player1Ws.readyState === WebSocket.OPEN) {
              room.player1Ws.send(gameOverMessage);
            }
            if (room.player2Ws && room.player2Ws.readyState === WebSocket.OPEN) {
              room.player2Ws.send(gameOverMessage);
            }
          }
        }
      }

      if (data.type === 'chat') {
        const { idPartida, message } = data;
        const room = gameRooms.get(idPartida);
        
        if (room) {
          // Store message in room's message history
          room.messages.push(message);
          
          console.log(`Mensaje de chat de ${message.user}: ${message.text}`);
          
          const messageStr = JSON.stringify({ 
            type: 'chat', 
            message: message 
          });
          
          // Send to both players
          if (room.player1Ws && room.player1Ws.readyState === WebSocket.OPEN) {
            room.player1Ws.send(messageStr);
          }
          if (room.player2Ws && room.player2Ws.readyState === WebSocket.OPEN) {
            room.player2Ws.send(messageStr);
          }
        }
      }
    } catch (error) {
      console.error('Error en mensaje WebSocket:', error.message);
    }
  });

  ws.on('close', async () => {
    console.log('Conexión WebSocket cerrada');
    
    try {
      for (const [idPartida, room] of gameRooms) {
        if (room.player1Ws === ws || room.player2Ws === ws) {
          const disconnectedPlayer = room.player1Ws === ws ? room.player1 : room.player2;
          const remainingPlayer = room.player1Ws === ws ? room.player2 : room.player1;
          const remainingWs = room.player1Ws === ws ? room.player2Ws : room.player1Ws;
          
          console.log(`Usuario ${disconnectedPlayer} desconectado de partida ${idPartida}`);
          
          if (room.status === 'playing' && remainingPlayer) {
            // Update database with winner (the remaining player)
            await pool.query(
              'UPDATE partidas SET idGanador = ?, estado = 2, updated_at = NOW() WHERE idPartida = ?',
              [remainingPlayer, idPartida]
            );

            // Notify remaining player
            if (remainingWs && remainingWs.readyState === WebSocket.OPEN) {
              remainingWs.send(JSON.stringify({ 
                type: 'gameOver', 
                winner: remainingPlayer === room.player1 ? 'X' : 'O', 
                idGanador: remainingPlayer,
                reason: 'opponent_disconnected'
              }));
            }
          }
          
          // Don't delete the room immediately, keep it for potential reconnection
          // Only delete if both players are disconnected
          if (room.player1Ws === ws) {
            room.player1Ws = null;
          }
          if (room.player2Ws === ws) {
            room.player2Ws = null;
          }
          
          // If both players are disconnected, clean up the room after a timeout
          if (!room.player1Ws && !room.player2Ws) {
            setTimeout(() => {
              if (gameRooms.has(idPartida)) {
                const currentRoom = gameRooms.get(idPartida);
                if (!currentRoom.player1Ws && !currentRoom.player2Ws) {
                  gameRooms.delete(idPartida);
                  console.log(`Sala ${idPartida} eliminada por inactividad`);
                }
              }
            }, 30000); // 30 seconds timeout
          }
          
          break;
        }
      }
    } catch (error) {
      console.error('Error en cierre de WebSocket:', error.message);
    }
  });

  ws.on('error', (error) => {
    console.error('Error en WebSocket:', error);
  });
});

// Calculate winner (same logic as frontend)
function calculateWinner(board) {
  const lines = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6]
  ];
  for (let [a, b, c] of lines) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return board[a];
    }
  }
  return null;
}

// API endpoint para obtener información de partidas (opcional)
app.get('/api/partidas/:idUsuario', async (req, res) => {
  try {
    const { idUsuario } = req.params;
    const [partidas] = await pool.query(
      'SELECT * FROM partidas WHERE idUsuario = ? OR idAmigo = ? ORDER BY created_at DESC',
      [idUsuario, idUsuario]
    );
    res.json(partidas);
  } catch (error) {
    console.error('Error obteniendo partidas:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Start server
app.listen(port, () => {
  console.log(`Servidor HTTP ejecutándose en http://localhost:${port}`);
});

console.log('Servidor WebSocket ejecutándose en ws://localhost:3002');