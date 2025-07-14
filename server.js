require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const mysql = require('mysql2/promise');
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
  queueLimit: 0,
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
        picture: result[0].perfil || 'https://placehold.co/50x50',
      };
    }
    return {
      id: idUsuario,
      name: 'Player',
      picture: 'https://placehold.co/50x50',
    };
  } catch (error) {
    console.error('Error getting player data:', error);
    return {
      id: idUsuario,
      name: 'Player',
      picture: 'https://placehold.co/50x50',
    };
  }
}

// Function to send player data to both players
async function sendPlayerDataToRoom(room, idPartida) {
  const player1Data = await getPlayerData(room.player1);
  const player2Data = room.player2
    ? await getPlayerData(room.player2)
    : { id: null, name: 'Esperando oponente...', picture: 'https://placehold.co/50x50' };

  const playerDataMessage = JSON.stringify({
    type: 'playerData',
    player1: player1Data,
    player2: player2Data,
  });

  if (room.player1Ws && room.player1Ws.readyState === WebSocket.OPEN) {
    room.player1Ws.send(playerDataMessage);
  }
  if (room.player2Ws && room.player2Ws.readyState === WebSocket.OPEN) {
    room.player2Ws.send(playerDataMessage);
  }
}

// API endpoint to create a new game
app.post('/api/create-game', async (req, res) => {
  try {
    const { idUsuario } = req.body;
    
    if (!idUsuario) {
      return res.status(400).json({ error: 'idUsuario is required' });
    }

    // Crear nueva partida en la base de datos - SIN especificar idPartida
    const [result] = await pool.query(
      'INSERT INTO partidas (juego, idUsuario, estado, created_at, updated_at) VALUES (?, ?, 1, NOW(), NOW())',
      ['Triki', idUsuario]
    );

    const idPartida = result.insertId; // Este es el ID autoincremental generado por MySQL

    // Crear la sala de juego
    const room = {
      player1: idUsuario,
      player1Ws: null,
      player2: null,
      player2Ws: null,
      board: Array(9).fill(null),
      isXNext: true,
      status: 'waiting',
    };
    
    gameRooms.set(idPartida, room);

    res.json({ idPartida });
  } catch (error) {
    console.error('Error creating game:', error);
    res.status(500).json({ error: 'Failed to create game' });
  }
});

