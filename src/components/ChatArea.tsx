import React, { useState, useEffect, useRef } from 'react';
import { User, Message, Room } from '../types.js';
import { Shield, Send, Eye, EyeOff, Loader2, Sparkles, Check, CheckCheck, Trash2, AlertCircle, Search } from 'lucide-react';
import { decryptMessage } from '../crypto.js';

interface ChatAreaProps {
  currentUser: User;
  activeRoom: Room | null;
  messages: Message[];
  roomKey: CryptoKey | undefined;
  users: User[];
  typingUsers: string[];
  onSendMessage: (text: string) => void;
  onSendTyping: (isTyping: boolean) => void;
  onDeleteMessage?: (messageId: string) => void;
  onShowKeyVerification: () => void;
}

// Sub-component to handle async E2EE message decryption seamlessly
function DecryptedMessageText({
  message,
  roomKey,
}: {
  message: Message;
  roomKey: CryptoKey | undefined;
}) {
  const [decryptedText, setDecryptedText] = useState<string | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;

    async function decrypt() {
      if (!roomKey) {
        setError(true);
        return;
      }

      setIsDecrypting(true);
      setError(false);

      try {
        const decrypted = await decryptMessage(message.encryptedText, message.iv, roomKey);
        if (active) {
          setDecryptedText(decrypted);
          setIsDecrypting(false);
        }
      } catch (err) {
        console.error('Failed to decrypt message:', err);
        if (active) {
          setError(true);
          setIsDecrypting(false);
        }
      }
    }

    decrypt();

    return () => {
      active = false;
    };
  }, [message.encryptedText, message.iv, roomKey]);

  if (isDecrypting) {
    return (
      <div className="flex items-center gap-1.5 text-zinc-500 font-mono text-xs select-none">
        <Loader2 size={12} className="animate-spin text-emerald-500" />
        <span>Decrypting secure stream...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-1.5 text-rose-400 font-mono text-xs">
        <AlertCircle size={12} className="text-rose-500 shrink-0" />
        <span>E2EE Payload Corrupted (or secure key missing)</span>
      </div>
    );
  }

  return <span className="whitespace-pre-wrap break-words">{decryptedText}</span>;
}

