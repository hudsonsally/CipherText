export interface User {
  id: string;
  username: string;
  publicKey: string; // RSA Public Key in JWK format string
  isOnline: boolean;
  lastSeen: number;
}

export interface Message {
  id: string;
  roomId: string;
  senderId: string;
  senderUsername: string;
  encryptedText: string; // Encrypted message content
  iv: string;            // AES-GCM initialization vector in base64
  timestamp: number;
  isSystem?: boolean;
  deletedAt?: number;    // Soft delete timestamp
}

export interface Room {
  id: string;
  name: string;
  type: 'direct' | 'group';
  participants: string[]; // List of user IDs
  // Symmetric room key encrypted for each participant using their RSA public key.
  // Format: { [userId]: encryptedRoomKeyBase64 }
  encryptedKeys?: Record<string, string>;
  // Initialization Vector used when encrypting the room key itself
  keyIv?: string;
  createdAt: number;
  lastReadMessageId?: Record<string, string>; // userId -> messageId
  unreadCount?: number; // Reactive client-side unread message count
}

export type WSClientEvent =
  | { type: 'client:register'; payload: { username: string; publicKey: string } }
  | { type: 'client:room_create'; payload: { name: string; type: 'direct' | 'group'; participants: string[]; encryptedKeys?: Record<string, string>; keyIv?: string } }
  | { type: 'client:message_send'; payload: { id?: string; roomId: string; encryptedText: string; iv: string } }
  | { type: 'client:message_delete'; payload: { roomId: string; messageId: string } }
  | { type: 'client:read_receipt'; payload: { roomId: string; messageId: string } }
  | { type: 'client:typing'; payload: { roomId: string; isTyping: boolean } };

export type WSServerEvent =
  | { type: 'server:registered'; payload: { user: User; rooms: Room[]; users: User[] } }
  | { type: 'server:user_list'; payload: { users: User[] } }
  | { type: 'server:room_list'; payload: { rooms: Room[] } }
  | { type: 'server:room_created'; payload: { room: Room } }
  | { type: 'server:message_receive'; payload: { message: Message } }
  | { type: 'server:message_deleted'; payload: { roomId: string; messageId: string } }
  | { type: 'server:read_receipt'; payload: { roomId: string; userId: string; messageId: string } }
  | { type: 'server:user_presence'; payload: { userId: string; isOnline: boolean } }
  | { type: 'server:typing'; payload: { roomId: string; userId: string; username: string; isTyping: boolean } }
  | { type: 'server:error'; payload: { message: string } };
