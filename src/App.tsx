import { useState, useEffect, useRef } from 'react';
import { User, Message, Room, WSClientEvent, WSServerEvent } from './types.js';
import { RSAKeyPair, decryptAESKeyWithRSA, encryptMessage } from './crypto.js';
import Registration from './components/Registration.js';
import RoomSidebar from './components/RoomSidebar.js';
import ChatArea from './components/ChatArea.js';
import KeyVerificationModal from './components/KeyVerificationModal.js';
import { ShieldAlert, RefreshCw } from 'lucide-react';

export default function App() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [myKeyPair, setMyKeyPair] = useState<RSAKeyPair | null>(null);
  const [myFingerprint, setMyFingerprint] = useState('');
  
  // WebSockets States
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  
  // Chat Rooms and Users list
  const [rooms, setRooms] = useState<Room[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  
  // Decrypted Room Symmetric AES Keys cache (roomId -> AES CryptoKey)
  const [roomKeys, setRoomKeys] = useState<Record<string, CryptoKey>>({});
  
  // Typing indicators: roomId -> list of usernames typing
  const [typingStates, setTypingStates] = useState<Record<string, string[]>>({});
  
  // Modals
  const [showKeyVerification, setShowKeyVerification] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);

  // Auto reconnect if registered user details exist in session storage
  useEffect(() => {
    const savedUser = sessionStorage.getItem('cipherchat_user');
    // If we have a saved username, we can automatically trigger a reconnect
    // but we will need to re-generate keys since privateKey can't be stringified in sessionStorage.
    // This provides a smooth development refresh experience!
    if (savedUser && !currentUser && !isConnecting) {
      // Just clear it so user can register fresh with new key, ensuring security
      sessionStorage.removeItem('cipherchat_user');
    }
  }, []);

  // Sync historical messages when active room shifts
  useEffect(() => {
    if (!activeRoomId) {
      setMessages([]);
      return;
    }

    async function fetchHistoricalMessages() {
      try {
        const res = await fetch(`/api/rooms/${activeRoomId}/messages`);
        const data = await res.json();
        setMessages(data.messages || []);
      } catch (err) {
        console.error('Failed to load room messages:', err);
      }
    }

    fetchHistoricalMessages();
  }, [activeRoomId]);

  // Decrypt room keys for newly added rooms
  useEffect(() => {
    if (!currentUser || !myKeyPair) return;

    async function decryptNewRoomKeys() {
      const updatedKeys = { ...roomKeys };
      let changed = false;

      for (const room of rooms) {
        // If we don't have the key decrypted yet and are a participant
        if (!updatedKeys[room.id] && room.participants.includes(currentUser.id)) {
          const encryptedKeyBase64 = room.encryptedKeys?.[currentUser.id];
          if (encryptedKeyBase64) {
            try {
              const decryptedAesKey = await decryptAESKeyWithRSA(
                encryptedKeyBase64,
                myKeyPair.privateKey
              );
              updatedKeys[room.id] = decryptedAesKey;
              changed = true;
            } catch (err) {
              console.error(`Failed to decrypt AES key for room ${room.id}:`, err);
            }
          }
        }
      }

      if (changed) {
        setRoomKeys(updatedKeys);
      }
    }

    decryptNewRoomKeys();
  }, [rooms, currentUser, myKeyPair, roomKeys]);

  // Connect to websocket server
  const connectToWebSocket = (username: string, keyPair: RSAKeyPair) => {
    setIsConnecting(true);
    setErrorMsg('');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
      setIsConnecting(false);

      // Register with public key
      const regEvent: WSClientEvent = {
        type: 'client:register',
        payload: {
          username,
          publicKey: keyPair.publicKeyJwk,
        },
      };
      ws.send(JSON.stringify(regEvent));
    };

    ws.onmessage = (event) => {
      try {
        const serverEvent = JSON.parse(event.data) as WSServerEvent;

        switch (serverEvent.type) {
          case 'server:registered': {
            setCurrentUser(serverEvent.payload.user);
            setRooms(serverEvent.payload.rooms);
            setUsers(serverEvent.payload.users);
            sessionStorage.setItem('cipherchat_user', serverEvent.payload.user.username);
            break;
          }

          case 'server:user_list': {
            setUsers(serverEvent.payload.users);
            break;
          }

          case 'server:room_list': {
            setRooms(serverEvent.payload.rooms);
            break;
          }

          case 'server:room_created': {
            const newRoom = serverEvent.payload.room;
            setRooms((prev) => {
              if (prev.some((r) => r.id === newRoom.id)) return prev;
              return [...prev, newRoom];
            });
            // Automatically switch to the newly created room if current user created it
            if (newRoom.participants.includes(currentUser?.id || '')) {
              setActiveRoomId(newRoom.id);
            }
            break;
          }

          case 'server:message_receive': {
            const newMsg = serverEvent.payload.message;
            setMessages((prev) => {
              // Prevent duplicates (Message Idempotency)
              if (prev.some((m) => m.id === newMsg.id)) return prev;
              return [...prev, newMsg];
            });

            // If the message belongs to a non-active room, increment its unreadCount locally
            if (newMsg.roomId !== activeRoomId) {
              setRooms((prevRooms) =>
                prevRooms.map((r) =>
                  r.id === newMsg.roomId
                    ? { ...r, unreadCount: (r.unreadCount || 0) + 1 }
                    : r
                )
              );
            }
            break;
          }

          case 'server:message_deleted': {
            const { messageId } = serverEvent.payload;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === messageId
                  ? { ...m, deletedAt: Date.now(), encryptedText: '', iv: '' }
                  : m
              )
            );
            break;
          }

          case 'server:read_receipt': {
            const { roomId, userId, messageId } = serverEvent.payload;
            setRooms((prev) =>
              prev.map((r) => {
                if (r.id !== roomId) return r;
                const lastReadMap = r.lastReadMessageId || {};
                return {
                  ...r,
                  lastReadMessageId: {
                    ...lastReadMap,
                    [userId]: messageId,
                  },
                };
              })
            );
            break;
          }

          case 'server:user_presence': {
            const { userId, isOnline } = serverEvent.payload;
            setUsers((prev) =>
              prev.map((u) => (u.id === userId ? { ...u, isOnline } : u))
            );
            break;
          }

          case 'server:typing': {
            const { roomId, username: typingUsername, isTyping } = serverEvent.payload;
            setTypingStates((prev) => {
              const activeTypers = prev[roomId] || [];
              const updatedTypers = isTyping
                ? Array.from(new Set([...activeTypers, typingUsername]))
                : activeTypers.filter((name) => name !== typingUsername);
              return { ...prev, [roomId]: updatedTypers };
            });
            break;
          }

          case 'server:error': {
            setErrorMsg(serverEvent.payload.message);
            break;
          }
        }
      } catch (err) {
        console.error('Error handling WebSocket frame:', err);
      }
    };

    ws.onclose = () => {
      setIsConnected(false);
      setIsConnecting(false);
    };

    ws.onerror = (err) => {
      console.error('WebSocket connection error:', err);
      setErrorMsg('Secure WebSocket tunnel failed to establish.');
      setIsConnected(false);
      setIsConnecting(false);
    };
  };

  // On registration submit
  const handleRegistration = (username: string, keyPair: RSAKeyPair, fingerprint: string) => {
    setMyKeyPair(keyPair);
    setMyFingerprint(fingerprint);
    connectToWebSocket(username, keyPair);
  };

  // Send read receipt when we have a new latest message in the active room
  useEffect(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN || !activeRoomId || !currentUser || messages.length === 0) {
      return;
    }

    const latestMsg = messages[messages.length - 1];
    if (!latestMsg.isSystem && latestMsg.senderId !== currentUser.id) {
      const readEvent: WSClientEvent = {
        type: 'client:read_receipt',
        payload: {
          roomId: activeRoomId,
          messageId: latestMsg.id,
        },
      };
      wsRef.current.send(JSON.stringify(readEvent));

      // Also update local room state for immediate visual responsiveness
      setRooms((prev) =>
        prev.map((r) => {
          if (r.id !== activeRoomId) return r;
          const lastReadMap = r.lastReadMessageId || {};
          if (lastReadMap[currentUser.id] === latestMsg.id) return r;
          return {
            ...r,
            lastReadMessageId: {
              ...lastReadMap,
              [currentUser.id]: latestMsg.id,
            },
          };
        })
      );
    }
  }, [messages, activeRoomId, currentUser]);

  // Clear unreadCount for the active room immediately upon activation
  useEffect(() => {
    if (!activeRoomId) return;
    setRooms((prev) =>
      prev.map((r) =>
        r.id === activeRoomId ? { ...r, unreadCount: 0 } : r
      )
    );
  }, [activeRoomId]);

  // Handle outgoing messages (encrypt text first!)
  const handleSendMessage = async (text: string) => {
    if (!wsRef.current || !activeRoomId || !currentUser) return;

    const activeRoomKey = roomKeys[activeRoomId];
    if (!activeRoomKey) {
      console.error('Failed to encrypt message: Missing AES room key');
      return;
    }

    // Client-side message ID generation for Message Idempotency
    const clientMsgId = 'msg_cli_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();

    try {
      // 1. Encrypt message client-side
      const { encryptedText, iv } = await encryptMessage(text, activeRoomKey);

      // 2. Dispatch via socket
      const sendEvent: WSClientEvent = {
        type: 'client:message_send',
        payload: {
          id: clientMsgId,
          roomId: activeRoomId,
          encryptedText,
          iv,
        },
      };

      wsRef.current.send(JSON.stringify(sendEvent));
    } catch (err) {
      console.error('Encryption error before transport:', err);
    }
  };

  // Handle message soft deletion
  const handleDeleteMessage = (messageId: string) => {
    if (!wsRef.current || !activeRoomId) return;

    const deleteEvent: WSClientEvent = {
      type: 'client:message_delete',
      payload: {
        roomId: activeRoomId,
        messageId,
      },
    };

    wsRef.current.send(JSON.stringify(deleteEvent));

    // Update local state for instant feedback
    setMessages((prev) =>
      prev.map((m) =>
        m.id === messageId
          ? { ...m, deletedAt: Date.now(), encryptedText: '', iv: '' }
          : m
      )
    );
  };

  // Handle outgoing typing states
  const handleSendTyping = (isTyping: boolean) => {
    if (!wsRef.current || !activeRoomId) return;

    const typingEvent: WSClientEvent = {
      type: 'client:typing',
      payload: {
        roomId: activeRoomId,
        isTyping,
      },
    };

    wsRef.current.send(JSON.stringify(typingEvent));
  };

  // Handle new room dispatch from RoomSidebar
  const handleCreateRoom = (
    name: string,
    type: 'direct' | 'group',
    participants: string[],
    encryptedKeys: Record<string, string>,
    keyIv?: string
  ) => {
    if (!wsRef.current) return;

    const createEvent: WSClientEvent = {
      type: 'client:room_create',
      payload: {
        name,
        type,
        participants,
        encryptedKeys,
        keyIv,
      },
    };

    wsRef.current.send(JSON.stringify(createEvent));
  };

  // Reset session and disconnect
  const handleLogout = () => {
    if (wsRef.current) {
      wsRef.current.close();
    }
    sessionStorage.clear();
    setCurrentUser(null);
    setMyKeyPair(null);
    setMyFingerprint('');
    setRooms([]);
    setUsers([]);
    setActiveRoomId(null);
    setMessages([]);
    setRoomKeys({});
    setTypingStates({});
  };

  // Render Onboarding Registration
  if (!currentUser) {
    return <Registration onRegister={handleRegistration} />;
  }

  const activeRoom = rooms.find((r) => r.id === activeRoomId) || null;
  const activeRoomKey = activeRoomId ? roomKeys[activeRoomId] : undefined;
  const activeTypingUsers = activeRoomId ? typingStates[activeRoomId] || [] : [];

  return (
    <div className="flex h-screen bg-[#050507] text-slate-100 overflow-hidden font-sans">
      {/* Sidebar Navigation */}
      <RoomSidebar
        currentUser={currentUser}
        myFingerprint={myFingerprint}
        rooms={rooms}
        users={users}
        activeRoomId={activeRoomId}
        onSelectRoom={setActiveRoomId}
        onCreateRoom={handleCreateRoom}
        onLogout={handleLogout}
      />

      {/* Main Workspace */}
      <ChatArea
        currentUser={currentUser}
        activeRoom={activeRoom}
        messages={messages}
        roomKey={activeRoomKey}
        users={users}
        typingUsers={activeTypingUsers}
        onSendMessage={handleSendMessage}
        onSendTyping={handleSendTyping}
        onDeleteMessage={handleDeleteMessage}
        onShowKeyVerification={() => setShowKeyVerification(true)}
      />

      {/* Cryptographic Verification Modal overlay */}
      <KeyVerificationModal
        isOpen={showKeyVerification}
        onClose={() => setShowKeyVerification(false)}
        activeRoom={activeRoom}
        currentUser={currentUser}
        users={users}
        myFingerprint={myFingerprint}
      />

      {/* Transient Error Badge */}
      {errorMsg && (
        <div className="fixed bottom-4 right-4 z-50 flex items-center gap-2.5 p-4 bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs rounded-xl shadow-2xl backdrop-blur-md">
          <ShieldAlert size={16} className="text-rose-500 shrink-0" />
          <span>{errorMsg}</span>
          <button
            onClick={() => connectToWebSocket(currentUser.username, myKeyPair!)}
            className="p-1 hover:bg-rose-500/10 text-rose-400 rounded transition-colors"
            title="Reconnect"
          >
            <RefreshCw size={12} />
          </button>
        </div>
      )}
    </div>
  );
}
