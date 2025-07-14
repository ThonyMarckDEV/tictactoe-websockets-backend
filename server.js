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
        id: parseInt(idUsuario),
        name: result[0].nombre || 'Player',
        picture: result[0].perfil || 'https://placehold.co/50x50',
      };
    }
    return {
      id: parseInt(idUsuario),
      name: 'Player',
      picture: 'https://placehold.co/50x50',
    };
  } catch (error) {
    console.error('Error getting player data:', error);
    return {
      id: parseInt(idUsuario),
      name: 'Player',
      picture: 'https://placehold.co/50x50',
    };
  }
}

// Function to send player data to both players
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

    console.log(`Sending player data for game ${idPartida}:`, { player1: player1Data, player2: player2Data });

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

// API endpoint to create a new game
app.post('/api/create-game', async (req, res) => {
  try {
    const { idUsuario } = req.body;
    
    if (!idUsuario) {
      return res.status(400).json({ error: 'idUsuario is required' });
    }

    // Verificar que el usuario existe
    const [user] = await pool.query('SELECT idUsuario FROM usuarios WHERE idUsuario = ?', [idUsuario]);
    if (user.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const [result] = await pool.query(
      'INSERT INTO partidas (juego, idUsuario, estado, created_at, updated_at) VALUES (?, ?, 1, NOW(), NOW())',
      ['Triki', idUsuario]
    );

    const idPartida = result.insertId;

    const room = {
      player1: parseInt(idUsuario),
      player1Ws: null,
      player2: null,
      player2Ws: null,
      board: Array(9).fill(null),
      isXNext: true,
      status: 'waiting',
    };
    
    gameRooms.set(idPartida, room);
    console.log(`Created new game ${idPartida} for user ${idUsuario}`);

    res.json({ idPartida });
  } catch (error) {
    console.error('Error creating game:', error.message);
    res.status(500).json({ error: 'Failed to create game', details: error.message });
  }
});

// Handle WebSocket connections
wss.on('connection', (ws) => {
  console.log('New WebSocket connection established');

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      console.log('Received WebSocket message:', data);

      if (data.type === 'join') {
        const { idPartida, idUsuario } = data;
        
        if (!idPartida || !idUsuario) {
          ws.send(JSON.stringify({ type: 'error', message: 'Missing idPartida or idUsuario' }));
          return;
        }

        const numericGameId = parseInt(idPartida);
        const numericUserId = parseInt(idUsuario);
        
        let room = gameRooms.get(numericGameId);

        // Si no existe la sala en memoria, buscar en la base de datos
        if (!room) {
          console.log(`Room ${numericGameId} not found in memory, checking database...`);
          
          const [partidas] = await pool.query(
            'SELECT * FROM partidas WHERE idPartida = ?',
            [numericGameId]
          );

          if (partidas.length === 0) {
            console.log(`Game ${numericGameId} not found in database`);
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
          };
          gameRooms.set(numericGameId, room);
          console.log(`Restored room ${numericGameId} from database:`, room);
        }

        // Verificar que el usuario puede unirse a este juego
        if (room.player1 !== numericUserId && room.player2 !== numericUserId && room.player2 !== null) {
          console.log(`User ${numericUserId} cannot join game ${numericGameId} - game is full`);
          ws.send(JSON.stringify({ 
            type: 'error', 
            message: 'This game has already started with two players' 
          }));
          return;
        }

        // Asignar WebSocket al jugador correspondiente
        if (room.player1 === numericUserId) {
          room.player1Ws = ws;
          console.log(`Player 1 (${numericUserId}) connected to game ${numericGameId}`);
        } else if (room.player2 === numericUserId) {
          room.player2Ws = ws;
          console.log(`Player 2 (${numericUserId}) connected to game ${numericGameId}`);
        } else if (!room.player2) {
          // El segundo jugador se une
          room.player2 = numericUserId;
          room.player2Ws = ws;
          room.status = 'playing';
          console.log(`Player 2 (${numericUserId}) joined game ${numericGameId}`);

          // Actualizar la base de datos
          await pool.query(
            'UPDATE partidas SET idAmigo = ?, updated_at = NOW() WHERE idPartida = ?',
            [numericUserId, numericGameId]
          );
        }

        // Enviar datos de los jugadores
        await sendPlayerDataToRoom(room, numericGameId);

        // Si el juego está listo para comenzar, enviar mensaje de inicio
        if (room.status === 'playing') {
          console.log(`Starting game ${numericGameId}`);
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
        const numericGameId = parseInt(idPartida);
        const numericUserId = parseInt(idUsuario);
        const room = gameRooms.get(numericGameId);

        if (!room || room.status !== 'playing') {
          console.log(`Move rejected: game ${numericGameId} not found or not playing`);
          return;
        }

        // Verificar que es el turno del jugador correcto
        if ((room.isXNext && numericUserId !== room.player1) || (!room.isXNext && numericUserId !== room.player2)) {
          console.log(`Move rejected: not ${numericUserId}'s turn`);
          return;
        }

        if (!room.board[index]) {
          room.board[index] = room.isXNext ? 'X' : 'O';
          room.isXNext = !room.isXNext;
          console.log(`Move made in game ${numericGameId}: position ${index} = ${room.board[index]}`);

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

          // Verificar si hay ganador
          const winner = calculateWinner(room.board);
          if (winner || !room.board.includes(null)) {
            room.status = 'finished';
            const idGanador = winner ? (winner === 'X' ? room.player1 : room.player2) : null;
            console.log(`Game ${numericGameId} finished. Winner: ${winner ? idGanador : 'tie'}`);

            await pool.query(
              'UPDATE partidas SET idGanador = ?, estado = 2, updated_at = NOW() WHERE idPartida = ?',
              [idGanador, numericGameId]
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
        const numericGameId = parseInt(idPartida);
        const room = gameRooms.get(numericGameId);
        
        if (room && message && message.userId) {
          try {
            const playerData = await getPlayerData(message.userId);
            const chatMessage = {
              text: message.text,
              user: playerData.name,
              userId: parseInt(message.userId),
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
          } catch (error) {
            console.error('Error processing chat message:', error);
          }
        }
      }
    } catch (error) {
      console.error('WebSocket message error:', error.message);
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
    }
  });

  ws.on('close', async () => {
    console.log('WebSocket connection closed');
    try {
      // Buscar en qué sala estaba este WebSocket
      for (const [idPartida, room] of gameRooms) {
        if (room.player1Ws === ws || room.player2Ws === ws) {
          const disconnectedPlayer = room.player1Ws === ws ? room.player1 : room.player2;
          const remainingPlayer = room.player1Ws === ws ? room.player2 : room.player1;
          const remainingWs = room.player1Ws === ws ? room.player2Ws : room.player1Ws;

          console.log(`Player ${disconnectedPlayer} disconnected from game ${idPartida}`);
          console.log(`Game status: ${room.status}`);
          console.log(`Remaining player: ${remainingPlayer}`);

          // Limpiar la referencia del WebSocket
          if (room.player1Ws === ws) {
            room.player1Ws = null;
          } else {
            room.player2Ws = null;
          }

          // Si el juego está en progreso y hay un jugador restante, ese jugador gana
          if (room.status === 'playing' && remainingPlayer && remainingWs) {
            const winnerSymbol = remainingPlayer === room.player1 ? 'X' : 'O';
            room.status = 'finished';
            
            try {
              await pool.query(
                'UPDATE partidas SET idGanador = ?, estado = 2, updated_at = NOW() WHERE idPartida = ?',
                [remainingPlayer, idPartida]
              );
              console.log(`Updated database: Winner ${remainingPlayer} for game ${idPartida}`);
            } catch (dbError) {
              console.error('Error updating database on disconnect:', dbError);
            }

            if (remainingWs.readyState === WebSocket.OPEN) {
              remainingWs.send(
                JSON.stringify({
                  type: 'gameOver',
                  winner: winnerSymbol,
                  idGanador: remainingPlayer,
                  reason: 'opponent_disconnected',
                })
              );
              console.log(`Sent game over message to remaining player ${remainingPlayer}`);
            }
          }
          
          // Si el juego está esperando y el creador se desconecta, eliminar la partida
          if (room.status === 'waiting' && disconnectedPlayer === room.player1) {
            try {
              await pool.query(
                'DELETE FROM partidas WHERE idPartida = ?',
                [idPartida]
              );
              console.log(`Deleted waiting game ${idPartida} from database`);
            } catch (dbError) {
              console.error('Error deleting waiting game:', dbError);
            }
            
            // Eliminar la sala de la memoria
            gameRooms.delete(idPartida);
            console.log(`Removed game room ${idPartida} from memory`);
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
  console.log(`WebSocket server running on ws://localhost:3002`);
});