require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const mysql = require('mysql2/promise');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const gameRooms = new Map();
const port = process.env.PORT;
const ws_port = process.env.WS_PORT;

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

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

const wss = new WebSocket.Server({ port: ws_port });

async function getPlayerData(idUsuario) {
  try {
    const [result] = await pool.query(
      'SELECT u.user_code, d.nombre, d.perfil FROM usuarios u LEFT JOIN datos d ON u.idDatos = d.idDatos WHERE u.idUsuario = ?',
      [idUsuario]
    );
    return result.length > 0
      ? { id: parseInt(idUsuario), name: result[0].nombre || 'Player', picture: result[0].perfil || 'https://placehold.co/50x50' }
      : { id: parseInt(idUsuario), name: 'Player', picture: 'https://placehold.co/50x50' };
  } catch (error) {
    console.error('Error getting player data:', error);
    return { id: parseInt(idUsuario), name: 'Player', picture: 'https://placehold.co/50x50' };
  }
}

async function sendPlayerDataToRoom(room, idPartida) {
  try {
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
  } catch (error) {
    console.error('Error sending player data:', error);
  }
}

app.post('/api/create-game', async (req, res) => {
  try {
    const { idUsuario } = req.body;
    if (!idUsuario) {
      return res.status(400).json({ error: 'idUsuario is required' });
    }

    const [user] = await pool.query('SELECT idUsuario FROM usuarios WHERE idUsuario = ?', [idUsuario]);
    if (user.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const [result] = await pool.query(
      'INSERT INTO partidas (juego, idUsuario, estado, created_at, updated_at) VALUES (?, ?, 1, NOW(), NOW())',
      ['Triki', idUsuario]
    );

    const idPartida = result.insertId;
    gameRooms.set(idPartida, {
      player1: parseInt(idUsuario),
      player1Ws: null,
      player2: null,
      player2Ws: null,
      board: Array(9).fill(null),
      isXNext: true,
      status: 'waiting',
      disconnectTimeouts: new Map(), // Store disconnect timeouts per player
    });

    res.json({ idPartida });
  } catch (error) {
    console.error('Error creating game:', error.message);
    res.status(500).json({ error: 'Failed to create game', details: error.message });
  }
});

function calculateWinner(board) {
  const lines = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6],
  ];
  for (let [a, b, c] of lines) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return board[a];
    }
  }
  return null;
}

