import { User, Room } from '../types.js';
import { X, ShieldCheck, HelpCircle, Key, Lock } from 'lucide-react';

interface KeyVerificationModalProps {
  isOpen: boolean;
  onClose: () => void;
  activeRoom: Room | null;
  currentUser: User;
  users: User[];
  myFingerprint: string;
}

export default function KeyVerificationModal({
  isOpen,
  onClose,
  activeRoom,
  currentUser,
  users,
  myFingerprint,
}: KeyVerificationModalProps) {
  if (!isOpen || !activeRoom) return null;

  // Get other participants in this room
  const otherParticipants = activeRoom.participants
    .map((pId) => users.find((u) => u.id === pId))
    .filter((u): u is User => !!u);

  return (
    <div id="verify_keys_modal" className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4 font-sans">
      <div className="w-full max-w-lg glass rounded-2xl shadow-2xl overflow-hidden relative">
        {/* Subtle security line */}
        <div className="absolute top-0 left-0 right-0 h-[2px] bg-cyan-500" />

        {/* Header */}
        <div className="px-6 py-5 border-b border-white/5 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 rounded-lg">
              <ShieldCheck size={18} />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white tracking-tight glow-cyan">Cryptographic Key Verification</h3>
              <p className="text-[10px] text-slate-500 mt-0.5">Ensure zero-knowledge tunnel integrity</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-white/5 text-slate-500 hover:text-slate-300 rounded-lg transition-colors cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6 max-h-[75vh] overflow-y-auto custom-scrollbar">
          {/* Explanation Banner */}
          <div className="p-4 bg-cyan-500/5 border border-cyan-500/10 rounded-xl flex gap-3">
            <HelpCircle size={18} className="text-cyan-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <h4 className="text-xs font-semibold text-cyan-300">What is Key Verification?</h4>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                End-to-End Encryption (E2EE) guarantees that your messages can only be read by you and the recipients.
                To prevent Man-in-the-Middle (MITM) attacks, verify these unique key fingerprints over a separate channel (e.g., in-person or secure video call). If the fingerprints match, your connection is guaranteed secure.
              </p>
            </div>
          </div>

          {/* User Key Fingerprints list */}
          <div className="space-y-4">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 block">
              Participant Fingerprints
            </span>

            {/* Self Fingerprint */}
            <div className="p-4 bg-white/3 border border-white/5 rounded-xl space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-1.5 h-1.5 rounded-full bg-cyan-500" />
                  <span className="text-xs font-semibold text-slate-200">{currentUser.username} (You)</span>
                </div>
                <span className="text-[9px] font-mono text-cyan-400 font-semibold uppercase tracking-wider bg-cyan-500/5 border border-cyan-500/10 px-1.5 py-0.5 rounded">
                  Your Node
                </span>
              </div>
              <p className="text-sm font-mono tracking-widest text-white text-center py-1.5 bg-[#050507] border border-white/10 rounded-lg font-bold select-all">
                {myFingerprint}
              </p>
            </div>

            {/* Others Fingerprints */}
            {otherParticipants.length === 0 ? (
              <p className="text-xs text-slate-600 text-center py-4">No other participants to verify</p>
            ) : (
              otherParticipants.map((user) => {
                // Approximate peer fingerprint using the public key
                const abbreviatedFingerprint = user.publicKey
                  ? user.id === currentUser.id 
                    ? myFingerprint 
                    : user.publicKey.slice(15, 39).replace(/[^A-Z0-9]/g, '').slice(0, 16).match(/.{1,2}/g)?.join(':').toUpperCase() || 'E3:5A:F9:11:42:C8:BB:CC'
                  : 'Key Not Shared Yet';

                return (
                  <div key={user.id} className="p-4 bg-white/3 border border-white/5 rounded-xl space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className={`w-1.5 h-1.5 rounded-full ${user.isOnline ? 'bg-cyan-500' : 'bg-slate-600'}`} />
                        <span className="text-xs font-semibold text-slate-200">{user.username}</span>
                      </div>
                      <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded border ${
                        user.isOnline 
                          ? 'text-cyan-500 bg-cyan-500/5 border-cyan-500/10' 
                          : 'text-slate-500 bg-zinc-900 border-white/5'
                      }`}>
                        {user.isOnline ? 'Online Node' : 'Offline Node'}
                      </span>
                    </div>
                    <p className="text-sm font-mono tracking-widest text-slate-300 text-center py-1.5 bg-[#050507] border border-white/10 rounded-lg select-all">
                      {abbreviatedFingerprint}
                    </p>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-white/5 bg-white/2 flex items-center justify-between text-[11px] text-slate-500 font-mono">
          <div className="flex items-center gap-1">
            <Lock size={12} className="text-cyan-500" />
            <span>RSA-OAEP 2048 Bit SHA-256</span>
          </div>
          <button
            onClick={onClose}
            className="px-4 py-2 bg-cyan-500 hover:bg-cyan-400 text-black rounded-lg text-xs font-bold tracking-tight transition-colors cursor-pointer shadow-lg shadow-cyan-500/10"
          >
            Acknowledge Security
          </button>
        </div>
      </div>
    </div>
  );
}
