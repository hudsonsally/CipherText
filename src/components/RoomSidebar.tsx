import React, { useState } from 'react';
import { User, Room } from '../types.js';
import { Shield, Users, MessageSquare, Plus, Check, LogOut, Key, Search, Circle, Compass } from 'lucide-react';
import { generateAESRoomKey, encryptAESKeyWithRSA, importRSAPublicKey } from '../crypto.js';

interface RoomSidebarProps {
  currentUser: User;
  myFingerprint: string;
  rooms: Room[];
  users: User[];
  activeRoomId: string | null;
  onSelectRoom: (roomId: string) => void;
  onCreateRoom: (name: string, type: 'direct' | 'group', participants: string[], encryptedKeys: Record<string, string>, keyIv?: string) => void;
  onLogout: () => void;
}

export default function RoomSidebar({
  currentUser,
  myFingerprint,
  rooms,
  users,
  activeRoomId,
  onSelectRoom,
  onCreateRoom,
  onLogout,
}: RoomSidebarProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [selectedParticipants, setSelectedParticipants] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<'chats' | 'users'>('chats');
  const [isGeneratingGroup, setIsGeneratingGroup] = useState(false);

  // Filter out self from users list
  const otherUsers = users.filter((u) => u.id !== currentUser.id);

  // Search filter
  const filteredUsers = otherUsers.filter((u) =>
    u.username.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const filteredRooms = rooms.filter((r) =>
    r.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Open direct chat room
  const handleStartDirectChat = async (peer: User) => {
    // 1. Check if direct room already exists
    const existingRoom = rooms.find(
      (r) =>
        r.type === 'direct' &&
        r.participants.includes(currentUser.id) &&
        r.participants.includes(peer.id)
    );

    if (existingRoom) {
      onSelectRoom(existingRoom.id);
      return;
    }

    try {
      // 2. Generate new AES key for this DM room
      const aesRoomKey = await generateAESRoomKey();

      // 3. Encrypt AES key for myself (using my public key)
      const myRsaPublic = await importRSAPublicKey(currentUser.publicKey);
      const encryptedKeyForSelf = await encryptAESKeyWithRSA(aesRoomKey, myRsaPublic);

      // 4. Encrypt AES key for peer (using peer's public key)
      const peerRsaPublic = await importRSAPublicKey(peer.publicKey);
      const encryptedKeyForPeer = await encryptAESKeyWithRSA(aesRoomKey, peerRsaPublic);

      // 5. Structure encryptedKeys payload
      const encryptedKeys: Record<string, string> = {
        [currentUser.id]: encryptedKeyForSelf,
        [peer.id]: encryptedKeyForPeer,
      };

      // Create room with peer
      onCreateRoom(
        peer.username, // Direct room name is usually peer's username
        'direct',
        [peer.id],
        encryptedKeys
      );
    } catch (err) {
      console.error('Failed to create secure direct room:', err);
    }
  };

  // Toggle participant selection for group creation
  const toggleParticipant = (userId: string) => {
    setSelectedParticipants((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId]
    );
  };

  // Submit group room creation
  const handleCreateGroupChat = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!groupName.trim() || selectedParticipants.length === 0) return;

    setIsGeneratingGroup(true);

    try {
      // 1. Generate AES room key
      const aesRoomKey = await generateAESRoomKey();

      // 2. Encrypt key for myself
      const myRsaPublic = await importRSAPublicKey(currentUser.publicKey);
      const encryptedKeyForSelf = await encryptAESKeyWithRSA(aesRoomKey, myRsaPublic);

      const encryptedKeys: Record<string, string> = {
        [currentUser.id]: encryptedKeyForSelf,
      };

      // 3. Encrypt key for each selected participant
      for (const pId of selectedParticipants) {
        const participantUser = users.find((u) => u.id === pId);
        if (participantUser) {
          const pRsaPublic = await importRSAPublicKey(participantUser.publicKey);
          const encryptedKeyForParticipant = await encryptAESKeyWithRSA(aesRoomKey, pRsaPublic);
          encryptedKeys[pId] = encryptedKeyForParticipant;
        }
      }

      // Create group room
      onCreateRoom(groupName.trim(), 'group', selectedParticipants, encryptedKeys);

      // Clean up state
      setGroupName('');
      setSelectedParticipants([]);
      setShowCreateGroup(false);
    } catch (err) {
      console.error('Failed to create secure group chat:', err);
    } finally {
      setIsGeneratingGroup(false);
    }
  };

  return (
    <div className="w-80 border-r border-white/5 glass flex flex-col h-full shrink-0 relative">
      {/* Current User Header */}
      <div className="p-4 border-b border-white/5 flex flex-col gap-1.5 bg-white/3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-cyan-500 animate-pulse" />
            <span className="font-semibold text-white tracking-tight text-sm glow-cyan">{currentUser.username}</span>
          </div>
          <button
            onClick={onLogout}
            title="Log out and destroy session keys"
            className="p-1.5 hover:bg-white/5 text-slate-400 hover:text-rose-400 rounded-lg transition-colors cursor-pointer"
          >
            <LogOut size={15} />
          </button>
        </div>
        <div className="flex items-center gap-1.5 text-slate-500 text-[10px] font-mono">
          <Shield size={10} className="text-cyan-500/80" />
          <span className="truncate" title={`Key Fingerprint: ${myFingerprint}`}>FP: {myFingerprint}</span>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="flex border-b border-white/5 text-xs">
        <button
          onClick={() => { setActiveTab('chats'); setShowCreateGroup(false); }}
          className={`flex-1 py-3 font-medium flex items-center justify-center gap-1.5 border-b-2 transition-colors cursor-pointer ${
            activeTab === 'chats'
              ? 'border-cyan-500 text-cyan-400 bg-white/3'
              : 'border-transparent text-slate-500 hover:text-slate-300'
          }`}
        >
          <MessageSquare size={13} />
          <span>Active Chats</span>
        </button>
        <button
          onClick={() => { setActiveTab('users'); setShowCreateGroup(false); }}
          className={`flex-1 py-3 font-medium flex items-center justify-center gap-1.5 border-b-2 transition-colors cursor-pointer ${
            activeTab === 'users'
              ? 'border-cyan-500 text-cyan-400 bg-white/3'
              : 'border-transparent text-slate-500 hover:text-slate-300'
          }`}
        >
          <Users size={13} />
          <span>Users ({otherUsers.length})</span>
        </button>
      </div>

      {/* Search Input */}
      <div className="p-3 border-b border-white/5 flex items-center gap-2 bg-white/2">
        <Search size={14} className="text-slate-600" />
        <input
          type="text"
          placeholder={activeTab === 'chats' ? 'Search secure channels...' : 'Search public keys...'}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full bg-transparent border-none text-xs text-white focus:outline-none placeholder-slate-600"
        />
      </div>

      {/* Main list view */}
      <div className="flex-1 overflow-y-auto custom-scrollbar">
        {showCreateGroup ? (
          // Group Creation Form
          <form onSubmit={handleCreateGroupChat} className="p-4 space-y-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 flex items-center justify-between">
              <span>Create E2EE Group</span>
              <button
                type="button"
                onClick={() => setShowCreateGroup(false)}
                className="text-[10px] text-slate-500 hover:text-slate-300 normal-case font-normal"
              >
                Cancel
              </button>
            </h3>

            <div className="space-y-1">
              <label className="text-[10px] font-semibold text-slate-500 uppercase">Group Name</label>
              <input
                type="text"
                placeholder="e.g. Secret Operation"
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                required
                className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-xs text-white placeholder-slate-700 focus:outline-none focus:border-cyan-500/40"
              />
            </div>

            <div className="space-y-2">
              <label className="text-[10px] font-semibold text-slate-500 uppercase block">Select Members ({selectedParticipants.length})</label>
              <div className="max-h-40 overflow-y-auto border border-white/10 rounded-lg bg-white/3 p-1.5 space-y-1">
                {otherUsers.length === 0 ? (
                  <p className="text-[10px] text-slate-600 text-center py-4">No other users online</p>
                ) : (
                  otherUsers.map((user) => (
                    <button
                      type="button"
                      key={user.id}
                      onClick={() => toggleParticipant(user.id)}
                      className="w-full flex items-center justify-between p-2 rounded-md hover:bg-white/5 transition-colors text-left"
                    >
                      <div className="flex items-center gap-2">
                        <Circle size={8} className={user.isOnline ? 'fill-cyan-500 text-cyan-500' : 'fill-slate-700 text-slate-700'} />
                        <span className="text-xs text-slate-300 font-medium">{user.username}</span>
                      </div>
                      <div className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                        selectedParticipants.includes(user.id)
                          ? 'bg-cyan-500 border-cyan-500 text-black'
                          : 'border-slate-700 bg-transparent'
                      }`}>
                        {selectedParticipants.includes(user.id) && <Check size={10} strokeWidth={3} />}
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>

            <button
              type="submit"
              disabled={isGeneratingGroup || selectedParticipants.length === 0}
              className="w-full py-2.5 bg-cyan-500 hover:bg-cyan-400 disabled:bg-white/5 disabled:text-slate-600 text-black font-bold rounded-lg text-xs transition-colors shadow-lg shadow-cyan-500/10 flex items-center justify-center gap-1.5 cursor-pointer"
            >
              <Key size={12} />
              <span>{isGeneratingGroup ? 'Securing Group...' : 'Create Secured Group'}</span>
            </button>
          </form>
        ) : activeTab === 'chats' ? (
          // Chats Tab
          <div className="p-2 space-y-1">
            <div className="px-2 py-1.5 flex items-center justify-between mb-1">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Conversations</span>
              <button
                onClick={() => setShowCreateGroup(true)}
                title="Create a new secure group chat"
                className="p-1 hover:bg-white/5 text-cyan-400 hover:text-cyan-300 rounded-md transition-colors cursor-pointer"
              >
                <Plus size={14} />
              </button>
            </div>

            {filteredRooms.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center px-4">
                <Compass size={24} className="text-slate-700 mb-2" />
                <p className="text-xs text-slate-500">No active rooms found</p>
                <p className="text-[10px] text-slate-600 mt-1">Start a direct message or create a group chat.</p>
              </div>
            ) : (
              filteredRooms.map((room) => {
                const isActive = activeRoomId === room.id;
                return (
                  <button
                    id={`room_btn_${room.id}`}
                    key={room.id}
                    onClick={() => onSelectRoom(room.id)}
                    className={`w-full flex items-center gap-3 p-2.5 rounded-xl text-left transition-all ${
                      isActive
                        ? 'bg-white/5 border border-white/10 text-white shadow-lg'
                        : 'hover:bg-white/5 border border-transparent text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <div className={`p-2 rounded-lg ${isActive ? 'bg-cyan-500/15 text-cyan-400' : 'bg-[#050507] text-slate-500'}`}>
                      {room.type === 'direct' ? <MessageSquare size={14} /> : <Users size={14} />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold truncate text-slate-200">{room.name}</span>
                        {room.unreadCount !== undefined && room.unreadCount > 0 && (
                          <span className="px-1.5 py-0.5 text-[9px] font-mono font-bold bg-cyan-500 text-[#050507] rounded-full shrink-0 animate-pulse">
                            {room.unreadCount}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 mt-0.5">
                        <Shield size={9} className="text-cyan-500/70" />
                        <span className="text-[9px] text-cyan-400/80 font-mono">Secured (E2EE)</span>
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        ) : (
          // Users Tab
          <div className="p-2 space-y-1">
            <span className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500 block mb-1">
              Registered Identities
            </span>

            {filteredUsers.length === 0 ? (
              <div className="text-center py-12 text-slate-600 text-xs">
                No other cryptographic nodes connected
              </div>
            ) : (
              filteredUsers.map((user) => (
                <button
                  key={user.id}
                  onClick={() => handleStartDirectChat(user)}
                  className="w-full flex items-center justify-between p-2.5 rounded-xl hover:bg-white/5 text-left transition-all border border-transparent hover:border-white/5 group"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="relative">
                      <div className={`w-8 h-8 rounded-full bg-[#050507] border border-white/5 flex items-center justify-center font-bold text-xs ${
                        user.isOnline ? 'text-cyan-400 border-cyan-500/20' : 'text-slate-600'
                      }`}>
                        {user.username.slice(0, 2).toUpperCase()}
                      </div>
                      <div className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-zinc-900 ${
                        user.isOnline ? 'bg-cyan-500' : 'bg-slate-700'
                      }`} />
                    </div>
                    <div className="min-w-0">
                      <span className="text-xs font-semibold text-slate-200 truncate block">{user.username}</span>
                      <span className="text-[9px] text-slate-500 font-mono block truncate">
                        Key: {user.publicKey ? 'Registered' : 'None'}
                      </span>
                    </div>
                  </div>
                  <div className="shrink-0 text-[10px] text-cyan-500 bg-cyan-500/5 group-hover:bg-cyan-500/10 border border-cyan-500/10 group-hover:border-cyan-500/20 px-2 py-1 rounded-md opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 cursor-pointer">
                    <MessageSquare size={10} />
                    <span>Chat</span>
                  </div>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      {/* Gateway Secure signature banner from Immersive UI */}
      <div className="p-4 border-t border-white/5">
        <div className="flex items-center gap-3 p-2.5 rounded-lg bg-cyan-950/20 border border-cyan-500/20">
          <div className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse"></div>
          <span className="text-[10px] uppercase tracking-widest text-cyan-400 font-bold font-mono">Gateway Secure</span>
        </div>
      </div>
    </div>
  );
}
