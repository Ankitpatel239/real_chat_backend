const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
//allowed origins for socket.io and for production use environment variable
const allowedOrigins = process.env.NODE_ENV === 'production' ? [process.env.CLIENT_URL] : ['http://localhost:3000'];
const io = socketIo(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

// SQLite Database Setup with better optimization
const db = new sqlite3.Database('./webrtc.db', (err) => {
  if (err) {
    console.error('Error opening database:', err);
  } else {
    console.log('Connected to SQLite database');
    // Enable WAL mode for better performance
    db.run('PRAGMA journal_mode = WAL;');
    db.run('PRAGMA synchronous = NORMAL;');
    db.run('PRAGMA cache_size = -64000;'); // 64MB cache
  }
});

// Create tables with indexes for better performance
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    room_code TEXT,
    username TEXT,
    socket_id TEXT,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_online INTEGER DEFAULT 1,
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (room_code) REFERENCES rooms (code)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_code TEXT,
    user_id TEXT,
    username TEXT,
    message TEXT,
    message_type TEXT DEFAULT 'text',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (room_code) REFERENCES rooms (code)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_code TEXT,
    call_type TEXT,
    initiator_id TEXT,
    initiator_name TEXT,
    status TEXT DEFAULT 'active',
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    ended_at DATETIME,
    FOREIGN KEY (room_code) REFERENCES rooms (code)
  )`);

  // Create indexes for better query performance
  db.run(`CREATE INDEX IF NOT EXISTS idx_rooms_code ON rooms(code)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_users_room_code ON users(room_code)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_users_online ON users(is_online)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_room_code ON messages(room_code)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_calls_room_code ON calls(room_code)`);
});

// Utility functions with optimized queries
const dbGet = (query, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(query, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

const dbAll = (query, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

const dbRun = (query, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(query, params, function(err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
};

// Track typing users and active calls
const typingUsers = new Map();
const activeCalls = new Map();

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Join room
  socket.on('join-room', async (data) => {
    const { roomCode, username } = data;
    
    try {
      // Check if room exists, if not create it
      let room = await dbGet('SELECT * FROM rooms WHERE code = ?', [roomCode]);
      if (!room) {
        const roomId = uuidv4();
        await dbRun('INSERT INTO rooms (id, code) VALUES (?, ?)', [roomId, roomCode]);
        room = { id: roomId, code: roomCode };
      }

      // Create or update user
      const existingUser = await dbGet(
        'SELECT * FROM users WHERE room_code = ? AND username = ?',
        [roomCode, username]
      );

      let userId;
      if (existingUser) {
        userId = existingUser.id;
        await dbRun(
          'UPDATE users SET socket_id = ?, is_online = 1, last_seen = CURRENT_TIMESTAMP WHERE id = ?',
          [socket.id, userId]
        );
      } else {
        userId = uuidv4();
        await dbRun(
          'INSERT INTO users (id, room_code, username, socket_id) VALUES (?, ?, ?, ?)',
          [userId, roomCode, username, socket.id]
        );
      }

      socket.join(roomCode);
      socket.roomCode = roomCode;
      socket.userId = userId;
      socket.username = username;

      // Get room users with optimized query
      const users = await dbAll(
        `SELECT id, username, is_online, last_seen 
         FROM users 
         WHERE room_code = ? 
         ORDER BY is_online DESC, username ASC`,
        [roomCode]
      );

      // Get all messages for the room with pagination
      const messages = await dbAll(
        `SELECT m.*, u.username 
         FROM messages m 
         LEFT JOIN users u ON m.user_id = u.id 
         WHERE m.room_code = ? 
         ORDER BY m.created_at ASC`,
        [roomCode]
      );

      // Get call history
      const callHistory = await dbAll(
        `SELECT * FROM calls 
         WHERE room_code = ? 
         ORDER BY started_at DESC 
         LIMIT 10`,
        [roomCode]
      );

      socket.emit('room-joined', {
        roomCode,
        userId,
        users: users.map(u => ({ 
          id: u.id, 
          username: u.username,
          isOnline: u.is_online,
          lastSeen: u.last_seen
        })),
        messages,
        callHistory
      });

      // Notify others in the room
      socket.to(roomCode).emit('user-joined', {
        userId,
        username,
        users: users.map(u => ({ 
          id: u.id, 
          username: u.username,
          isOnline: u.is_online 
        }))
      });

      console.log(`User ${username} joined room ${roomCode}`);

    } catch (error) {
      console.error('Error joining room:', error);
      socket.emit('error', { message: 'Failed to join room' });
    }
  });

  // Handle messages with better error handling
  socket.on('send-message', async (data) => {
    try {
      const { message, messageType = 'text' } = data;
      
      if (!socket.roomCode || !socket.userId) {
        throw new Error('User not in a room');
      }

      const result = await dbRun(
        'INSERT INTO messages (room_code, user_id, username, message, message_type) VALUES (?, ?, ?, ?, ?)',
        [socket.roomCode, socket.userId, socket.username, message, messageType]
      );

      const newMessage = {
        id: result.id,
        user_id: socket.userId,
        username: socket.username,
        message,
        message_type: messageType,
        created_at: new Date().toISOString()
      };

      io.to(socket.roomCode).emit('new-message', newMessage);
    } catch (error) {
      console.error('Error sending message:', error);
      socket.emit('error', { message: 'Failed to send message' });
    }
  });

  // Typing indicators
  socket.on('typing-start', () => {
    if (socket.roomCode) {
      socket.to(socket.roomCode).emit('user-typing-start', {
        userId: socket.userId,
        username: socket.username
      });
    }
  });

  socket.on('typing-stop', () => {
    if (socket.roomCode) {
      socket.to(socket.roomCode).emit('user-typing-stop', {
        userId: socket.userId
      });
    }
  });

  // WebRTC signaling with better state management
  socket.on('offer', (data) => {
    if (socket.roomCode) {
      activeCalls.set(socket.roomCode, {
        callType: data.callType,
        initiator: socket.userId
      });

      socket.to(socket.roomCode).emit('offer', {
        offer: data.offer,
        from: socket.userId,
        username: socket.username,
        callType: data.callType
      });
    }
  });

  socket.on('answer', (data) => {
    if (socket.roomCode) {
      socket.to(socket.roomCode).emit('answer', {
        answer: data.answer,
        from: socket.userId
      });
    }
  });

  socket.on('ice-candidate', (data) => {
    if (socket.roomCode) {
      socket.to(socket.roomCode).emit('ice-candidate', {
        candidate: data.candidate,
        from: socket.userId
      });
    }
  });

  socket.on('end-call', async (data) => {
    if (socket.roomCode) {
      activeCalls.delete(socket.roomCode);
      
      // Update call record if it exists
      await dbRun(
        'UPDATE calls SET status = \"ended\", ended_at = CURRENT_TIMESTAMP WHERE room_code = ? AND status = \"active\"',
        [socket.roomCode]
      );

      socket.to(socket.roomCode).emit('call-ended', {
        from: socket.userId,
        username: socket.username
      });
    }
  });

  socket.on('call-started', async (data) => {
    try {
      if (socket.roomCode) {
        await dbRun(
          'INSERT INTO calls (room_code, call_type, initiator_id, initiator_name) VALUES (?, ?, ?, ?)',
          [socket.roomCode, data.callType, socket.userId, socket.username]
        );
      }
    } catch (error) {
      console.error('Error logging call:', error);
    }
  });

  // Handle user presence
  socket.on('disconnect', async () => {
    try {
      if (socket.roomCode && socket.userId) {
        // Mark user as offline but don't delete
        await dbRun(
          'UPDATE users SET is_online = 0, last_seen = CURRENT_TIMESTAMP WHERE socket_id = ?',
          [socket.id]
        );

        const remainingUsers = await dbAll(
          'SELECT COUNT(*) as count FROM users WHERE room_code = ? AND is_online = 1',
          [socket.roomCode]
        );

        // Only notify if user was actually online
        socket.to(socket.roomCode).emit('user-left', {
          userId: socket.userId,
          username: socket.username
        });

        // Stop typing if user was typing
        socket.to(socket.roomCode).emit('user-typing-stop', {
          userId: socket.userId
        });

        console.log(`User ${socket.username} left room ${socket.roomCode}`);
      }
    } catch (error) {
      console.error('Error handling disconnect:', error);
    }
  });

  // Ping to keep connection alive
  socket.on('ping', () => {
    socket.emit('pong');
  });
});

// Cleanup inactive users periodically
setInterval(async () => {
  try {
    const result = await dbRun(
      'DELETE FROM users WHERE is_online = 0 AND last_seen < datetime(\"now\", \"-1 hour\")'
    );
    if (result.changes > 0) {
      console.log(`Cleaned up ${result.changes} inactive users`);
    }
  } catch (error) {
    console.error('Error cleaning up users:', error);
  }
}, 300000); // Every 5 minutes

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});