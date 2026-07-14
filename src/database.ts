import postgres from 'postgres';
import fs from 'fs';
import path from 'path';
import { User, Room, Message } from './types.js';

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

const DATABASE_URL = process.env.DATABASE_URL;
const isPg = !!DATABASE_URL;

let sql: ReturnType<typeof postgres> | null = null;

if (isPg && DATABASE_URL) {
  console.log('[DATABASE] Initializing PostgreSQL connection to Supabase...');
  sql = postgres(DATABASE_URL, {
    ssl: DATABASE_URL.includes('supabase') || DATABASE_URL.includes('neon') ? 'require' : 'prefer',
    max: 15,
    idle_timeout: 20,
    connect_timeout: 10
  });
} else {
  console.log('[DATABASE] No DATABASE_URL provided. Falling back to local db.json storage.');
}

// In-memory cache for fallback
let memoryDb: DatabaseSchema = {
  users: {},
  rooms: {},
  messages: []
};

// High-performance cache indices for fallback
let messageIndexByRoom: Record<string, Message[]> = {};
let messageIndexById: Record<string, Message> = {};
let userIndexByUsername: Record<string, User> = {};

function rebuildIndexes() {
  messageIndexByRoom = {};
  messageIndexById = {};
  userIndexByUsername = {};

  for (const userId in memoryDb.users) {
    const user = memoryDb.users[userId];
    userIndexByUsername[user.username.toLowerCase()] = user;
  }

  for (const roomId in memoryDb.rooms) {
    messageIndexByRoom[roomId] = [];
  }

  memoryDb.messages.forEach(msg => {
    messageIndexById[msg.id] = msg;
    if (!messageIndexByRoom[msg.roomId]) {
      messageIndexByRoom[msg.roomId] = [];
    }
    messageIndexByRoom[msg.roomId].push(msg);
  });
}

// Load JSON fallback database
if (!isPg && fs.existsSync(DB_FILE)) {
  try {
    const rawData = fs.readFileSync(DB_FILE, 'utf-8');
    memoryDb = JSON.parse(rawData);
    if (!memoryDb.users) memoryDb.users = {};
    if (!memoryDb.rooms) memoryDb.rooms = {};
    if (!memoryDb.messages) memoryDb.messages = [];

    // Mark users offline on startup
    for (const userId in memoryDb.users) {
      memoryDb.users[userId].isOnline = false;
    }
    
    // Ensure all rooms have lastReadMessageId structure initialized
    for (const roomId in memoryDb.rooms) {
      if (!memoryDb.rooms[roomId].lastReadMessageId) {
        memoryDb.rooms[roomId].lastReadMessageId = {};
      }
    }

    rebuildIndexes();
    console.log(`[DATABASE] JSON DB loaded & indexed. Users: ${Object.keys(memoryDb.users).length}, Rooms: ${Object.keys(memoryDb.rooms).length}, Messages: ${memoryDb.messages.length}`);
  } catch (err) {
    console.error('[DATABASE] Error loading fallback database file, starting fresh:', err);
    rebuildIndexes();
  }
} else if (!isPg) {
  rebuildIndexes();
}

// Save DB helper for fallback
let isSaving = false;
let needsSaveAgain = false;

async function saveMemoryDb() {
  if (isSaving) {
    needsSaveAgain = true;
    return;
  }
  isSaving = true;
  try {
    const rawContent = JSON.stringify(memoryDb, null, 2);
    await fs.promises.writeFile(DB_FILE, rawContent, 'utf-8');
  } catch (err) {
    console.error('[DATABASE] Error saving fallback database asynchronously:', err);
  } finally {
    isSaving = false;
    if (needsSaveAgain) {
      needsSaveAgain = false;
      saveMemoryDb();
    }
  }
}

// DB row mappers
function mapUser(row: any): User {
  return {
    id: row.id,
    username: row.username,
    publicKey: row.public_key,
    isOnline: row.is_online,
    lastSeen: Number(row.last_seen)
  };
}

function mapRoom(row: any): Room {
  return {
    id: row.id,
    name: row.name,
    type: row.type as 'direct' | 'group',
    participants: row.participants,
    encryptedKeys: row.encrypted_keys || {},
    keyIv: row.key_iv || undefined,
    createdAt: Number(row.created_at),
    lastReadMessageId: row.last_read_message_id || {}
  };
}

function mapMessage(row: any): Message {
  return {
    id: row.id,
    roomId: row.room_id,
    senderId: row.sender_id,
    senderUsername: row.sender_username,
    encryptedText: row.encrypted_text,
    iv: row.iv,
    timestamp: Number(row.timestamp),
    isSystem: row.is_system || undefined,
    deletedAt: row.deleted_at ? Number(row.deleted_at) : undefined
  };
}

