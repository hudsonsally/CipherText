import React, { useState } from 'react';
import { ShieldAlert, ShieldCheck, Cpu, Key } from 'lucide-react';
import { generateRSAKeyPair, RSAKeyPair, computeKeyFingerprint } from '../crypto.js';

interface RegistrationProps {
  onRegister: (username: string, keyPair: RSAKeyPair, fingerprint: string) => void;
}

export default function Registration({ onRegister }: RegistrationProps) {
  const [username, setUsername] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState('');
  const [progressText, setProgressText] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim()) return;

    setError('');
    setIsGenerating(true);
    setProgressText('Checking username availability...');

    try {
      // 1. Check if username is taken on the server
      const checkRes = await fetch(`/api/users/check/${encodeURIComponent(username.trim())}`);
      const { exists } = await checkRes.json();

      if (exists) {
        setError('Username is already taken on this node. Please pick another one.');
        setIsGenerating(false);
        return;
      }

      // 2. Generate RSA Keypair
      setProgressText('Generating 2048-bit RSA-OAEP Key Pair locally...');
      // Small artificial delay to show progress and feel high-fidelity
      await new Promise((r) => setTimeout(r, 600));
      const keyPair = await generateRSAKeyPair();

      // 3. Compute public key fingerprint for local display
      setProgressText('Computing cryptographic public key fingerprint...');
      await new Promise((r) => setTimeout(r, 400));
      const fingerprint = await computeKeyFingerprint(keyPair.publicKeyJwk);

      setIsGenerating(false);
      onRegister(username.trim(), keyPair, fingerprint);
    } catch (err) {
      console.error(err);
      setError('An error occurred during secure key generation. Please try again.');
      setIsGenerating(false);
    }
  };

  return (
    <div id="registration_container" className="min-h-screen flex items-center justify-center bg-[#050507] p-6 text-slate-300 font-sans">
      <div className="w-full max-w-md glass rounded-2xl p-8 shadow-2xl relative overflow-hidden">
        {/* Abstract cyber backdrop line */}
        <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-cyan-500 via-sky-500 to-cyan-500 animate-pulse" />

        <div className="flex flex-col items-center mb-8 text-center">
          <div className="p-3 bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 rounded-2xl mb-4">
            <ShieldCheck size={36} className="animate-pulse" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white mb-2 glow-cyan">
            CRYPTX
          </h1>
          <p className="text-sm text-slate-400">
            Secure, end-to-end encrypted real-time chat.
          </p>
        </div>

        {isGenerating ? (
          <div className="flex flex-col items-center py-6 text-center">
            <div className="relative mb-6">
              <div className="w-16 h-16 border-4 border-cyan-500/10 border-t-cyan-400 rounded-full animate-spin" />
              <Key className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 text-cyan-400 animate-bounce" size={20} />
            </div>
            <h3 className="text-md font-medium text-white mb-1">Securing Your Connection</h3>
            <p className="text-xs text-cyan-400 font-mono tracking-tight animate-pulse">
              {progressText}
            </p>
            <div className="mt-6 flex items-center gap-2 px-3 py-1.5 bg-white/5 border border-white/10 rounded-lg text-slate-500 font-mono text-[10px]">
              <Cpu size={12} />
              <span>KEYS NEVER LEAVE YOUR DEVICE</span>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label htmlFor="username" className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">
                Choose Username
              </label>
              <input
                id="username"
                type="text"
                placeholder="e.g. alice_dev"
                value={username}
                onChange={(e) => setUsername(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))}
                maxLength={20}
                required
                className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder-slate-600 font-medium focus:outline-none focus:border-cyan-500/50 transition-colors"
              />
              <p className="text-[10px] text-slate-500 mt-1.5">
                Only letters, numbers, and underscores are permitted. Maximum 20 characters.
              </p>
            </div>

            {error && (
              <div className="flex items-start gap-2.5 p-3.5 bg-rose-500/5 border border-rose-500/10 rounded-xl text-rose-400 text-xs leading-relaxed">
                <ShieldAlert size={16} className="shrink-0 mt-0.5 text-rose-500" />
                <span>{error}</span>
              </div>
            )}

            <button
              id="btn_register"
              type="submit"
              className="w-full py-3.5 bg-cyan-500 hover:bg-cyan-400 text-black font-bold rounded-xl transition-all duration-200 shadow-lg shadow-cyan-500/20 flex items-center justify-center gap-2 hover:translate-y-[-1px] active:translate-y-[1px] cursor-pointer"
            >
              <Key size={18} />
              <span>Generate Keys & Enter</span>
            </button>

            <div className="text-center pt-2">
              <span className="text-[11px] text-slate-500 font-medium">
                Uses 256-bit AES-GCM & 2048-bit RSA-OAEP
              </span>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
