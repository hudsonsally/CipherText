import React, { useState } from 'react';
import { ShieldAlert, ShieldCheck, Cpu, Key, Lock, User } from 'lucide-react';
import { generateRSAKeyPair, RSAKeyPair, computeKeyFingerprint, exportRSAPrivateKey, importRSAPrivateKey } from '../crypto.js';

interface RegistrationProps {
  onRegister: (username: string, keyPair: RSAKeyPair, fingerprint: string) => void;
}

export default function Registration({ onRegister }: RegistrationProps) {
  const [isLogin, setIsLogin] = useState(true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [progressText, setProgressText] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanUsername = username.trim();
    const cleanPassword = password.trim();
    if (!cleanUsername || !cleanPassword) return;

    setError('');
    setIsLoading(true);

    try {
      const backendUrl = (import.meta as any).env.VITE_BACKEND_URL || '';
      const apiBase = backendUrl.endsWith('/') ? backendUrl.slice(0, -1) : backendUrl;

      if (isLogin) {
        setProgressText('Checking for stored local keys...');
        // 1. Check if we have keys in local storage for this user
        const storedKeysStr = localStorage.getItem(`cryptx_keys_${cleanUsername.toLowerCase()}`);
        let publicKeyJwk = '';
        let privateKey: any = null;

        if (storedKeysStr) {
          try {
            const parsed = JSON.parse(storedKeysStr);
            publicKeyJwk = parsed.publicKeyJwk;
            privateKey = await importRSAPrivateKey(parsed.privateKeyJwk);
          } catch (err) {
            console.error('Failed to import stored keys:', err);
          }
        }

        // 2. If no keys stored, generate a new pair transparently
        if (!publicKeyJwk || !privateKey) {
          setProgressText('Creating secure communication keypair...');
          const keyPair = await generateRSAKeyPair();
          publicKeyJwk = keyPair.publicKeyJwk;
          privateKey = keyPair.privateKey;

          // Export private key to store
          const privateKeyJwk = await exportRSAPrivateKey(privateKey);
          localStorage.setItem(
            `cryptx_keys_${cleanUsername.toLowerCase()}`,
            JSON.stringify({ publicKeyJwk, privateKeyJwk })
          );
        }

        // 3. Authenticate with backend
        setProgressText('Verifying credentials on CryptX node...');
        const res = await fetch(`${apiBase}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: cleanUsername,
            password: cleanPassword,
            publicKey: publicKeyJwk
          })
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.detail || 'Invalid username or password.');
        }

        const userData = await res.json();
        
        // 4. Compute fingerprint
        setProgressText('Establishing secure crypt tunnel...');
        const fingerprint = await computeKeyFingerprint(publicKeyJwk);

        // 5. Complete
        setIsLoading(false);
        onRegister(cleanUsername, { publicKeyJwk, privateKey }, fingerprint);

      } else {
        // Sign up flow
        setProgressText('Generating secure RSA public/private keypair...');
        // 1. Generate keypair transparently
        const keyPair = await generateRSAKeyPair();
        const publicKeyJwk = keyPair.publicKeyJwk;
        const privateKey = keyPair.privateKey;

        // Export private key to JWK
        const privateKeyJwk = await exportRSAPrivateKey(privateKey);

        // 2. Register user on the backend
        setProgressText('Registering credentials on CryptX node...');
        const res = await fetch(`${apiBase}/api/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: cleanUsername,
            password: cleanPassword,
            publicKey: publicKeyJwk
          })
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.detail || 'Registration failed. Username may be taken.');
        }

        // 3. Save keys to localStorage
        localStorage.setItem(
          `cryptx_keys_${cleanUsername.toLowerCase()}`,
          JSON.stringify({ publicKeyJwk, privateKeyJwk })
        );

        // 4. Compute fingerprint
        setProgressText('Finalizing cryptographic tunnel...');
        const fingerprint = await computeKeyFingerprint(publicKeyJwk);

        // 5. Complete
        setIsLoading(false);
        onRegister(cleanUsername, { publicKeyJwk, privateKey }, fingerprint);
      }
    } catch (err: any) {
      console.error('Authentication Error:', err);
      setError(err.message || 'An unexpected error occurred. Please make sure your server is running.');
      setIsLoading(false);
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

        {/* Sign In / Sign Up Toggler */}
        {!isLoading && (
          <div className="flex border-b border-white/10 mb-6">
            <button
              onClick={() => { setError(''); setIsLogin(true); }}
              className={`flex-1 pb-3 text-sm font-semibold tracking-wider uppercase transition-all duration-200 relative cursor-pointer ${
                isLogin ? 'text-cyan-400' : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              Sign In
              {isLogin && <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-cyan-400" />}
            </button>
            <button
              onClick={() => { setError(''); setIsLogin(false); }}
              className={`flex-1 pb-3 text-sm font-semibold tracking-wider uppercase transition-all duration-200 relative cursor-pointer ${
                !isLogin ? 'text-cyan-400' : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              Sign Up
              {!isLogin && <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-cyan-400" />}
            </button>
          </div>
        )}

        {isLoading ? (
          <div className="flex flex-col items-center py-8 text-center animate-fade-in">
            <div className="relative mb-6">
              <div className="w-16 h-16 border-4 border-cyan-500/10 border-t-cyan-400 rounded-full animate-spin" />
              <Key className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 text-cyan-400 animate-bounce" size={20} />
            </div>
            <h3 className="text-md font-medium text-white mb-1">Authenticating</h3>
            <p className="text-xs text-cyan-400 font-mono tracking-tight animate-pulse">
              {progressText}
            </p>
            <div className="mt-6 flex items-center gap-2 px-3 py-1.5 bg-white/5 border border-white/10 rounded-lg text-slate-500 font-mono text-[10px]">
              <Cpu size={12} />
              <span>KEYS SECURED LOCALLY</span>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label htmlFor="username" className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">
                Username
              </label>
              <div className="relative">
                <input
                  id="username"
                  type="text"
                  placeholder="e.g. alice_dev"
                  value={username}
                  onChange={(e) => setUsername(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))}
                  maxLength={20}
                  required
                  className="w-full pl-4 pr-10 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder-slate-600 font-medium focus:outline-none focus:border-cyan-500/50 transition-colors"
                />
                <User size={16} className="absolute right-3.5 top-1/2 transform -translate-y-1/2 text-slate-600" />
              </div>
              <p className="text-[10px] text-slate-500 mt-1.5">
                Only letters, numbers, and underscores. Max 20 characters.
              </p>
            </div>

            <div>
              <label htmlFor="password" className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">
                Password
              </label>
              <div className="relative">
                <input
                  id="password"
                  type="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="w-full pl-4 pr-10 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder-slate-600 font-medium focus:outline-none focus:border-cyan-500/50 transition-colors"
                />
                <Lock size={16} className="absolute right-3.5 top-1/2 transform -translate-y-1/2 text-slate-600" />
              </div>
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
              <span>{isLogin ? 'Sign In & Connect' : 'Sign Up & Create Account'}</span>
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
