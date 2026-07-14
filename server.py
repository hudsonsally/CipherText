import os
import json
import time
import asyncio
import httpx
from typing import Dict, List, Optional
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles

# Setup storage paths
DATA_DIR = os.path.join(os.getcwd(), "data")
DB_FILE = os.path.join(DATA_DIR, "db.json")

# Core Data Mapper helpers for DB Row parsing
def map_user(row) -> dict:
    return {
        "id": row["id"],
        "username": row["username"],
        "publicKey": row["public_key"],
        "isOnline": row["is_online"],
        "lastSeen": int(row["last_seen"])
    }

def map_room(row) -> dict:
    # Safely handle JSONB as dict or string
    encrypted_keys = row["encrypted_keys"]
    if isinstance(encrypted_keys, str):
        encrypted_keys = json.loads(encrypted_keys or "{}")
        
    last_read = row["last_read_message_id"]
    if isinstance(last_read, str):
        last_read = json.loads(last_read or "{}")

    return {
        "id": row["id"],
        "name": row["name"],
        "type": row["type"],
        "participants": row["participants"], # asyncpg maps arrays to lists automatically
        "encryptedKeys": encrypted_keys or {},
        "keyIv": row["key_iv"],
        "createdAt": int(row["created_at"]),
        "lastReadMessageId": last_read or {}
    }

def map_message(row) -> dict:
    msg = {
        "id": row["id"],
        "roomId": row["room_id"],
        "senderId": row["sender_id"],
        "senderUsername": row["sender_username"],
        "encryptedText": row["encrypted_text"],
        "iv": row["iv"],
        "timestamp": int(row["timestamp"])
    }
    if row.get("is_system"):
        msg["isSystem"] = True
    if row.get("deleted_at") is not None:
        msg["deletedAt"] = int(row["deleted_at"])
    return msg