// Handle WebSocket connections
wss.on('connection', (ws) => {
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      console.log('Received WebSocket message:', data);

      if (data.type === 'join') {
        const { idPartida, idUsuario } = data;
        let room = gameRooms.get(idPartida);

        // Si la sala no existe, buscar en la base de datos
        if (!room) {
          const [partidas] = await pool.query(
            'SELECT * FROM partidas WHERE idPartida = ?',
            [idPartida]
          );

          if (partidas.length === 0) {
            ws.send(JSON.stringify({ type: 'error', message: 'Game not found' }));
            return;
          }

          const partida = partidas[0];
          room = {
            player1: partida.idUsuario,
            player1Ws: null,
            player2: partida.idAmigo,
            player2Ws: null,
            board: Array(9).fill(null),
            isXNext: true,
            status: partida.estado === 1 ? (partida.idAmigo ? 'playing' : 'waiting') : 'finished',
          };
          gameRooms.set(idPartida, room);
        }

        // Asignar WebSocket al jugador correspondiente
        if (room.player1 === idUsuario) {
          room.player1Ws = ws;
        } else if (room.player2 === idUsuario) {
          room.player2Ws = ws;
        } else if (!room.player2) {
          // Segundo jugador se une
          room.player2 = idUsuario;
          room.player2Ws = ws;
          room.status = 'playing';

          // Actualizar base de datos
          await pool.query(
            'UPDATE partidas SET idAmigo = ?, updated_at = NOW() WHERE idPartida = ?',
            [idUsuario, idPartida]
          );
        } else {
          ws.send(JSON.stringify({ type: 'error', message: 'Game is full' }));
          return;
        }

        await sendPlayerDataToRoom(room, idPartida);

        // Enviar estado del juego
        if (room.status === 'playing') {
          const startMessage = JSON.stringify({
            type: 'start',
            board: room.board,
            isXNext: room.isXNext,
          });

          if (room.player1Ws && room.player1Ws.readyState === WebSocket.OPEN) {
            room.player1Ws.send(startMessage);
          }
          if (room.player2Ws && room.player2Ws.readyState === WebSocket.OPEN) {
            room.player2Ws.send(startMessage);
          }
        }
      }

      if (data.type === 'move') {
        const { idPartida, index, idUsuario } = data;
        const room = gameRooms.get(idPartida);

        if (!room || room.status !== 'playing') return;
        if ((room.isXNext && idUsuario !== room.player1) || (!room.isXNext && idUsuario !== room.player2))
          return;

        if (!room.board[index]) {
          room.board[index] = room.isXNext ? 'X' : 'O';
          room.isXNext = !room.isXNext;

          const moveMessage = JSON.stringify({
            type: 'move',
            board: room.board,
            isXNext: room.isXNext,
          });

          if (room.player1Ws && room.player1Ws.readyState === WebSocket.OPEN) {
            room.player1Ws.send(moveMessage);
          }
          if (room.player2Ws && room.player2Ws.readyState === WebSocket.OPEN) {
            room.player2Ws.send(moveMessage);
          }

          const winner = calculateWinner(room.board);
          if (winner || !room.board.includes(null)) {
            room.status = 'finished';
            const idGanador = winner ? (winner === 'X' ? room.player1 : room.player2) : null;

            await pool.query(
              'UPDATE partidas SET idGanador = ?, estado = 2, updated_at = NOW() WHERE idPartida = ?',
              [idGanador, idPartida]
            );

            const gameOverMessage = JSON.stringify({
              type: 'gameOver',
              winner,
              idGanador,
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
        if (room && message && message.userId) {
          const playerData = await getPlayerData(message.userId);
          const chatMessage = {
            text: message.text,
            user: playerData.name,
            userId: message.userId,
            picture: playerData.picture,
            timestamp: new Date().toISOString(),
          };
          const messageStr = JSON.stringify({
            type: 'chat',
            message: chatMessage,
          });

          if (room.player1Ws && room.player1Ws.readyState === WebSocket.OPEN) {
            room.player1Ws.send(messageStr);
          }
          if (room.player2Ws && room.player2Ws.readyState === WebSocket.OPEN) {
            room.player2Ws.send(messageStr);
          }
        } else {
          console.warn('Invalid chat message or room not found:', { idPartida, message });
        }
      }
    } catch (error) {
      console.error('WebSocket message error:', error.message);
    }
  });

  ws.on('close', async () => {
    try {
      for (const [idPartida, room] of gameRooms) {
        if (room.player1Ws === ws || room.player2Ws === ws) {
          const disconnectedPlayer = room.player1Ws === ws ? room.player1 : room.player2;
          const remainingPlayer = room.player1Ws === ws ? room.player2 : room.player1;
          const remainingWs = room.player1Ws === ws ? room.player2Ws : room.player1Ws;

          if (room.status === 'playing') {
            await pool.query(
              'UPDATE partidas SET idGanador = ?, estado = 2, updated_at = NOW() WHERE idPartida = ?',
              [remainingPlayer, idPartida]
            );

            if (remainingWs && remainingWs.readyState === WebSocket.OPEN) {
              remainingWs.send(
                JSON.stringify({
                  type: 'gameOver',
                  winner: remainingPlayer === room.player1 ? 'X' : 'O',
                  idGanador: remainingPlayer,
                  reason: 'opponent_disconnected',
                })
              );
            }
          }
          gameRooms.delete(idPartida);
          break;
        }
      }
    } catch (error) {
      console.error('WebSocket close error:', error.message);
    }
  });
});

// Calculate winner
function calculateWinner(board) {
  const lines = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6],
  ];
  for (let [a, b, c] of lines) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return board[a];
    }
  }
  return null;
}

// Start server
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});