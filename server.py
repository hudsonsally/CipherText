import os
import json
import logging
import asyncio
from typing import Dict, List, Set, Optional
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from database import db_service

# Configure Logger
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("server")

app = FastAPI(title="CipherChat E2EE API", version="1.0.0")

# Enable CORS (Cross-Origin Resource Sharing)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

class ConnectionManager:
    def __init__(self):
        # Maps userId -> WebSocket
        self.active_connections: Dict[str, WebSocket] = {}

    async def connect(self, user_id: str, websocket: WebSocket):
        # Accept the websocket connection
        await websocket.accept()
        self.active_connections[user_id] = websocket
        logger.info(f"[WS] User registered: {user_id}")

    def disconnect(self, user_id: str):
        if user_id in self.active_connections:
            del self.active_connections[user_id]
            logger.info(f"[WS] User disconnected: {user_id}")

    async def send_event(self, websocket: WebSocket, event_type: str, payload: dict):
        try:
            await websocket.send_text(json.dumps({
                "type": event_type,
                "payload": payload
            }))
        except Exception as e:
            logger.error(f"[WS] Error sending event: {e}")

    async def send_event_to_user(self, user_id: str, event_type: str, payload: dict):
        websocket = self.active_connections.get(user_id)
        if websocket:
            await self.send_event(websocket, event_type, payload)

    async def broadcast_event(self, event_type: str, payload: dict):
        msg_str = json.dumps({
            "type": event_type,
            "payload": payload
        })
        # Take a copy to avoid concurrent modification issues
        connections = list(self.active_connections.values())
        for ws in connections:
            try:
                await ws.send_text(msg_str)
            except Exception as e:
                logger.error(f"[WS] Error broadcasting event: {e}")

manager = ConnectionManager()

@app.on_event("startup")
async def startup_event():
    logger.info("[SERVER] Initializing database service...")
    await db_service.initialize()

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
        logger.error(f"[SERVER] Health check error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/users/check/{username}")
async def check_user(username: str):
    try:
        user = await db_service.get_user_by_username(username)
        return {"exists": user is not None}
    except Exception as e:
        logger.error(f"[SERVER] Check user error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/rooms/{room_id}/messages")
