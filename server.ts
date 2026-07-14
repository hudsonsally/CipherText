import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';
import { User, Message, Room, WSClientEvent, WSServerEvent } from './src/types.js';

// Setup storage paths
const DATA_DIR = path.join(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// In-Memory Database Structure
interface DatabaseSchema {
  users: Record<string, User>;
  rooms: Record<string, Room>;
  messages: Message[];
}

// Load DB from file or initialize
let db: DatabaseSchema = {
  users: {},
  rooms: {},
  messages: []
};

// High-Performance In-Memory Indices
let messageIndexByRoom: Record<string, Message[]> = {};
let messageIndexById: Record<string, Message> = {};
let userIndexByUsername: Record<string, User> = {};

function rebuildIndexes() {
  messageIndexByRoom = {};
  messageIndexById = {};
  userIndexByUsername = {};

  // Index Users
  for (const userId in db.users) {
    const user = db.users[userId];
    userIndexByUsername[user.username.toLowerCase()] = user;
  }

  // Index Rooms
  for (const roomId in db.rooms) {
    const room = db.rooms[roomId];
    if (!room.lastReadMessageId) {
      room.lastReadMessageId = {};
    }
    messageIndexByRoom[roomId] = [];
  }

  // Index Messages
  db.messages.forEach(msg => {
    messageIndexById[msg.id] = msg;
    if (!messageIndexByRoom[msg.roomId]) {
      messageIndexByRoom[msg.roomId] = [];
    }
    messageIndexByRoom[msg.roomId].push(msg);
  });
}

if (fs.existsSync(DB_FILE)) {
  try {
    const rawData = fs.readFileSync(DB_FILE, 'utf-8');
    db = JSON.parse(rawData);
    
    // Database Migration & Presence Bootstrapper
    if (!db.users) db.users = {};
    if (!db.rooms) db.rooms = {};
    if (!db.messages) db.messages = [];

    // Mark all users offline on server startup
    for (const userId in db.users) {
      db.users[userId].isOnline = false;
    }
    
    // Ensure all rooms have lastReadMessageId structure initialized
    for (const roomId in db.rooms) {
      if (!db.rooms[roomId].lastReadMessageId) {
        db.rooms[roomId].lastReadMessageId = {};
      }
    }

    rebuildIndexes();
    console.log(`[BOOTSTRAP] Database loaded & indexed. Users: ${Object.keys(db.users).length}, Rooms: ${Object.keys(db.rooms).length}, Messages: ${db.messages.length}`);
  } catch (err) {
    console.error('Error loading database file, starting fresh:', err);
    rebuildIndexes();
  }
} else {
  rebuildIndexes();
}

// Save DB helper using an Asynchronous Non-Blocking Write Queue
let isSaving = false;
let needsSaveAgain = false;

async function saveDb() {
  if (isSaving) {
    needsSaveAgain = true;
    return;
  }
  isSaving = true;
  try {
    const rawContent = JSON.stringify(db, null, 2);
    await fs.promises.writeFile(DB_FILE, rawContent, 'utf-8');
  } catch (err) {
    console.error('Error saving database asynchronously:', err);
  } finally {
    isSaving = false;
    if (needsSaveAgain) {
      needsSaveAgain = false;
      saveDb(); // trigger next save in queue
    }
  }
}

// Compute unread messages count for a specific room and user
function getUnreadCount(roomId: string, userId: string): number {
  const roomMessages = messageIndexByRoom[roomId] || [];
  const room = db.rooms[roomId];
  if (!room) return 0;

  const lastReadId = room.lastReadMessageId?.[userId];
  if (!lastReadId) {
    // Count all non-system, active messages
    return roomMessages.filter(msg => !msg.isSystem && !msg.deletedAt).length;
  }

  const lastReadIndex = roomMessages.findIndex(m => m.id === lastReadId);
  if (lastReadIndex === -1) {
    return roomMessages.filter(msg => !msg.isSystem && !msg.deletedAt).length;
  }

  // Count active messages after the last read message index
  return roomMessages.slice(lastReadIndex + 1).filter(msg => !msg.isSystem && !msg.deletedAt).length;
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API Health Check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', usersCount: Object.keys(db.users).length, roomsCount: Object.keys(db.rooms).length });
  });

  // Get users for registration check
  app.get('/api/users/check/:username', (req, res) => {
    const { username } = req.params;
    const exists = Object.values(db.users).some(u => u.username.toLowerCase() === username.toLowerCase());
    res.json({ exists });
  });

  const server = http.createServer(app);

  // Active WebSocket connections mapped to user IDs
  const activeClients = new Map<string, WebSocket>();

  // Helper to send typed events to a specific WebSocket client
  function sendEvent(ws: WebSocket, event: WSServerEvent) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(event));
    }
  }

  // Helper to broadcast events to all connected clients
  function broadcastEvent(event: WSServerEvent, excludeUserId?: string) {
    for (const [userId, ws] of activeClients.entries()) {
      if (userId !== excludeUserId) {
        sendEvent(ws, event);
      }
    }
  }

  // Create WebSocket server
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url || '', `http://${request.headers.host}`).pathname;
    if (pathname === '/ws') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
  });

  wss.on('connection', (ws: WebSocket) => {
    let currentUserId: string | null = null;

    ws.on('message', (messageBuffer) => {
      try {
        const rawMessage = messageBuffer.toString();
        const event = JSON.parse(rawMessage) as WSClientEvent;

        switch (event.type) {
          case 'client:register': {
            const { username, publicKey } = event.payload;

            if (!username || !publicKey) {
              sendEvent(ws, { type: 'server:error', payload: { message: 'Username and public key are required' } });
              return;
            }

            // Input Sanitization & Length Validation
            const sanitizedUsername = username.replace(/[^a-zA-Z0-9_]/g, '');
            if (!sanitizedUsername || sanitizedUsername.length > 20 || username !== sanitizedUsername) {
              sendEvent(ws, { type: 'server:error', payload: { message: 'Invalid username. Only alphanumeric characters and underscores are allowed (max 20).' } });
              return;
            }

            // Find existing user or create one in O(1) using index lookup
            let user = userIndexByUsername[sanitizedUsername.toLowerCase()];

            if (user) {
              // Update user public key and presence
              user.publicKey = publicKey;
              user.isOnline = true;
              user.lastSeen = Date.now();
            } else {
              // Generate standard ID
              const id = 'user_' + Math.random().toString(36).substr(2, 9);
              user = {
                id,
                username: sanitizedUsername,
                publicKey,
                isOnline: true,
                lastSeen: Date.now()
              };
              db.users[id] = user;
              userIndexByUsername[sanitizedUsername.toLowerCase()] = user;
            }

            currentUserId = user.id;
            activeClients.set(user.id, ws);
            saveDb();

            // Find rooms user belongs to with unread count populated
            const userRooms = Object.values(db.rooms)
              .filter(room => room.participants.includes(user!.id))
              .map(room => ({
                ...room,
                unreadCount: getUnreadCount(room.id, user!.id)
              }));

            // Fetch list of all other users
            const allUsers = Object.values(db.users);

            // Notify registration success
            sendEvent(ws, {
              type: 'server:registered',
              payload: {
                user,
                rooms: userRooms,
                users: allUsers
              }
            });

            // Broadcast user presence to others
            broadcastEvent({
              type: 'server:user_presence',
              payload: { userId: user.id, isOnline: true }
            }, user.id);

            // Send updated user list to everyone
            broadcastEvent({
              type: 'server:user_list',
              payload: { users: Object.values(db.users) }
            });
            break;
          }

          case 'client:room_create': {
            if (!currentUserId) {
              sendEvent(ws, { type: 'server:error', payload: { message: 'Unauthorized' } });
              return;
            }

            const { name, type, participants, encryptedKeys, keyIv } = event.payload;

            // Make sure current user is in participants list
            const fullParticipants = Array.from(new Set([...participants, currentUserId]));

            if (type === 'direct') {
              // Check if a direct room already exists between these precise two users
              if (fullParticipants.length === 2) {
                const existingDirect = Object.values(db.rooms).find(room =>
                  room.type === 'direct' &&
                  room.participants.length === 2 &&
                  room.participants.includes(fullParticipants[0]) &&
                  room.participants.includes(fullParticipants[1])
                );

                if (existingDirect) {
                  // Direct room already exists, just return it
                  sendEvent(ws, { type: 'server:room_created', payload: { room: existingDirect } });
                  return;
                }
              }
            }

            // Create new room
            const roomId = 'room_' + Math.random().toString(36).substr(2, 9);
            const newRoom: Room = {
              id: roomId,
              name: name || `Secure Chat (${fullParticipants.length})`,
              type,
              participants: fullParticipants,
              encryptedKeys,
              keyIv,
              createdAt: Date.now(),
              lastReadMessageId: {}
            };

            db.rooms[roomId] = newRoom;
            messageIndexByRoom[roomId] = []; // Initialize room message index
            saveDb();

            // Notify all currently online participants of this new room
            fullParticipants.forEach(userId => {
              const participantWs = activeClients.get(userId);
              if (participantWs) {
                sendEvent(participantWs, {
                  type: 'server:room_created',
                  payload: {
                    room: {
                      ...newRoom,
                      unreadCount: getUnreadCount(roomId, userId)
                    }
                  }
                });
              }
            });

            // Create automatic system message for room creation
            const sysMessageId = 'msg_sys_' + Math.random().toString(36).substr(2, 9);
            const sysMessage: Message = {
              id: sysMessageId,
              roomId,
              senderId: 'system',
              senderUsername: 'System',
              encryptedText: '', // Empty or non-secret metadata
              iv: '',
              timestamp: Date.now(),
              isSystem: true
            };
            db.messages.push(sysMessage);
            
            // Index the message
            messageIndexById[sysMessageId] = sysMessage;
            messageIndexByRoom[roomId].push(sysMessage);
            
            saveDb();

            // Broadcast system message
            fullParticipants.forEach(userId => {
              const participantWs = activeClients.get(userId);
              if (participantWs) {
                sendEvent(participantWs, {
                  type: 'server:message_receive',
                  payload: { message: sysMessage }
                });
              }
            });
            break;
          }

          case 'client:message_send': {
            if (!currentUserId) {
              sendEvent(ws, { type: 'server:error', payload: { message: 'Unauthorized' } });
              return;
            }

            const { id: clientMsgId, roomId, encryptedText, iv } = event.payload;
            const room = db.rooms[roomId];

            if (!room) {
              sendEvent(ws, { type: 'server:error', payload: { message: 'Room not found' } });
              return;
            }

            if (!room.participants.includes(currentUserId)) {
              sendEvent(ws, { type: 'server:error', payload: { message: 'Access denied to this room' } });
              return;
            }

            const messageId = clientMsgId || 'msg_' + Math.random().toString(36).substr(2, 9);
            
            // Message Idempotency: verify if this message ID is already registered
            if (messageIndexById[messageId]) {
              console.log(`[IDEMPOTENCY] Duplicate message rejected: ${messageId}`);
              return;
            }

            const user = db.users[currentUserId];
            const newMessage: Message = {
              id: messageId,
              roomId,
              senderId: currentUserId,
              senderUsername: user ? user.username : 'Unknown',
              encryptedText,
              iv,
              timestamp: Date.now()
            };

            db.messages.push(newMessage);
            
            // Index the message
            messageIndexById[messageId] = newMessage;
            if (!messageIndexByRoom[roomId]) {
              messageIndexByRoom[roomId] = [];
            }
            messageIndexByRoom[roomId].push(newMessage);

            saveDb();

            // Broadcast message to all active participants in the room
            room.participants.forEach(participantId => {
              const pWs = activeClients.get(participantId);
              if (pWs) {
                sendEvent(pWs, {
                  type: 'server:message_receive',
                  payload: { message: newMessage }
                });
              }
            });
            break;
          }

          case 'client:message_delete': {
            if (!currentUserId) {
              sendEvent(ws, { type: 'server:error', payload: { message: 'Unauthorized' } });
              return;
            }

            const { roomId, messageId } = event.payload;
            const room = db.rooms[roomId];

            if (!room) {
              sendEvent(ws, { type: 'server:error', payload: { message: 'Room not found' } });
              return;
            }

            // Find message from index O(1)
            const msg = messageIndexById[messageId];
            if (!msg) {
              sendEvent(ws, { type: 'server:error', payload: { message: 'Message not found' } });
              return;
            }

            if (msg.senderId !== currentUserId) {
              sendEvent(ws, { type: 'server:error', payload: { message: 'Unauthorized to delete this message' } });
              return;
            }

            // Soft delete message
            msg.deletedAt = Date.now();
            msg.encryptedText = ''; // Clean up encrypted content from DB for zero-trace security
            msg.iv = '';

            saveDb();

            // Broadcast soft delete event to all participants
            room.participants.forEach(participantId => {
              const pWs = activeClients.get(participantId);
              if (pWs) {
                sendEvent(pWs, {
                  type: 'server:message_deleted',
                  payload: { roomId, messageId }
                });
              }
            });
            break;
          }

          case 'client:read_receipt': {
            if (!currentUserId) return;

            const { roomId, messageId } = event.payload;
            const room = db.rooms[roomId];
            if (!room) return;

            if (!room.participants.includes(currentUserId)) return;

            // Update read receipt state
            if (!room.lastReadMessageId) {
              room.lastReadMessageId = {};
            }
            room.lastReadMessageId[currentUserId] = messageId;
            
            saveDb();

            // Broadcast read receipt update to other active participants
            room.participants.forEach(pId => {
              if (pId !== currentUserId) {
                const pWs = activeClients.get(pId);
                if (pWs) {
                  sendEvent(pWs, {
                    type: 'server:read_receipt',
                    payload: { roomId, userId: currentUserId!, messageId }
                  });
                }
              }
            });
            break;
          }

          case 'client:typing': {
            if (!currentUserId) return;

            const { roomId, isTyping } = event.payload;
            const room = db.rooms[roomId];
            if (!room) return;

            const senderUser = db.users[currentUserId];
            if (!senderUser) return;

            // Send typing notification to other participants
            room.participants.forEach(pId => {
              if (pId !== currentUserId) {
                const pWs = activeClients.get(pId);
                if (pWs) {
                  sendEvent(pWs, {
                    type: 'server:typing',
                    payload: {
                      roomId,
                      userId: currentUserId!,
                      username: senderUser.username,
                      isTyping
                    }
                  });
                }
              }
            });
            break;
          }
        }
      } catch (err) {
        console.error('Error handling websocket message:', err);
        sendEvent(ws, { type: 'server:error', payload: { message: 'Invalid payload' } });
      }
    });

    ws.on('close', () => {
      if (currentUserId) {
        activeClients.delete(currentUserId);
        const user = db.users[currentUserId];
        if (user) {
          user.isOnline = false;
          user.lastSeen = Date.now();
          saveDb();

          // Broadcast user going offline
          broadcastEvent({
            type: 'server:user_presence',
            payload: { userId: currentUserId, isOnline: false }
          });

          // Send updated user list
          broadcastEvent({
            type: 'server:user_list',
            payload: { users: Object.values(db.users) }
          });
        }
      }
    });
  });

  // Serve past messages API (encrypted) - High-Performance index lookup
  app.get('/api/rooms/:roomId/messages', (req, res) => {
    const { roomId } = req.params;
    
    // O(1) Composite index retrieval
    const indexedMessages = messageIndexByRoom[roomId] || [];
    
    // Map messages to filter out actual E2EE text/iv on soft deleted items (security enforcement)
    const roomMessages = indexedMessages.map(msg => {
      if (msg.deletedAt) {
        return {
          ...msg,
          encryptedText: '',
          iv: ''
        };
      }
      return msg;
    });

    res.json({ messages: roomMessages });
  });

  // Serve Vite / SPA Static Frontend
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`CipherChat Full-Stack Server running on port ${PORT}`);
  });
}

startServer();