wss.on('connection', (ws) => {
  console.log('New WebSocket connection established');

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === 'join') {
        const { idPartida, idUsuario } = data;
        if (!idPartida || !idUsuario) {
          ws.send(JSON.stringify({ type: 'error', message: 'Missing idPartida or idUsuario' }));
          return;
        }

        const numericGameId = parseInt(idPartida);
        const numericUserId = parseInt(idUsuario);
        let room = gameRooms.get(numericGameId);

        if (!room) {
          const [partidas] = await pool.query('SELECT * FROM partidas WHERE idPartida = ?', [numericGameId]);
          if (partidas.length === 0) {
            ws.send(JSON.stringify({ type: 'error', message: 'Game not found' }));
            return;
          }
          const partida = partidas[0];
          room = {
            player1: parseInt(partida.idUsuario),
            player1Ws: null,
            player2: partida.idAmigo ? parseInt(partida.idAmigo) : null,
            player2Ws: null,
            board: Array(9).fill(null),
            isXNext: true,
            status: partida.estado === 1 ? (partida.idAmigo ? 'playing' : 'waiting') : 'finished',
            disconnectTimeouts: new Map(),
          };
          gameRooms.set(numericGameId, room);
        }

        if (room.player1 !== numericUserId && room.player2 !== numericUserId && room.player2 !== null) {
          ws.send(JSON.stringify({ type: 'error', message: 'This game has already started with two players' }));
          return;
        }

        // Clear any disconnect timeout for this user
        if (room.disconnectTimeouts.has(numericUserId)) {
          clearTimeout(room.disconnectTimeouts.get(numericUserId));
          room.disconnectTimeouts.delete(numericUserId);
          console.log(`Cleared disconnect timeout for user ${numericUserId} in game ${numericGameId}`);
        }

        if (room.player1 === numericUserId) {
          room.player1Ws = ws;
        } else if (room.player2 === numericUserId) {
          room.player2Ws = ws;
        } else if (!room.player2) {
          room.player2 = numericUserId;
          room.player2Ws = ws;
          room.status = 'playing';
          await pool.query('UPDATE partidas SET idAmigo = ?, updated_at = NOW() WHERE idPartida = ?', [numericUserId, numericGameId]);
        }

        // Send reconnect data if the game is already playing
        if (room.status === 'playing' && (room.player1 === numericUserId || room.player2 === numericUserId)) {
          ws.send(JSON.stringify({
            type: 'reconnect',
            board: room.board,
            isXNext: room.isXNext,
            status: room.status,
          }));
        }

        await sendPlayerDataToRoom(room, numericGameId);

        if (room.status === 'playing') {
          const startMessage = JSON.stringify({ type: 'start', board: room.board, isXNext: room.isXNext });
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
        const numericGameId = parseInt(idPartida);
        const numericUserId = parseInt(idUsuario);
        const room = gameRooms.get(numericGameId);

        if (!room || room.status !== 'playing') return;

        if ((room.isXNext && numericUserId !== room.player1) || (!room.isXNext && numericUserId !== room.player2)) return;

        if (!room.board[index]) {
          room.board[index] = room.isXNext ? 'X' : 'O';
          room.isXNext = !room.isXNext;

          const moveMessage = JSON.stringify({ type: 'move', board: room.board, isXNext: room.isXNext });
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
            await pool.query('UPDATE partidas SET idGanador = ?, estado = 2, updated_at = NOW() WHERE idPartida = ?', [idGanador, numericGameId]);

            const gameOverMessage = JSON.stringify({ type: 'gameOver', winner, idGanador });
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
        const numericGameId = parseInt(idPartida);
        const room = gameRooms.get(numericGameId);

        if (room && message && message.userId) {
          const playerData = await getPlayerData(message.userId);
          const chatMessage = {
            text: message.text,
            user: playerData.name,
            userId: parseInt(message.userId),
            picture: playerData.picture,
            timestamp: new Date().toISOString(),
          };

          const messageStr = JSON.stringify({ type: 'chat', message: chatMessage });
          if (room.player1Ws && room.player1Ws.readyState === WebSocket.OPEN) {
            room.player1Ws.send(messageStr);
          }
          if (room.player2Ws && room.player2Ws.readyState === WebSocket.OPEN) {
            room.player2Ws.send(messageStr);
          }
        }
      }

      if (data.type === 'leave') {
        const { idPartida, idUsuario } = data;
        const numericGameId = parseInt(idPartida);
        const numericUserId = parseInt(idUsuario);
        const room = gameRooms.get(numericGameId);

        if (!room) return;

        const disconnectedPlayer = room.player1 === numericUserId ? room.player1 : room.player2;
        const remainingPlayer = room.player1 === numericUserId ? room.player2 : room.player1;
        const remainingWs = room.player1 === numericUserId ? room.player2Ws : room.player1Ws;

        if (room.player1 === numericUserId) {
          room.player1Ws = null;
        } else if (room.player2 === numericUserId) {
          room.player2Ws = null;
        }

        if (room.status === 'playing' && remainingPlayer && remainingWs && remainingWs.readyState === WebSocket.OPEN) {
          room.status = 'finished';
          const winnerSymbol = remainingPlayer === room.player1 ? 'X' : 'O';
          await pool.query('UPDATE partidas SET idGanador = ?, estado = 2, updated_at = NOW() WHERE idPartida = ?', [remainingPlayer, numericGameId]);
          remainingWs.send(JSON.stringify({
            type: 'gameOver',
            winner: winnerSymbol,
            idGanador: remainingPlayer,
            reason: 'opponent_left',
          }));
        }

        if (room.status === 'waiting' && disconnectedPlayer === room.player1) {
          await pool.query('DELETE FROM partidas WHERE idPartida = ?', [numericGameId]);
          gameRooms.delete(numericGameId);
        }
      }

      if (data.type === 'heartbeat') {
        // Respond to heartbeat to keep connection alive
        ws.send(JSON.stringify({ type: 'heartbeat_ack' }));
      }
    } catch (error) {
      console.error('WebSocket message error:', error.message);
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
    }
  });

  ws.on('close', async () => {
    console.log('WebSocket connection closed');
    try {
      for (const [idPartida, room] of gameRooms) {
        if (room.player1Ws === ws || room.player2Ws === ws) {
          const disconnectedPlayer = room.player1Ws === ws ? room.player1 : room.player2;
          const remainingPlayer = room.player1Ws === ws ? room.player2 : room.player1;
          const remainingWs = room.player1Ws === ws ? room.player2Ws : room.player1Ws;

          if (room.player1Ws === ws) {
            room.player1Ws = null;
          } else {
            room.player2Ws = null;
          }

          // Set a timeout to allow for reconnect
          if (room.status === 'playing') {
            room.disconnectTimeouts.set(disconnectedPlayer, setTimeout(async () => {
              if (room.status === 'playing' && remainingPlayer && remainingWs && remainingWs.readyState === WebSocket.OPEN) {
                room.status = 'finished';
                const winnerSymbol = remainingPlayer === room.player1 ? 'X' : 'O';
                await pool.query('UPDATE partidas SET idGanador = ?, estado = 2, updated_at = NOW() WHERE idPartida = ?', [remainingPlayer, idPartida]);
                remainingWs.send(JSON.stringify({
                  type: 'gameOver',
                  winner: winnerSymbol,
                  idGanador: remainingPlayer,
                  reason: 'opponent_left',
                }));
              }
              room.disconnectTimeouts.delete(disconnectedPlayer);
            }, 10000)); // 10-second grace period
          } else if (room.status === 'waiting' && disconnectedPlayer === room.player1) {
            await pool.query('DELETE FROM partidas WHERE idPartida = ?', [idPartida]);
            gameRooms.delete(idPartida);
          }

          break;
        }
      }
    } catch (error) {
      console.error('WebSocket close error:', error.message);
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
  console.log(`WebSocket server running on ws://localhost:${ws_port}`);
});