async def get_room_messages(room_id: str):
    try:
        messages = await db_service.get_messages_by_room(room_id)
        mapped_messages = []
        for msg in messages:
            if msg.get("deletedAt"):
                msg_copy = dict(msg)
                msg_copy["encryptedText"] = ""
                msg_copy["iv"] = ""
                mapped_messages.append(msg_copy)
            else:
                mapped_messages.append(msg)
        return {"messages": mapped_messages}
    except Exception as e:
        logger.error(f"[SERVER] Get messages error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    # We do NOT accept immediately; we wait for registration payload to know the userId.
    # To facilitate that, we accept but keep it unassociated until 'client:register' event.
    await websocket.accept()
    logger.info("[WS] New connection handshake initiated.")
    
    current_user_id: Optional[str] = None

    try:
        while True:
            data_str = await websocket.receive_text()
            try:
                event = json.loads(data_str)
            except Exception as json_err:
                logger.error(f"[WS] Invalid JSON received: {json_err}")
                await websocket.send_text(json.dumps({
                    "type": "server:error",
                    "payload": {"message": "Invalid JSON format"}
                }))
                continue

            event_type = event.get("type")
            payload = event.get("payload", {})

            if event_type == "client:register":
                username = payload.get("username", "").strip()
                public_key = payload.get("publicKey")
                user_id = payload.get("id")

                if not username or not public_key:
                    await websocket.send_text(json.dumps({
                        "type": "server:error",
                        "payload": {"message": "Username and publicKey are required"}
                    }))
                    continue

                user = await db_service.get_user_by_username(username)
                if user:
                    user["publicKey"] = public_key
                    user["isOnline"] = True
                    user["lastSeen"] = int(asyncio.get_event_loop().time() * 1000) # milliseconds
                else:
                    id_to_use = user_id or f"usr_{os.urandom(4).hex()}"
                    user = {
                        "id": id_to_use,
                        "username": username,
                        "publicKey": public_key,
                        "isOnline": True,
                        "lastSeen": int(asyncio.get_event_loop().time() * 1000)
                    }

                await db_service.save_user(user)
                current_user_id = user["id"]
                
                # Associate connection in manager
                manager.active_connections[current_user_id] = websocket

                # Retrieve rooms and unread counts
                rooms = await db_service.get_user_rooms(current_user_id)
                user_rooms = []
                for room in rooms:
                    unread_count = await db_service.get_unread_count(room["id"], current_user_id)
                    room_copy = dict(room)
                    room_copy["unreadCount"] = unread_count
                    user_rooms.append(room_copy)

                all_users = await db_service.get_all_users()

                await manager.send_event(websocket, "server:registered", {
                    "user": user,
                    "rooms": user_rooms,
                    "users": all_users
                })

                await manager.broadcast_event("server:user_presence", {
                    "userId": user["id"],
                    "isOnline": True
                })

                await manager.broadcast_event("server:user_list", {
                    "users": all_users
                })

            elif event_type == "client:room_create":
                if not current_user_id:
                    await websocket.send_text(json.dumps({
                        "type": "server:error",
                        "payload": {"message": "Not registered"}
                    }))
                    continue

                name = payload.get("name", "").strip()
                room_type = payload.get("type", "direct")
                participants = payload.get("participants", [])
                encrypted_keys = payload.get("encryptedKeys", {})
                key_iv = payload.get("keyIv")

                full_participants = list(set(participants + [current_user_id]))

                if room_type == "direct":
                    if len(full_participants) == 2:
                        existing_direct = await db_service.find_direct_room(full_participants[0], full_participants[1])
                        if existing_direct:
                            unread_count = await db_service.get_unread_count(existing_direct["id"], current_user_id)
                            room_copy = dict(existing_direct)
                            room_copy["unreadCount"] = unread_count
                            await manager.send_event(websocket, "server:room_created", {
                                "room": room_copy
                            })
                            continue

                room_id = f"rm_{os.urandom(4).hex()}"
                new_room = {
                    "id": room_id,
                    "name": name if room_type == "group" else f"Direct Room {room_id}",
                    "type": room_type,
                    "participants": full_participants,
                    "encryptedKeys": encrypted_keys,
                    "keyIv": key_iv,
                    "createdAt": int(asyncio.get_event_loop().time() * 1000),
                    "lastReadMessageId": {}
                }

                await db_service.save_room(new_room)

                for p_id in full_participants:
                    unread_count = await db_service.get_unread_count(room_id, p_id)
                    room_copy = dict(new_room)
                    room_copy["unreadCount"] = unread_count
                    await manager.send_event_to_user(p_id, "server:room_created", {
                        "room": room_copy
                    })

                sys_message_id = f"msg_sys_{os.urandom(4).hex()}"
                sys_message = {
                    "id": sys_message_id,
                    "roomId": room_id,
                    "senderId": "system",
                    "senderUsername": "System",
                    "encryptedText": "",
                    "iv": "",
                    "timestamp": int(asyncio.get_event_loop().time() * 1000),
                    "isSystem": True
                }

                await db_service.save_message(sys_message)

                for p_id in full_participants:
                    await manager.send_event_to_user(p_id, "server:message_receive", {
                        "message": sys_message
                    })

            elif event_type == "client:message_send":
                if not current_user_id:
                    await websocket.send_text(json.dumps({
                        "type": "server:error",
                        "payload": {"message": "Not registered"}
                    }))
                    continue

                client_msg_id = payload.get("id")
                room_id = payload.get("roomId")
                encrypted_text = payload.get("encryptedText")
                iv = payload.get("iv")

                room = await db_service.get_room_by_id(room_id)
                if not room:
                    await websocket.send_text(json.dumps({
                        "type": "server:error",
                        "payload": {"message": "Room not found"}
                    }))
                    continue

                if current_user_id not in room["participants"]:
                    await websocket.send_text(json.dumps({
                        "type": "server:error",
                        "payload": {"message": "Not participant of this room"}
                    }))
                    continue

                message_id = client_msg_id or f"msg_{os.urandom(4).hex()}"
                existing_msg = await db_service.get_message_by_id(message_id)
                if existing_msg:
                    continue

                sender_user = await db_service.get_user_by_id(current_user_id)
                new_message = {
                    "id": message_id,
                    "roomId": room_id,
                    "senderId": current_user_id,
                    "senderUsername": sender_user["username"] if sender_user else "Unknown",
                    "encryptedText": encrypted_text,
                    "iv": iv,
                    "timestamp": int(asyncio.get_event_loop().time() * 1000)
                }

                await db_service.save_message(new_message)

                for p_id in room["participants"]:
                    await manager.send_event_to_user(p_id, "server:message_receive", {
                        "message": new_message
                    })

            elif event_type == "client:message_delete":
                if not current_user_id:
                    await websocket.send_text(json.dumps({
                        "type": "server:error",
                        "payload": {"message": "Not registered"}
                    }))
                    continue

                room_id = payload.get("roomId")
                message_id = payload.get("messageId")

                room = await db_service.get_room_by_id(room_id)
                if not room:
                    await websocket.send_text(json.dumps({
                        "type": "server:error",
                        "payload": {"message": "Room not found"}
                    }))
                    continue

                msg = await db_service.get_message_by_id(message_id)
                if not msg:
                    await websocket.send_text(json.dumps({
                        "type": "server:error",
                        "payload": {"message": "Message not found"}
                    }))
                    continue

                if msg["senderId"] != current_user_id:
                    await websocket.send_text(json.dumps({
                        "type": "server:error",
                        "payload": {"message": "Unauthorized"}
                    }))
                    continue

                msg["deletedAt"] = int(asyncio.get_event_loop().time() * 1000)
                msg["encryptedText"] = ""
                msg["iv"] = ""
                await db_service.save_message(msg)

                for p_id in room["participants"]:
                    await manager.send_event_to_user(p_id, "server:message_deleted", {
                        "roomId": room_id,
                        "messageId": message_id
                    })

            elif event_type == "client:read_receipt":
                if not current_user_id:
                    continue

                room_id = payload.get("roomId")
                message_id = payload.get("messageId")

                room = await db_service.get_room_by_id(room_id)
                if not room or current_user_id not in room["participants"]:
                    continue

                room["lastReadMessageId"] = room.get("lastReadMessageId", {})
                room["lastReadMessageId"][current_user_id] = message_id
                await db_service.save_room(room)

                for p_id in room["participants"]:
                    if p_id != current_user_id:
                        await manager.send_event_to_user(p_id, "server:read_receipt", {
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

                for p_id in room["participants"]:
                    if p_id != current_user_id:
                        await manager.send_event_to_user(p_id, "server:typing", {
                            "roomId": room_id,
                            "userId": current_user_id,
                            "username": sender_user.get("username", "Someone"),
                            "isTyping": is_typing
                        })

    except WebSocketDisconnect:
        logger.info(f"[WS] WebSocket disconnected cleanly.")
    except Exception as err:
        logger.error(f"[WS] Error in websocket loop: {err}")
    finally:
        if current_user_id:
            manager.disconnect(current_user_id)
            user = await db_service.get_user_by_id(current_user_id)
            if user:
                user["isOnline"] = False
                user["lastSeen"] = int(asyncio.get_event_loop().time() * 1000)
                await db_service.save_user(user)

                await manager.broadcast_event("server:user_presence", {
                    "userId": current_user_id,
                    "isOnline": False
                })

                all_users = await db_service.get_all_users()
                await manager.broadcast_event("server:user_list", {
                    "users": all_users
                })