export default function ChatArea({
  currentUser,
  activeRoom,
  messages,
  roomKey,
  users,
  typingUsers,
  onSendMessage,
  onSendTyping,
  onDeleteMessage,
  onShowKeyVerification,
}: ChatAreaProps) {
  const [inputText, setInputText] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Helper to determine if a specific message has been read by all other participants
  const isReadByAll = (msgId: string) => {
    if (!activeRoom || !activeRoom.lastReadMessageId) return false;
    
    // Filter to other participants in this specific room
    const otherParticipants = activeRoom.participants.filter(pId => pId !== currentUser.id);
    if (otherParticipants.length === 0) return false;

    return otherParticipants.every(pId => {
      const lastReadId = activeRoom.lastReadMessageId?.[pId];
      if (!lastReadId) return false;
      
      // Calculate indices to verify if other participant's last read message is at or past this message
      const msgIndex = messages.findIndex(m => m.id === msgId);
      const lastReadIndex = messages.findIndex(m => m.id === lastReadId);
      
      return lastReadIndex >= msgIndex && msgIndex !== -1;
    });
  };

  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [decryptedCache, setDecryptedCache] = useState<Record<string, string>>({});

  // Asynchronously decrypt all room messages for Zero-Knowledge client-side full-text search cache
  useEffect(() => {
    const decryptAll = async () => {
      if (!roomKey) return;
      const cache: Record<string, string> = {};
      await Promise.all(
        messages.map(async (msg) => {
          if (msg.isSystem || msg.deletedAt) return;
          try {
            const text = await decryptMessage(msg.encryptedText, msg.iv, roomKey);
            cache[msg.id] = text;
          } catch (e) {
            // Ignore decryption failure for individual message
          }
        })
      );
      setDecryptedCache(cache);
    };
    decryptAll();
  }, [messages, roomKey]);

  // Compute filtered messages based on our Zero-Knowledge local decrypted cache
  const filteredMessages = messages.filter((msg) => {
    if (!searchQuery.trim()) return true;
    if (msg.isSystem) return false;
    if (msg.deletedAt) return false;
    const plainText = decryptedCache[msg.id] || '';
    return plainText.toLowerCase().includes(searchQuery.toLowerCase());
  });

  // Auto-scroll to bottom of conversation
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, typingUsers]);

  // Handle message sending
  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim()) return;

    // Send message
    onSendMessage(inputText.trim());
    setInputText('');

    // Clear typing state immediately
    if (isTyping) {
      setIsTyping(false);
      onSendTyping(false);
    }
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }
  };

  // Handle keyboard inputs and emit typing states
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputText(e.target.value);

    if (!isTyping) {
      setIsTyping(true);
      onSendTyping(true);
    }

    // Reset typing timeout
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }

    typingTimeoutRef.current = setTimeout(() => {
      setIsTyping(false);
      onSendTyping(false);
    }, 2000); // Send typing stop after 2s of silence
  };

  // Cleanup typing timeout on unmount
  useEffect(() => {
    return () => {
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
    };
  }, []);

  if (!activeRoom) {
    return (
      <div id="no_active_chat_container" className="flex-1 bg-[#050507] flex flex-col items-center justify-center text-slate-400 p-8 font-sans">
        <div className="p-4 bg-cyan-500/5 border border-cyan-500/10 rounded-2xl text-cyan-400/80 mb-4 animate-pulse">
          <Shield size={32} />
        </div>
        <h2 className="text-lg font-bold tracking-tight text-white mb-1 glow-cyan">
          Zero-Knowledge Chat Room
        </h2>
        <p className="text-sm text-slate-500 text-center max-w-sm">
          Select a conversation from the sidebar or initiate a direct chat with another node to exchange keys and communicate.
        </p>
      </div>
    );
  }

  // Get other participant usernames for the header display
  const otherParticipantNames = activeRoom.participants
    .filter((pId) => pId !== currentUser.id)
    .map((pId) => users.find((u) => u.id === pId)?.username || 'Offline Node')
    .join(', ');

  return (
    <div className="flex-1 bg-[#050507] flex flex-col h-full overflow-hidden relative">
      {/* Chat Area Header */}
      <div className="px-6 py-4 border-b border-white/5 bg-white/2 flex items-center justify-between shrink-0">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-bold text-white truncate glow-cyan">
              {activeRoom.type === 'direct' ? otherParticipantNames || 'Secure Chat' : activeRoom.name}
            </h2>
            <div className="flex items-center gap-1 px-1.5 py-0.5 bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 rounded text-[9px] font-mono shrink-0 select-none">
              <Shield size={9} />
              <span>E2EE ACTIVE</span>
            </div>
          </div>
          <p className="text-[10px] text-slate-500 mt-0.5 truncate">
            {activeRoom.type === 'direct' ? 'Private Peer-to-Peer Encrypted Stream' : `Group: ${otherParticipantNames || 'System'}`}
          </p>
        </div>

        {/* Controls block */}
        <div className="flex items-center gap-2">
          {/* Client-Side Secure Search toggle */}
          <button
            onClick={() => {
              setIsSearchOpen(!isSearchOpen);
              if (isSearchOpen) setSearchQuery('');
            }}
            className={`p-2 rounded-lg border transition-all cursor-pointer ${
              isSearchOpen || searchQuery
                ? 'bg-cyan-500/10 border-cyan-500/30 text-cyan-400'
                : 'bg-white/5 border-white/10 text-slate-400 hover:text-slate-200'
            }`}
            title="Search Channel locally (Zero-Knowledge)"
          >
            <Search size={14} />
          </button>

          {/* E2EE Verify Fingerprints trigger */}
          <button
            onClick={onShowKeyVerification}
            className="text-xs text-slate-300 hover:text-cyan-400 font-medium px-3 py-1.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer"
          >
            <Shield size={12} className="text-cyan-400" />
            <span>Verify Keys</span>
          </button>
        </div>
      </div>

      {/* Zero-Knowledge Search Bar Overlay */}
      {isSearchOpen && (
        <div className="px-6 py-3 bg-[#09090e] border-b border-white/5 flex items-center gap-3 shrink-0">
          <Search size={13} className="text-cyan-500 shrink-0" />
          <input
            type="text"
            placeholder="Search decrypted message history locally..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="flex-1 bg-transparent text-xs text-white border-none focus:outline-none placeholder-slate-600"
            autoFocus
          />
          {searchQuery && (
            <span className="text-[9px] font-mono text-cyan-400 px-2 py-0.5 bg-cyan-500/5 border border-cyan-500/10 rounded">
              {filteredMessages.length} found
            </span>
          )}
          <button
            onClick={() => {
              setIsSearchOpen(false);
              setSearchQuery('');
            }}
            className="text-[10px] text-slate-500 hover:text-slate-300 cursor-pointer"
          >
            Clear
          </button>
        </div>
      )}

      {/* Messages Scroll Area */}
      <div className="flex-1 overflow-y-auto px-6 py-6 space-y-4 custom-scrollbar">
        {filteredMessages.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center text-slate-600">
            <Shield size={24} className="text-slate-800 mb-2" />
            <p className="text-xs font-mono">
              {searchQuery ? 'No search results match query' : 'End-to-End Cryptographic Tunnel Initialized'}
            </p>
            <p className="text-[10px] text-slate-700 mt-1">
              {searchQuery ? 'Check spelling or search for another term.' : 'All text blocks are ciphered client-side before transmission.'}
            </p>
          </div>
        ) : (
          filteredMessages.map((msg) => {
            const isSelf = msg.senderId === currentUser.id;

            if (msg.isSystem) {
              return (
                <div key={msg.id} className="flex justify-center my-2">
                  <div className="px-3 py-1 bg-white/3 border border-white/5 rounded-full text-[10px] text-slate-500 font-mono tracking-tight flex items-center gap-1">
                    <Shield size={10} className="text-cyan-500/40" />
                    Secure tunnel created on {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </div>
                </div>
              );
            }

            return (
              <div
                id={`message_bubble_${msg.id}`}
                key={msg.id}
                className={`flex flex-col max-w-[70%] ${isSelf ? 'ml-auto items-end' : 'mr-auto items-start'}`}
              >
                {/* Message Meta Info */}
                <div className="text-[9px] text-slate-500 mb-1 font-mono px-1 flex items-center gap-1.5">
                  {!isSelf && <span className="font-sans font-semibold text-slate-400 mr-1.5">{msg.senderUsername}</span>}
                  <span>{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  {isSelf && (
                    <span className="inline-flex items-center">
                      {isReadByAll(msg.id) ? (
                        <CheckCheck size={11} className="text-cyan-400" title="Read by all participants" />
                      ) : (
                        <Check size={11} className="text-slate-600" title="Delivered to secure server" />
                      )}
                    </span>
                  )}
                </div>

                {/* Message Bubble */}
                <div
                  className={`p-3.5 rounded-2xl text-sm leading-relaxed relative group ${
                    isSelf
                      ? 'msg-sent border border-cyan-500/10 text-white rounded-tr-none'
                      : 'msg-received border border-white/5 text-slate-200 rounded-tl-none'
                  }`}
                >
                  {msg.deletedAt ? (
                    <div className="flex items-center gap-1.5 text-slate-500 font-mono italic text-[11px] py-0.5 select-none">
                      <Trash2 size={11} className="text-slate-600 shrink-0" />
                      <span>This packet was burned</span>
                    </div>
                  ) : (
                    <>
                      <DecryptedMessageText message={msg} roomKey={roomKey} />
                      
                      {/* Hover Burn / Delete message button */}
                      {isSelf && onDeleteMessage && (
                        <button
                          onClick={() => onDeleteMessage(msg.id)}
                          className="absolute -top-2.5 -left-2.5 opacity-0 group-hover:opacity-100 transition-opacity bg-[#0c0c14] hover:bg-rose-950/80 border border-white/10 hover:border-rose-500/30 text-slate-400 hover:text-rose-400 rounded-full p-1 shadow-md hover:scale-105 transition-all cursor-pointer"
                          title="Burn/Delete Message"
                        >
                          <Trash2 size={10} />
                        </button>
                      )}

                      {/* Micro decryption badge */}
                      <div className="absolute -bottom-1.5 -right-1.5 opacity-0 group-hover:opacity-100 transition-opacity bg-[#050507] border border-white/10 rounded-full p-1 shadow-lg flex items-center justify-center" title="Decrypted locally via client AES key">
                        <Check size={8} className="text-cyan-400" />
                      </div>
                    </>
                  )}
                </div>
              </div>
            );
          })
        )}

        {/* Dynamic Typing indicators */}
        {typingUsers.length > 0 && (
          <div className="flex items-center gap-2 mr-auto text-slate-500 font-mono text-[10px] px-2 py-1 bg-white/3 border border-white/10 rounded-lg w-fit">
            <Loader2 size={10} className="animate-spin text-cyan-400" />
            <span>{typingUsers.join(', ')} {typingUsers.length === 1 ? 'is' : 'are'} writing secure packet...</span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Message Input Form */}
      <div className="p-4 border-t border-white/5 bg-white/1 shrink-0">
        <form onSubmit={handleSend} className="flex gap-2.5 items-center">
          <input
            type="text"
            placeholder={roomKey ? "Write message (E2E Encrypted)..." : "Securing handshake, please wait..."}
            value={inputText}
            onChange={handleInputChange}
            disabled={!roomKey}
            className="flex-1 px-4 py-3 bg-white/5 border border-white/10 focus:border-cyan-500/40 rounded-xl text-sm text-white placeholder-slate-600 focus:outline-none focus:ring-0 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          />
          <button
            type="submit"
            disabled={!roomKey || !inputText.trim()}
            className="p-3 bg-cyan-500 hover:bg-cyan-400 disabled:bg-white/5 disabled:text-slate-600 text-black rounded-xl transition-all duration-150 flex items-center justify-center shadow-lg shadow-cyan-500/20 hover:scale-[1.02] active:scale-[0.98] cursor-pointer"
          >
            <Send size={16} />
          </button>
        </form>
        <div className="mt-2.5 flex items-center justify-between text-[9px] text-slate-600 px-1 font-mono">
          <span className="flex items-center gap-1 select-none">
            <Shield size={10} className="text-cyan-500/70" />
            Zero-knowledge transit protocol
          </span>
          <span>AES-GCM-256</span>
        </div>
      </div>
    </div>
  );
}
