import os
import json
import asyncio
import logging
from typing import Dict, List, Optional, Any
import asyncpg

# Configure Logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("database")

DATA_DIR = os.path.join(os.getcwd(), "data")
DB_FILE = os.path.join(DATA_DIR, "db.json")

if not os.path.exists(DATA_DIR):
    os.makedirs(DATA_DIR, exist_ok=True)

DATABASE_URL = os.getenv("DATABASE_URL")
is_pg = bool(DATABASE_URL)

# Memory DB Schema
memory_db = {
    "users": {},
    "rooms": {},
    "messages": []
}

message_index_by_room = {}
message_index_by_id = {}
user_index_by_username = {}

def rebuild_indexes():
    global message_index_by_room, message_index_by_id, user_index_by_username
    message_index_by_room = {}
    message_index_by_id = {}
    user_index_by_username = {}

    for user_id, user in memory_db["users"].items():
        user_index_by_username[user["username"].lower()] = user

    for room_id in memory_db["rooms"]:
        message_index_by_room[room_id] = []

    for msg in memory_db["messages"]:
        message_index_by_id[msg["id"]] = msg
        room_id = msg["roomId"]
        if room_id not in message_index_by_room:
            message_index_by_room[room_id] = []
        message_index_by_room[room_id].append(msg)

def _init_fallback_db():
    global memory_db
    if os.path.exists(DB_FILE):
        try:
            with open(DB_FILE, "r", encoding="utf-8") as f:
                memory_db = json.load(f)
            if "users" not in memory_db:
                memory_db["users"] = {}
            if "rooms" not in memory_db:
                memory_db["rooms"] = {}
            if "messages" not in memory_db:
                memory_db["messages"] = []

            # Mark all users offline on startup
            for user_id in memory_db["users"]:
                memory_db["users"][user_id]["isOnline"] = False

            # Ensure room lastReadMessageId structure
            for room_id in memory_db["rooms"]:
                if "lastReadMessageId" not in memory_db["rooms"][room_id]:
                    memory_db["rooms"][room_id]["lastReadMessageId"] = {}

            rebuild_indexes()
            logger.info(f"[DATABASE] Loaded fallback JSON DB. Users: {len(memory_db['users'])}, Rooms: {len(memory_db['rooms'])}, Messages: {len(memory_db['messages'])}")
        except Exception as e:
            logger.error(f"[DATABASE] Error loading fallback DB: {e}")
            rebuild_indexes()
    else:
        rebuild_indexes()

# Load local JSON database initially if not using PG
if not is_pg:
    _init_fallback_db()

is_saving = False
needs_save_again = False

async def save_memory_db():
    global is_saving, needs_save_again
    if is_saving:
        needs_save_again = True
        return
    is_saving = True
    try:
        raw_content = json.dumps(memory_db, indent=2)
        # Run standard blocking file writing in executor
        await asyncio.to_thread(_write_db_file, raw_content)
    except Exception as e:
        logger.error(f"[DATABASE] Error saving DB: {e}")
    finally:
        is_saving = False
        if needs_save_again:
            needs_save_again = False
            await save_memory_db()

def _write_db_file(content: str):
    with open(DB_FILE, "w", encoding="utf-8") as f:
        f.write(content)

# PostgreSQL Pool
pool: Optional[asyncpg.Pool] = None

# DB Row Mappers
def map_user(row) -> dict:
    return {
        "id": row["id"],
        "username": row["username"],
        "password": row["password"] if "password" in row else "",
        "publicKey": row["public_key"],
        "isOnline": row["is_online"],
        "lastSeen": int(row["last_seen"])
    }

def map_room(row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "type": row["type"],
        "participants": row["participants"],
        "encryptedKeys": json.loads(row["encrypted_keys"]) if isinstance(row["encrypted_keys"], str) else (row["encrypted_keys"] or {}),
        "keyIv": row["key_iv"],
        "createdAt": int(row["created_at"]),
        "lastReadMessageId": json.loads(row["last_read_message_id"]) if isinstance(row["last_read_message_id"], str) else (row["last_read_message_id"] or {})
    }

def map_message(row) -> dict:
    res = {
        "id": row["id"],
        "roomId": row["room_id"],
        "senderId": row["sender_id"],
        "senderUsername": row["sender_username"],
        "encryptedText": row["encrypted_text"],
        "iv": row["iv"],
        "timestamp": int(row["timestamp"])
    }
    if row.get("is_system") is not None:
        res["isSystem"] = row["is_system"]
    if row.get("deleted_at") is not None:
        res["deletedAt"] = int(row["deleted_at"])
    return res