# Database Service supporting both PostgreSQL (asyncpg) and JSON Fallback
class DatabaseService:
    def __init__(self):
        self.is_postgres = False
        self.pool = None
        self.write_lock = asyncio.Lock()
        
        # In-memory JSON fallback structures
        self.memory_db = {
            "users": {},
            "rooms": {},
            "messages": []
        }
        self.message_index_by_room = {}
        self.message_index_by_id = {}
        self.user_index_by_username = {}

    async def initialize(self):
        database_url = os.environ.get("DATABASE_URL")
        if database_url:
            try:
                import asyncpg
                print("[DATABASE] Initializing PostgreSQL connection pool...")
                self.pool = await asyncpg.create_pool(
                    database_url,
                    min_size=2,
                    max_size=15,
                    timeout=10.0,
                    command_timeout=30.0
                )
                
                # Check connection and execute migrations
                async with self.pool.acquire() as conn:
                    print("[DATABASE] Connection established. Running migrations...")
                    await conn.execute("""
                        CREATE TABLE IF NOT EXISTS users (
                            id TEXT PRIMARY KEY,
                            username TEXT UNIQUE NOT NULL,
                            public_key TEXT NOT NULL,
                            is_online BOOLEAN NOT NULL DEFAULT false,
                            last_seen BIGINT NOT NULL
                        )
                    """)
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
                    # Set all users offline on boot
                    await conn.execute("UPDATE users SET is_online = false")
                    
                self.is_postgres = True
                print("[DATABASE] PostgreSQL initialization completed successfully.")
                return
            except Exception as e:
                print(f"[DATABASE] Connection to PostgreSQL failed: {e}. Falling back to JSON...")
                self.is_postgres = False
                self.pool = None

        # Fallback to local JSON storage
        print("[DATABASE] No active PostgreSQL connection. Initializing fallback JSON store...")
        os.makedirs(DATA_DIR, exist_ok=True)
        if os.path.exists(DB_FILE):
            try:
                with open(DB_FILE, "r", encoding="utf-8") as f:
                    self.memory_db = json.load(f)
                    if "users" not in self.memory_db:
                        self.memory_db["users"] = {}
                    if "rooms" not in self.memory_db:
                        self.memory_db["rooms"] = {}
                    if "messages" not in self.memory_db:
                        self.memory_db["messages"] = []
                        
                    # Reset online status
                    for uid in self.memory_db["users"]:
                        self.memory_db["users"][uid]["isOnline"] = False
                    
                    self.rebuild_memory_indices()
                    print(f"[DATABASE] Fallback JSON database loaded and indexed. Users: {len(self.memory_db['users'])}, Rooms: {len(self.memory_db['rooms'])}, Messages: {len(self.memory_db['messages'])}")
            except Exception as e:
                print(f"[DATABASE] Error loading fallback DB file: {e}. Starting fresh.")
                self.rebuild_memory_indices()
        else:
            self.rebuild_memory_indices()

    def rebuild_memory_indices(self):
        self.message_index_by_room = {}
        self.message_index_by_id = {}
        self.user_index_by_username = {}

        for user_id, user in self.memory_db["users"].items():
            self.user_index_by_username[user["username"].lower()] = user

        for room_id in self.memory_db["rooms"]:
            self.message_index_by_room[room_id] = []

        for msg in self.memory_db["messages"]:
            self.message_index_by_id[msg["id"]] = msg
            rid = msg["roomId"]
            if rid not in self.message_index_by_room:
                self.message_index_by_room[rid] = []
            self.message_index_by_room[rid].append(msg)

    async def save_memory_db(self):
        async with self.write_lock:
            def write_sync():
                os.makedirs(DATA_DIR, exist_ok=True)
                with open(DB_FILE, "w", encoding="utf-8") as f:
                    json.dump(self.memory_db, f, indent=2)
            await asyncio.to_thread(write_sync)

    # USER CRUD APIs
    async def get_user_by_id(self, user_id: str) -> Optional[dict]:
        if self.is_postgres and self.pool:
            async with self.pool.acquire() as conn:
                row = await conn.fetchrow("SELECT * FROM users WHERE id = $1", user_id)
                return map_user(row) if row else None
        else:
            return self.memory_db["users"].get(user_id)

    async def get_user_by_username(self, username: str) -> Optional[dict]:
        if self.is_postgres and self.pool:
            async with self.pool.acquire() as conn:
                row = await conn.fetchrow("SELECT * FROM users WHERE LOWER(username) = LOWER($1)", username)
                return map_user(row) if row else None
        else:
            return self.user_index_by_username.get(username.lower())

    async def get_all_users(self) -> List[dict]:
        if self.is_postgres and self.pool:
            async with self.pool.acquire() as conn:
                rows = await conn.fetch("SELECT * FROM users ORDER BY username ASC")
                return [map_user(row) for row in rows]
        else:
            return list(self.memory_db["users"].values())

    async def save_user(self, user: dict):
        if self.is_postgres and self.pool:
            async with self.pool.acquire() as conn:
                await conn.execute("""
                    INSERT INTO users (id, username, public_key, is_online, last_seen)
                    VALUES ($1, $2, $3, $4, $5)
                    ON CONFLICT (id) DO UPDATE SET
                        username = EXCLUDED.username,
                        public_key = EXCLUDED.public_key,
                        is_online = EXCLUDED.is_online,
                        last_seen = EXCLUDED.last_seen
                """, user["id"], user["username"], user["publicKey"], user["isOnline"], user["lastSeen"])
        else:
            self.memory_db["users"][user["id"]] = user
            self.user_index_by_username[user["username"].lower()] = user
            await self.save_memory_db()

    # ROOM CRUD APIs
    async def get_room_by_id(self, room_id: str) -> Optional[dict]:
        if self.is_postgres and self.pool:
            async with self.pool.acquire() as conn:
                row = await conn.fetchrow("SELECT * FROM rooms WHERE id = $1", room_id)
                return map_room(row) if row else None
        else:
            return self.memory_db["rooms"].get(room_id)

    async def get_user_rooms(self, user_id: str) -> List[dict]:
        if self.is_postgres and self.pool:
            async with self.pool.acquire() as conn:
                rows = await conn.fetch("SELECT * FROM rooms WHERE $1 = ANY(participants) ORDER BY created_at DESC", user_id)
                return [map_room(row) for row in rows]
        else:
            return [room for room in self.memory_db["rooms"].values() if user_id in room.get("participants", [])]

    async def find_direct_room(self, user_id1: str, user_id2: str) -> Optional[dict]:
        if self.is_postgres and self.pool:
            async with self.pool.acquire() as conn:
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
            for room in self.memory_db["rooms"].values():
                participants = room.get("participants", [])
                if room.get("type") == "direct" and len(participants) == 2 and user_id1 in participants and user_id2 in participants:
                    return room
            return None

    async def save_room(self, room: dict):
        if self.is_postgres and self.pool:
            encrypted_keys = json.dumps(room.get("encryptedKeys") or {})
            last_read = json.dumps(room.get("lastReadMessageId") or {})
            async with self.pool.acquire() as conn:
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
                """, room["id"], room["name"], room["type"], room["participants"], encrypted_keys, room.get("keyIv"), room["createdAt"], last_read)
        else:
            self.memory_db["rooms"][room["id"]] = room
            if room["id"] not in self.message_index_by_room:
                self.message_index_by_room[room["id"]] = []
            await self.save_memory_db()

    # MESSAGE CRUD APIs
    async def get_message_by_id(self, message_id: str) -> Optional[dict]:
        if self.is_postgres and self.pool:
            async with self.pool.acquire() as conn:
                row = await conn.fetchrow("SELECT * FROM messages WHERE id = $1", message_id)
                return map_message(row) if row else None
        else:
            return self.message_index_by_id.get(message_id)

    async def get_messages_by_room(self, room_id: str) -> List[dict]:
        if self.is_postgres and self.pool:
            async with self.pool.acquire() as conn:
                rows = await conn.fetch("SELECT * FROM messages WHERE room_id = $1 ORDER BY timestamp ASC", room_id)
                return [map_message(row) for row in rows]
        else:
            return self.message_index_by_room.get(room_id, [])

    async def save_message(self, message: dict):
        if self.is_postgres and self.pool:
            async with self.pool.acquire() as conn:
                await conn.execute("""
                    INSERT INTO messages (id, room_id, sender_id, sender_username, encrypted_text, iv, timestamp, is_system, deleted_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                    ON CONFLICT (id) DO UPDATE SET
                        encrypted_text = EXCLUDED.encrypted_text,
                        iv = EXCLUDED.iv,
                        deleted_at = EXCLUDED.deleted_at
                """, message["id"], message["roomId"], message["senderId"], message["senderUsername"], message["encryptedText"], message["iv"], message["timestamp"], message.get("isSystem") or False, message.get("deletedAt"))
        else:
            messages_list = self.memory_db["messages"]
            existing_idx = next((i for i, m in enumerate(messages_list) if m["id"] == message["id"]), -1)
            if existing_idx != -1:
                messages_list[existing_idx] = message
            else:
                messages_list.append(message)

            self.message_index_by_id[message["id"]] = message
            rid = message["roomId"]
            if rid not in self.message_index_by_room:
                self.message_index_by_room[rid] = []

            r_list = self.message_index_by_room[rid]
            r_idx = next((i for i, m in enumerate(r_list) if m["id"] == message["id"]), -1)
            if r_idx != -1:
                r_list[r_idx] = message
            else:
                r_list.append(message)

            await self.save_memory_db()

    async def get_unread_count(self, room_id: str, user_id: str) -> int:
        if self.is_postgres and self.pool:
            async with self.pool.acquire() as conn:
                room_rows = await conn.fetch("SELECT last_read_message_id FROM rooms WHERE id = $1", room_id)
                if not room_rows:
                    return 0

                last_read_map = room_rows[0]["last_read_message_id"] or {}
                if isinstance(last_read_map, str):
                    last_read_map = json.loads(last_read_map)

                last_read_id = last_read_map.get(user_id)
                if not last_read_id:
                    count_rows = await conn.fetch("""
                        SELECT COUNT(*)::int as count FROM messages
                        WHERE room_id = $1 AND is_system = false AND deleted_at IS NULL
                    """, room_id)
                    return count_rows[0]["count"]

                msg_rows = await conn.fetch("SELECT timestamp FROM messages WHERE id = $1", last_read_id)
                if not msg_rows:
                    count_rows = await conn.fetch("""
                        SELECT COUNT(*)::int as count FROM messages
                        WHERE room_id = $1 AND is_system = false AND deleted_at IS NULL
                    """, room_id)
                    return count_rows[0]["count"]

                last_read_timestamp = msg_rows[0]["timestamp"]
                count_rows = await conn.fetch("""
                    SELECT COUNT(*)::int as count FROM messages
                    WHERE room_id = $1 AND timestamp > $2 AND is_system = false AND deleted_at IS NULL
                """, room_id, last_read_timestamp)
                return count_rows[0]["count"]
        else:
            room_messages = self.message_index_by_room.get(room_id, [])
            room = self.memory_db["rooms"].get(room_id)
            if not room:
                return 0

            last_read_id = room.get("lastReadMessageId", {}).get(user_id)
            if not last_read_id:
                return len([msg for msg in room_messages if not msg.get("isSystem") and not msg.get("deletedAt")])

            last_read_idx = next((i for i, m in enumerate(room_messages) if m["id"] == last_read_id), -1)
            if last_read_idx == -1:
                return len([msg for msg in room_messages if not msg.get("isSystem") and not msg.get("deletedAt")])

            return len([msg for msg in room_messages[last_read_idx + 1:] if not msg.get("isSystem") and not msg.get("deletedAt")])

# Initialize FastAPI App & Database Service
db_service = DatabaseService()
app = FastAPI(title="CipherChat E2EE Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.on_event("startup")
async def startup_event():
    await db_service.initialize()

# REST Endpoints
@app.get("/api/health")
async def health_check():
    try:
        all_users = await db_service.get_all_users()
        return {
            "status": "ok",
            "postgres": db_service.is_postgres,
            "usersCount": len(all_users)
        }
    except Exception as e:
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})

@app.get("/api/users/check/{username}")
async def check_username(username: str):
    try:
        user = await db_service.get_user_by_username(username)
        return {"exists": user is not None}
    except Exception as e:
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})

@app.get("/api/rooms/{room_id}/messages")
async def get_room_messages(room_id: str):
    try:
        messages = await db_service.get_messages_by_room(room_id)
        room_messages = []
        for msg in messages:
            if msg.get("deletedAt"):
                m = dict(msg)
                m["encryptedText"] = ""
                m["iv"] = ""
                room_messages.append(m)
            else:
                room_messages.append(msg)
        return {"messages": room_messages}
    except Exception as e:
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})

# WebSocket connection manager
class ConnectionManager:
    def __init__(self):
        self.active_connections: Dict[str, WebSocket] = {}

    async def connect(self, user_id: str, websocket: WebSocket):
        self.active_connections[user_id] = websocket

    def disconnect(self, user_id: str):
        if user_id in self.active_connections:
            del self.active_connections[user_id]

    async def send_event(self, websocket: WebSocket, event_type: str, payload: dict):
        try:
            await websocket.send_json({
                "type": event_type,
                "payload": payload
            })
        except Exception:
            pass

    async def send_event_by_user(self, user_id: str, event_type: str, payload: dict):
        ws = self.active_connections.get(user_id)
        if ws:
            await self.send_event(ws, event_type, payload)

    async def broadcast_event(self, event_type: str, payload: dict):
        msg = {"type": event_type, "payload": payload}
        for ws in list(self.active_connections.values()):
            try:
                await ws.send_json(msg)
            except Exception:
                pass

manager = ConnectionManager()

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    current_user_id = None
    try:
        while True:
            data_str = await websocket.receive_text()
            try:
                event = json.loads(data_str)
            except ValueError:
                await manager.send_event(websocket, "server:error", {"message": "Invalid JSON"})
                continue

            event_type = event.get("type")
            payload = event.get("payload") or {}

            if event_type == "client:register":
                username = payload.get("username", "").strip()
                public_key = payload.get("publicKey", "")
                user_id = payload.get("id")

                if not username or not public_key:
                    await manager.send_event(websocket, "server:error", {"message": "Username and publicKey are required"})
                    continue

                user = await db_service.get_user_by_username(username)
                if user:
                    user["publicKey"] = public_key
                    user["isOnline"] = True
                    user["lastSeen"] = int(time.time() * 1000)
                else:
                    id_to_use = user_id or f"usr_{os.urandom(4).hex()}"
                    user = {
                        "id": id_to_use,
                        "username": username,
                        "publicKey": public_key,
                        "isOnline": True,
                        "lastSeen": int(time.time() * 1000)
                    }

                await db_service.save_user(user)
                current_user_id = user["id"]
                await manager.connect(current_user_id, websocket)

                rooms = await db_service.get_user_rooms(current_user_id)
                user_rooms = []
                for room in rooms:
                    unread_count = await db_service.get_unread_count(room["id"], current_user_id)
                    r = dict(room)
                    r["unreadCount"] = unread_count
                    user_rooms.append(r)

                all_users = await db_service.get_all_users()

                await manager.send_event(websocket, "server:registered", {
                    "user": user,
                    "rooms": user_rooms,
                    "users": all_users
                })

                await manager.broadcast_event("server:user_presence", {
                    "userId": current_user_id,
                    "isOnline": True
                })

                await manager.broadcast_event("server:user_list", {
                    "users": all_users
                })

            elif event_type == "client:room_create":
                if not current_user_id:
                    await manager.send_event(websocket, "server:error", {"message": "Not registered"})
                    continue

                name = payload.get("name", "").strip()
                room_type = payload.get("type", "direct")
                participants = payload.get("participants", [])
                encrypted_keys = payload.get("encryptedKeys") or {}
                key_iv = payload.get("keyIv")

                full_participants = list(set(participants + [current_user_id]))

                if room_type == "direct":
                    if len(full_participants) == 2:
                        existing_direct = await db_service.find_direct_room(full_participants[0], full_participants[1])
                        if existing_direct:
                            unread_count = await db_service.get_unread_count(existing_direct["id"], current_user_id)
                            r = dict(existing_direct)
                            r["unreadCount"] = unread_count
                            await manager.send_event(websocket, "server:room_created", {"room": r})
                            continue

                room_id = f"rm_{os.urandom(5).hex()}"
                new_room = {
                    "id": room_id,
                    "name": name if room_type == "group" else f"Direct Room {room_id}",
                    "type": room_type,
                    "participants": full_participants,
                    "encryptedKeys": encrypted_keys,
                    "keyIv": key_iv,
                    "createdAt": int(time.time() * 1000),
                    "lastReadMessageId": {}
                }

                await db_service.save_room(new_room)

                for p_id in full_participants:
                    unread_count = await db_service.get_unread_count(room_id, p_id)
                    r = dict(new_room)
                    r["unreadCount"] = unread_count
                    await manager.send_event_by_user(p_id, "server:room_created", {"room": r})

                sys_message_id = f"msg_sys_{os.urandom(5).hex()}"
                sys_message = {
                    "id": sys_message_id,
                    "roomId": room_id,
                    "senderId": "system",
                    "senderUsername": "System",
                    "encryptedText": "",
                    "iv": "",
                    "timestamp": int(time.time() * 1000),
                    "isSystem": True
                }
                await db_service.save_message(sys_message)

                for p_id in full_participants:
                    await manager.send_event_by_user(p_id, "server:message_receive", {"message": sys_message})

            elif event_type == "client:message_send":
                if not current_user_id:
                    await manager.send_event(websocket, "server:error", {"message": "Not registered"})
                    continue

                client_msg_id = payload.get("id")
                room_id = payload.get("roomId")
                encrypted_text = payload.get("encryptedText")
                iv = payload.get("iv")

                room = await db_service.get_room_by_id(room_id)
                if not room:
                    await manager.send_event(websocket, "server:error", {"message": "Room not found"})
                    continue

                if current_user_id not in room.get("participants", []):
                    await manager.send_event(websocket, "server:error", {"message": "Not participant of this room"})
                    continue

                message_id = client_msg_id or f"msg_{os.urandom(5).hex()}"

                existing_msg = await db_service.get_message_by_id(message_id)
                if existing_msg:
                    continue

                user = await db_service.get_user_by_id(current_user_id)
                new_message = {
                    "id": message_id,
                    "roomId": room_id,
                    "senderId": current_user_id,
                    "senderUsername": user.get("username") if user else "Unknown",
                    "encryptedText": encrypted_text,
                    "iv": iv,
                    "timestamp": int(time.time() * 1000)
                }

                await db_service.save_message(new_message)

                for p_id in room.get("participants", []):
                    await manager.send_event_by_user(p_id, "server:message_receive", {"message": new_message})

            elif event_type == "client:message_delete":
                if not current_user_id:
                    await manager.send_event(websocket, "server:error", {"message": "Not registered"})
                    continue

                room_id = payload.get("roomId")
                message_id = payload.get("messageId")

                room = await db_service.get_room_by_id(room_id)
                if not room:
                    await manager.send_event(websocket, "server:error", {"message": "Room not found"})
                    continue

                msg = await db_service.get_message_by_id(message_id)
                if not msg:
                    await manager.send_event(websocket, "server:error", {"message": "Message not found"})
                    continue

                if msg.get("senderId") != current_user_id:
                    await manager.send_event(websocket, "server:error", {"message": "Unauthorized"})
                    continue

                msg["deletedAt"] = int(time.time() * 1000)
                msg["encryptedText"] = ""
                msg["iv"] = ""
                await db_service.save_message(msg)

                for p_id in room.get("participants", []):
                    await manager.send_event_by_user(p_id, "server:message_deleted", {
                        "roomId": room_id,
                        "messageId": message_id
                    })

            elif event_type == "client:read_receipt":
                if not current_user_id:
                    continue

                room_id = payload.get("roomId")
                message_id = payload.get("messageId")

                room = await db_service.get_room_by_id(room_id)
                if not room:
                    continue

                if current_user_id not in room.get("participants", []):
                    continue

                last_read = room.get("lastReadMessageId") or {}
                last_read[current_user_id] = message_id
                room["lastReadMessageId"] = last_read
                await db_service.save_room(room)

                for p_id in room.get("participants", []):
                    if p_id != current_user_id:
                        await manager.send_event_by_user(p_id, "server:read_receipt", {
                            "roomId": room_id,
                            "userId": current_user_id,
                            "messageId": message_id
                        })

            elif event_type == "client:typing":
                if not current_user_id:
                    continue

                room_id = payload.get("roomId")
                is_typing = payload.get("isTyping", False)

                room = await db_service.get_room_by_id(room_id)
                if not room:
                    continue

                sender_user = await db_service.get_user_by_id(current_user_id)
                if not sender_user:
                    continue

                for p_id in room.get("participants", []):
                    if p_id != current_user_id:
                        await manager.send_event_by_user(p_id, "server:typing", {
                            "roomId": room_id,
                            "userId": current_user_id,
                            "username": sender_user.get("username", "Someone"),
                            "isTyping": is_typing
                        })

    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"[WS DISCONNECTED/ERROR] {e}")
    finally:
        if current_user_id:
            manager.disconnect(current_user_id)
            user = await db_service.get_user_by_id(current_user_id)
            if user:
                user["isOnline"] = False
                user["lastSeen"] = int(time.time() * 1000)
                await db_service.save_user(user)

                await manager.broadcast_event("server:user_presence", {
                    "userId": current_user_id,
                    "isOnline": False
                })

                all_users = await db_service.get_all_users()
                await manager.broadcast_event("server:user_list", {
                    "users": all_users
                })

# Proxy Vite in Development or Serve Static Files in Production
NODE_ENV = os.environ.get("NODE_ENV", "development")

if NODE_ENV != "production":
    print("[SERVER] Operating in DEVELOPMENT mode. Proxying non-API/non-WS routes to Vite (port 3001)")
    
    @app.api_route("/{full_path:path}", methods=["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD", "PATCH"])
    async def proxy_to_vite(request: Request, full_path: str):
        if full_path == "ws" or full_path.startswith("api/"):
            return Response("Not Found", status_code=404)

        async with httpx.AsyncClient() as client:
            query_str = request.url.query
            url = f"http://localhost:3001/{full_path}"
            if query_str:
                url += f"?{query_str}"

            headers = {k: v for k, v in request.headers.items() if k.lower() != "host"}
            body = await request.body()

            try:
                response = await client.request(
                    method=request.method,
                    url=url,
                    headers=headers,
                    content=body,
                    timeout=10.0
                )
                return Response(
                    content=response.content,
                    status_code=response.status_code,
                    headers=dict(response.headers)
                )
            except Exception as e:
                return Response(f"Vite server proxy error: {str(e)}", status_code=502)
else:
    dist_dir = os.path.join(os.getcwd(), "dist")
    print(f"[SERVER] Operating in PRODUCTION mode. Serving static assets from {dist_dir}")
    
    if os.path.exists(dist_dir):
        assets_dir = os.path.join(dist_dir, "assets")
        if os.path.exists(assets_dir):
            app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

        @app.api_route("/{full_path:path}", methods=["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD", "PATCH"])
        async def serve_spa(request: Request, full_path: str):
            if full_path == "ws" or full_path.startswith("api/"):
                return Response("Not Found", status_code=404)

            file_path = os.path.join(dist_dir, full_path)
            if os.path.isfile(file_path):
                return FileResponse(file_path)

            index_path = os.path.join(dist_dir, "index.html")
            if os.path.exists(index_path):
                return FileResponse(index_path)

            return Response("SPA index.html not found.", status_code=404)