export const dbService = {
  isPostgres: isPg,

  async initialize() {
    if (!isPg || !sql) return;
    
    try {
      console.log('[DATABASE] Running schema migrations in PostgreSQL...');

      // 1. Create users table
      await sql`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          username TEXT UNIQUE NOT NULL,
          public_key TEXT NOT NULL,
          is_online BOOLEAN NOT NULL DEFAULT false,
          last_seen BIGINT NOT NULL
        )
      `;

      // 2. Create rooms table
      await sql`
        CREATE TABLE IF NOT EXISTS rooms (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT NOT NULL,
          participants TEXT[] NOT NULL,
          encrypted_keys JSONB DEFAULT '{}',
          key_iv TEXT,
          created_at BIGINT NOT NULL,
          last_read_message_id JSONB DEFAULT '{}'
        )
      `;

      // 3. Create messages table
      await sql`
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          room_id TEXT NOT NULL,
          sender_id TEXT NOT NULL,
          sender_username TEXT NOT NULL,
          encrypted_text TEXT NOT NULL,
          iv TEXT NOT NULL,
          timestamp BIGINT NOT NULL,
          is_system BOOLEAN DEFAULT false,
          deleted_at BIGINT
        )
      `;

      // 4. Mark all users as offline on startup to prevent ghost presences
      await sql`
        UPDATE users SET is_online = false
      `;

      console.log('[DATABASE] PostgreSQL tables initialized and user statuses reset successfully!');
    } catch (err) {
      console.error('[DATABASE] Critical error executing schema migration. Falling back to JSON DB:', err);
      this.isPostgres = false;
      sql = null;
    }
  },

  // USERS
  async getUserById(id: string): Promise<User | null> {
    if (this.isPostgres && sql) {
      const rows = await sql`SELECT * FROM users WHERE id = ${id}`;
      return rows.length > 0 ? mapUser(rows[0]) : null;
    } else {
      return memoryDb.users[id] || null;
    }
  },

  async getUserByUsername(username: string): Promise<User | null> {
    if (this.isPostgres && sql) {
      const rows = await sql`SELECT * FROM users WHERE LOWER(username) = LOWER(${username})`;
      return rows.length > 0 ? mapUser(rows[0]) : null;
    } else {
      const user = userIndexByUsername[username.toLowerCase()];
      return user || null;
    }
  },

  async getAllUsers(): Promise<User[]> {
    if (this.isPostgres && sql) {
      const rows = await sql`SELECT * FROM users ORDER BY username ASC`;
      return rows.map(mapUser);
    } else {
      return Object.values(memoryDb.users);
    }
  },

  async saveUser(user: User): Promise<void> {
    if (this.isPostgres && sql) {
      await sql`
        INSERT INTO users (id, username, public_key, is_online, last_seen)
        VALUES (${user.id}, ${user.username}, ${user.publicKey}, ${user.isOnline}, ${user.lastSeen})
        ON CONFLICT (id) DO UPDATE SET
          username = EXCLUDED.username,
          public_key = EXCLUDED.public_key,
          is_online = EXCLUDED.is_online,
          last_seen = EXCLUDED.last_seen
      `;
    } else {
      memoryDb.users[user.id] = user;
      userIndexByUsername[user.username.toLowerCase()] = user;
      saveMemoryDb();
    }
  },

  async setAllUsersOffline(): Promise<void> {
    if (this.isPostgres && sql) {
      await sql`UPDATE users SET is_online = false`;
    } else {
      for (const id in memoryDb.users) {
        memoryDb.users[id].isOnline = false;
      }
      saveMemoryDb();
    }
  },

  // ROOMS
  async getRoomById(id: string): Promise<Room | null> {
    if (this.isPostgres && sql) {
      const rows = await sql`SELECT * FROM rooms WHERE id = ${id}`;
      return rows.length > 0 ? mapRoom(rows[0]) : null;
    } else {
      return memoryDb.rooms[id] || null;
    }
  },

  async getUserRooms(userId: string): Promise<Room[]> {
    if (this.isPostgres && sql) {
      // Find rooms where userId exists in the participants TEXT[] array
      const rows = await sql`SELECT * FROM rooms WHERE ${userId} = ANY(participants) ORDER BY created_at DESC`;
      return rows.map(mapRoom);
    } else {
      return Object.values(memoryDb.rooms).filter(room => room.participants.includes(userId));
    }
  },

  async findDirectRoom(userId1: string, userId2: string): Promise<Room | null> {
    if (this.isPostgres && sql) {
      const rows = await sql`
        SELECT * FROM rooms 
        WHERE type = 'direct' 
          AND array_length(participants, 1) = 2 
          AND ${userId1} = ANY(participants) 
          AND ${userId2} = ANY(participants)
        LIMIT 1
      `;
      return rows.length > 0 ? mapRoom(rows[0]) : null;
    } else {
      const existingDirect = Object.values(memoryDb.rooms).find(room =>
        room.type === 'direct' &&
        room.participants.length === 2 &&
        room.participants.includes(userId1) &&
        room.participants.includes(userId2)
      );
      return existingDirect || null;
    }
  },

  async saveRoom(room: Room): Promise<void> {
    if (this.isPostgres && sql) {
      const encryptedKeys = JSON.stringify(room.encryptedKeys || {});
      const lastReadMessageId = JSON.stringify(room.lastReadMessageId || {});
      
      await sql`
        INSERT INTO rooms (id, name, type, participants, encrypted_keys, key_iv, created_at, last_read_message_id)
        VALUES (${room.id}, ${room.name}, ${room.type}, ${room.participants}, ${encryptedKeys}::jsonb, ${room.keyIv || null}, ${room.createdAt}, ${lastReadMessageId}::jsonb)
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          type = EXCLUDED.type,
          participants = EXCLUDED.participants,
          encrypted_keys = EXCLUDED.encrypted_keys,
          key_iv = EXCLUDED.key_iv,
          last_read_message_id = EXCLUDED.last_read_message_id
      `;
    } else {
      memoryDb.rooms[room.id] = room;
      if (!messageIndexByRoom[room.id]) {
        messageIndexByRoom[room.id] = [];
      }
      saveMemoryDb();
    }
  },

  // MESSAGES
  async getMessageById(id: string): Promise<Message | null> {
    if (this.isPostgres && sql) {
      const rows = await sql`SELECT * FROM messages WHERE id = ${id}`;
      return rows.length > 0 ? mapMessage(rows[0]) : null;
    } else {
      return messageIndexById[id] || null;
    }
  },

  async getMessagesByRoom(roomId: string): Promise<Message[]> {
    if (this.isPostgres && sql) {
      const rows = await sql`SELECT * FROM messages WHERE room_id = ${roomId} ORDER BY timestamp ASC`;
      return rows.map(mapMessage);
    } else {
      return messageIndexByRoom[roomId] || [];
    }
  },

  async saveMessage(message: Message): Promise<void> {
    if (this.isPostgres && sql) {
      await sql`
        INSERT INTO messages (id, room_id, sender_id, sender_username, encrypted_text, iv, timestamp, is_system, deleted_at)
        VALUES (${message.id}, ${message.roomId}, ${message.senderId}, ${message.senderUsername}, ${message.encryptedText}, ${message.iv}, ${message.timestamp}, ${message.isSystem || false}, ${message.deletedAt || null})
        ON CONFLICT (id) DO UPDATE SET
          encrypted_text = EXCLUDED.encrypted_text,
          iv = EXCLUDED.iv,
          deleted_at = EXCLUDED.deleted_at
      `;
    } else {
      // Avoid duplicate push
      const existingIndex = memoryDb.messages.findIndex(m => m.id === message.id);
      if (existingIndex !== -1) {
        memoryDb.messages[existingIndex] = message;
      } else {
        memoryDb.messages.push(message);
      }
      
      messageIndexById[message.id] = message;
      if (!messageIndexByRoom[message.roomId]) {
        messageIndexByRoom[message.roomId] = [];
      }
      // Rebuild room list to keep index up to date without duplication
      const rList = messageIndexByRoom[message.roomId];
      const rIdx = rList.findIndex(m => m.id === message.id);
      if (rIdx !== -1) {
        rList[rIdx] = message;
      } else {
        rList.push(message);
      }

      saveMemoryDb();
    }
  },

  async getUnreadCount(roomId: string, userId: string): Promise<number> {
    if (this.isPostgres && sql) {
      // Find the last read message timestamp or message ID
      const roomRows = await sql`SELECT last_read_message_id FROM rooms WHERE id = ${roomId}`;
      if (roomRows.length === 0) return 0;
      
      const lastReadMap = roomRows[0].last_read_message_id || {};
      const lastReadId = lastReadMap[userId];
      
      if (!lastReadId) {
        // Count all non-system, active messages in this room
        const countRows = await sql`
          SELECT COUNT(*)::int as count FROM messages 
          WHERE room_id = ${roomId} 
            AND is_system = false 
            AND deleted_at IS NULL
        `;
        return countRows[0].count;
      }

      // Get timestamp of the last read message
      const msgRows = await sql`SELECT timestamp FROM messages WHERE id = ${lastReadId}`;
      if (msgRows.length === 0) {
        const countRows = await sql`
          SELECT COUNT(*)::int as count FROM messages 
          WHERE room_id = ${roomId} 
            AND is_system = false 
            AND deleted_at IS NULL
        `;
        return countRows[0].count;
      }

      const lastReadTimestamp = msgRows[0].timestamp;
      
      // Count messages newer than that timestamp
      const countRows = await sql`
        SELECT COUNT(*)::int as count FROM messages 
        WHERE room_id = ${roomId} 
          AND timestamp > ${lastReadTimestamp} 
          AND is_system = false 
          AND deleted_at IS NULL
      `;
      return countRows[0].count;
    } else {
      const roomMessages = messageIndexByRoom[roomId] || [];
      const room = memoryDb.rooms[roomId];
      if (!room) return 0;

      const lastReadId = room.lastReadMessageId?.[userId];
      if (!lastReadId) {
        return roomMessages.filter(msg => !msg.isSystem && !msg.deletedAt).length;
      }

      const lastReadIndex = roomMessages.findIndex(m => m.id === lastReadId);
      if (lastReadIndex === -1) {
        return roomMessages.filter(msg => !msg.isSystem && !msg.deletedAt).length;
      }

      return roomMessages.slice(lastReadIndex + 1).filter(msg => !msg.isSystem && !msg.deletedAt).length;
    }
  }
};