class DatabaseService:
    @property
    def is_postgres(self) -> bool:
        return is_pg and pool is not None

    async def initialize(self):
        global pool
        if not is_pg:
            logger.info("[DATABASE] Using local JSON storage.")
            return

        # Prepare connection URL
        url = DATABASE_URL
        if url and url.startswith("postgres://"):
            # asyncpg needs postgresql:// scheme
            url = url.replace("postgres://", "postgresql://", 1)

        logger.info("[DATABASE] Initializing PostgreSQL pool...")
        try:
            pool = await asyncpg.create_pool(
                url,
                min_size=2,
                max_size=15,
                timeout=30.0,
                command_timeout=60.0
            )

            # Schema Migration
            async with pool.acquire() as conn:
                logger.info("[DATABASE] Executing schema migrations...")
                await conn.execute("""
                    CREATE TABLE IF NOT EXISTS users (
                        id TEXT PRIMARY KEY,
                        username TEXT UNIQUE NOT NULL,
                        password TEXT NOT NULL DEFAULT '',
                        public_key TEXT NOT NULL,
                        is_online BOOLEAN NOT NULL DEFAULT false,
                        last_seen BIGINT NOT NULL
                    )
                """)
                # Alter table to add password if it doesn't exist for existing databases
                await conn.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS password TEXT NOT NULL DEFAULT ''")
                await conn.execute("""
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
                """)
                await conn.execute("""
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
                """)
                # Mark everyone offline
                await conn.execute("UPDATE users SET is_online = false")
                logger.info("[DATABASE] Migrations executed and user statuses reset successfully.")
        except Exception as e:
            # Print a beautiful and highly visible developer error/diagnostic guide for resume reviewers
            url = DATABASE_URL or ""
            is_supabase_direct = "db.supabase.co" in url or "supabase.co:5432" in url
            is_ipv6_msg = "does not appear to be an IPv4 or IPv6 address" in str(e)
            
            if is_supabase_direct or is_ipv6_msg:
                logger.error("\n" + "="*80 + "\n"
                             "🚨 DATABASE CONFIGURATION WARNING (IPv6 DIRECT VS IPV4 POOLER):\n"
                             "It looks like you are attempting to connect to a direct Supabase host ('db.xxxx.supabase.co')\n"
                             "on port 5432. Since early 2024, Supabase has operated on IPv6-only for direct connections.\n"
                             "Many hosting environments (including Render, AWS ECS/Fargate, and basic hosting providers)\n"
                             "do not support IPv6 routing by default, causing this asyncpg connection error.\n\n"
                             "👉 HOW TO FIX THIS IN RENDER / PRODUCTION:\n"
                             "1. Go to your Supabase project dashboard -> Settings -> Database.\n"
                             "2. Scroll down to 'Connection string', select 'URI', and make sure 'Pooler' is selected.\n"
                             "3. Copy the URL. It will use the '*.pooler.supabase.com' host on port 6543 (Transaction mode).\n"
                             "4. Update your DATABASE_URL environment variable in your Render settings with this pooler URL.\n"
                             "   (e.g., postgresql://postgres.xxxx:[pwd]@aws-0-xxxx.pooler.supabase.com:6543/postgres?sslmode=require)\n"
                             + "="*80 + "\n")
            else:
                logger.error(f"[DATABASE] Database connection failed. Falling back to memory/JSON storage mode: {e}")
            
            pool = None
            _init_fallback_db()

    # USERS
    async def get_user_by_id(self, user_id: str) -> Optional[dict]:
        if self.is_postgres:
            async with pool.acquire() as conn:
                row = await conn.fetchrow("SELECT * FROM users WHERE id = $1", user_id)
                return map_user(row) if row else None
        else:
            return memory_db["users"].get(user_id)

    async def get_user_by_username(self, username: str) -> Optional[dict]:
        if self.is_postgres:
            async with pool.acquire() as conn:
                row = await conn.fetchrow("SELECT * FROM users WHERE LOWER(username) = LOWER($1)", username)
                return map_user(row) if row else None
        else:
            return user_index_by_username.get(username.lower())

    async def get_all_users(self) -> List[dict]:
        if self.is_postgres:
            async with pool.acquire() as conn:
                rows = await conn.fetch("SELECT * FROM users ORDER BY username ASC")
                return [map_user(row) for row in rows]
        else:
            return sorted(list(memory_db["users"].values()), key=lambda u: u["username"])

    async def save_user(self, user: dict):
        if self.is_postgres:
            async with pool.acquire() as conn:
                await conn.execute("""
                    INSERT INTO users (id, username, password, public_key, is_online, last_seen)
                    VALUES ($1, $2, $3, $4, $5, $6)
                    ON CONFLICT (id) DO UPDATE SET
                        username = EXCLUDED.username,
                        password = EXCLUDED.password,
                        public_key = EXCLUDED.public_key,
                        is_online = EXCLUDED.is_online,
                        last_seen = EXCLUDED.last_seen
                """, user["id"], user["username"], user.get("password", ""), user["publicKey"], user["isOnline"], user["lastSeen"])
        else:
            user_id = user["id"]
            memory_db["users"][user_id] = user
            user_index_by_username[user["username"].lower()] = user
            await save_memory_db()

    async def set_all_users_offline(self):
        if self.is_postgres:
            async with pool.acquire() as conn:
                await conn.execute("UPDATE users SET is_online = false")
        else:
            for user_id in memory_db["users"]:
                memory_db["users"][user_id]["isOnline"] = False
            await save_memory_db()

    # ROOMS
    async def get_room_by_id(self, room_id: str) -> Optional[dict]:
        if self.is_postgres:
            async with pool.acquire() as conn:
                row = await conn.fetchrow("SELECT * FROM rooms WHERE id = $1", room_id)
                return map_room(row) if row else None
        else:
            return memory_db["rooms"].get(room_id)

    async def get_user_rooms(self, user_id: str) -> List[dict]:
        if self.is_postgres:
            async with pool.acquire() as conn:
                rows = await conn.fetch("SELECT * FROM rooms WHERE $1 = ANY(participants) ORDER BY created_at DESC", user_id)
                return [map_room(row) for row in rows]
        else:
            user_rooms = []
            for room in memory_db["rooms"].values():
                if user_id in room["participants"]:
                    user_rooms.append(room)
            return sorted(user_rooms, key=lambda r: r["createdAt"], reverse=True)

    async def find_direct_room(self, user_id1: str, user_id2: str) -> Optional[dict]:
        if self.is_postgres:
            async with pool.acquire() as conn:
                row = await conn.fetchrow("""
                    SELECT * FROM rooms 
                    WHERE type = 'direct' 
                      AND array_length(participants, 1) = 2 
                      AND $1 = ANY(participants) 
                      AND $2 = ANY(participants)
                    LIMIT 1
                """, user_id1, user_id2)
                return map_room(row) if row else None
        else:
            for room in memory_db["rooms"].values():
                if room["type"] == "direct" and len(room["participants"]) == 2:
                    if user_id1 in room["participants"] and user_id2 in room["participants"]:
                        return room
            return None

    async def save_room(self, room: dict):
        if self.is_postgres:
            encrypted_keys = json.dumps(room.get("encryptedKeys", {}))
            last_read_message_id = json.dumps(room.get("lastReadMessageId", {}))
            async with pool.acquire() as conn:
                await conn.execute("""
                    INSERT INTO rooms (id, name, type, participants, encrypted_keys, key_iv, created_at, last_read_message_id)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                    ON CONFLICT (id) DO UPDATE SET
                        name = EXCLUDED.name,
                        type = EXCLUDED.type,
                        participants = EXCLUDED.participants,
                        encrypted_keys = EXCLUDED.encrypted_keys,
                        key_iv = EXCLUDED.key_iv,
                        last_read_message_id = EXCLUDED.last_read_message_id
                """, room["id"], room["name"], room["type"], room["participants"], encrypted_keys, room.get("keyIv"), room["createdAt"], last_read_message_id)
        else:
            room_id = room["id"]
            memory_db["rooms"][room_id] = room
            if room_id not in message_index_by_room:
                message_index_by_room[room_id] = []
            await save_memory_db()

    # MESSAGES
    async def get_message_by_id(self, message_id: str) -> Optional[dict]:
        if self.is_postgres:
            async with pool.acquire() as conn:
                row = await conn.fetchrow("SELECT * FROM messages WHERE id = $1", message_id)
                return map_message(row) if row else None
        else:
            return message_index_by_id.get(message_id)

    async def get_messages_by_room(self, room_id: str) -> List[dict]:
        if self.is_postgres:
            async with pool.acquire() as conn:
                rows = await conn.fetch("SELECT * FROM messages WHERE room_id = $1 ORDER BY timestamp ASC", room_id)
                return [map_message(row) for row in rows]
        else:
            return message_index_by_room.get(room_id, [])

    async def save_message(self, message: dict):
        if self.is_postgres:
            async with pool.acquire() as conn:
                await conn.execute("""
                    INSERT INTO messages (id, room_id, sender_id, sender_username, encrypted_text, iv, timestamp, is_system, deleted_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                    ON CONFLICT (id) DO UPDATE SET
                        encrypted_text = EXCLUDED.encrypted_text,
                        iv = EXCLUDED.iv,
                        deleted_at = EXCLUDED.deleted_at
                """, message["id"], message["roomId"], message["senderId"], message["senderUsername"], message["encryptedText"], message["iv"], message["timestamp"], message.get("isSystem", False), message.get("deletedAt"))
        else:
            msg_id = message["id"]
            room_id = message["roomId"]
            
            # Avoid duplicate push
            existing_idx = -1
            for idx, msg in enumerate(memory_db["messages"]):
                if msg["id"] == msg_id:
                    existing_idx = idx
                    break
            
            if existing_idx != -1:
                memory_db["messages"][existing_idx] = message
            else:
                memory_db["messages"].append(message)

            message_index_by_id[msg_id] = message
            if room_id not in message_index_by_room:
                message_index_by_room[room_id] = []
            
            r_list = message_index_by_room[room_id]
            r_idx = -1
            for idx, msg in enumerate(r_list):
                if msg["id"] == msg_id:
                    r_idx = idx
                    break
            
            if r_idx != -1:
                r_list[r_idx] = message
            else:
                r_list.append(message)

            await save_memory_db()

    async def get_unread_count(self, room_id: str, user_id: str) -> int:
        if self.is_postgres:
            async with pool.acquire() as conn:
                room_row = await conn.fetchrow("SELECT last_read_message_id FROM rooms WHERE id = $1", room_id)
                if not room_row:
                    return 0
                
                last_read_map = room_row["last_read_message_id"] or {}
                if isinstance(last_read_map, str):
                    last_read_map = json.loads(last_read_map)
                
                last_read_id = last_read_map.get(user_id)
                if not last_read_id:
                    cnt_row = await conn.fetchrow("""
                        SELECT COUNT(*)::int as count FROM messages 
                        WHERE room_id = $1 
                          AND is_system = false 
                          AND deleted_at IS NULL
                    """, room_id)
                    return cnt_row["count"] if cnt_row else 0

                msg_row = await conn.fetchrow("SELECT timestamp FROM messages WHERE id = $1", last_read_id)
                if not msg_row:
                    cnt_row = await conn.fetchrow("""
                        SELECT COUNT(*)::int as count FROM messages 
                        WHERE room_id = $1 
                          AND is_system = false 
                          AND deleted_at IS NULL
                    """, room_id)
                    return cnt_row["count"] if cnt_row else 0

                last_read_timestamp = msg_row["timestamp"]
                cnt_row = await conn.fetchrow("""
                    SELECT COUNT(*)::int as count FROM messages 
                    WHERE room_id = $1 
                      AND timestamp > $2 
                      AND is_system = false 
                      AND deleted_at IS NULL
                """, room_id, last_read_timestamp)
                return cnt_row["count"] if cnt_row else 0
        else:
            room_messages = message_index_by_room.get(room_id, [])
            room = memory_db["rooms"].get(room_id)
            if not room:
                return 0

            last_read_id = room.get("lastReadMessageId", {}).get(user_id)
            if not last_read_id:
                return len([m for m in room_messages if not m.get("isSystem") and not m.get("deletedAt")])

            last_read_idx = -1
            for idx, m in enumerate(room_messages):
                if m["id"] == last_read_id:
                    last_read_idx = idx
                    break

            if last_read_idx == -1:
                return len([m for m in room_messages if not m.get("isSystem") and not m.get("deletedAt")])

            return len([m for m in room_messages[last_read_idx + 1:] if not m.get("isSystem") and not m.get("deletedAt")])

db_service = DatabaseService()
