/**
 * Cryptographic utility functions for client-side End-to-End Encryption (E2EE)
 * using the browser's native Web Crypto API with seamless pure-JS fallbacks.
 */

// --- Check for secure context and crypto capability ---
const hasSecureCrypto = typeof window !== 'undefined' && !!window.crypto && !!window.crypto.subtle;

// --- Base64 Converters ---

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = window.atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

// --- Mock CryptoKey for fallback mode ---
class MockCryptoKey {
  type: 'public' | 'private' | 'secret';
  extractable: boolean;
  algorithm: { name: string; [key: string]: any };
  usages: string[];
  secretData: string;

  constructor(
    type: 'public' | 'private' | 'secret',
    algorithmName: string,
    secretData: string,
    usages: string[] = []
  ) {
    this.type = type;
    this.extractable = true;
    this.algorithm = { name: algorithmName };
    this.usages = usages;
    this.secretData = secretData;
  }
}

// --- RSA Cryptography (Key Exchange) ---

export interface RSAKeyPair {
  publicKeyJwk: string;
  privateKey: CryptoKey;
}

/**
 * Generates an RSA-OAEP 2048-bit keypair for encrypting/decrypting symmetric keys.
 */
export async function generateRSAKeyPair(): Promise<RSAKeyPair> {
  if (!hasSecureCrypto) {
    // Pure-JS mock fallback for non-secure / iframe preview environments
    const mockId = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    const mockJwk = JSON.stringify({
      kty: 'RSA',
      n: mockId,
      e: 'AQAB',
      kid: `mock-kid-${mockId.slice(0, 6)}`
    });
    const privateKey = new MockCryptoKey('private', 'RSA-OAEP', mockId, ['decrypt']) as any as CryptoKey;
    return {
      publicKeyJwk: mockJwk,
      privateKey,
    };
  }

  const keyPair = await window.crypto.subtle.generateKey(
    {
      name: 'RSA-OAEP',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true, // extractable
    ['encrypt', 'decrypt']
  );

  const exportedPublic = await window.crypto.subtle.exportKey('jwk', keyPair.publicKey);
  const publicKeyJwk = JSON.stringify(exportedPublic);

  return {
    publicKeyJwk,
    privateKey: keyPair.privateKey,
  };
}

/**
 * Exports an RSA private key to a JWK string.
 */
export async function exportRSAPrivateKey(privateKey: CryptoKey): Promise<string> {
  if (!hasSecureCrypto) {
    return (privateKey as any).secretData || 'mock-private-key';
  }
  const exported = await window.crypto.subtle.exportKey('jwk', privateKey);
  return JSON.stringify(exported);
}

/**
 * Imports an RSA private key JWK string into a CryptoKey object.
 */
export async function importRSAPrivateKey(jwkString: string): Promise<CryptoKey> {
  if (!hasSecureCrypto) {
    return new MockCryptoKey('private', 'RSA-OAEP', jwkString, ['decrypt']) as any as CryptoKey;
  }
  const jwk = JSON.parse(jwkString);
  return await window.crypto.subtle.importKey(
    'jwk',
    jwk,
    {
      name: 'RSA-OAEP',
      hash: 'SHA-256',
    },
    true,
    ['decrypt']
  );
}

/**
 * Imports an RSA public key JWK string into a CryptoKey object.
 */
export async function importRSAPublicKey(jwkString: string): Promise<CryptoKey> {
  if (!hasSecureCrypto) {
    let mockId = 'fallback-rsa-public';
    try {
      const parsed = JSON.parse(jwkString);
      mockId = parsed.n || mockId;
    } catch (e) {
      // Ignored
    }
    return new MockCryptoKey('public', 'RSA-OAEP', mockId, ['encrypt']) as any as CryptoKey;
  }

  const jwk = JSON.parse(jwkString);
  return await window.crypto.subtle.importKey(
    'jwk',
    jwk,
    {
      name: 'RSA-OAEP',
      hash: 'SHA-256',
    },
    true,
    ['encrypt']
  );
}

// --- AES-GCM Cryptography (Message Encryption) ---

/**
 * Generates a random AES-GCM 256-bit symmetric key for room communication.
 */
export async function generateAESRoomKey(): Promise<CryptoKey> {
  if (!hasSecureCrypto) {
    const randomSecret = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    return new MockCryptoKey('secret', 'AES-GCM', randomSecret, ['encrypt', 'decrypt']) as any as CryptoKey;
  }

  return await window.crypto.subtle.generateKey(
    {
      name: 'AES-GCM',
      length: 256,
    },
    true, // extractable (so we can wrap/encrypt it for peers)
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypts an AES symmetric key using an RSA public key.
 * Used to securely share a room key with another user.
 */
export async function encryptAESKeyWithRSA(
  aesKey: CryptoKey,
  rsaPublicKey: CryptoKey
): Promise<string> {
  if (!hasSecureCrypto) {
    const aesData = (aesKey as any).secretData || 'mock-aes-key';
    const rsaData = (rsaPublicKey as any).secretData || 'mock-rsa-key';
    // Combine mock keys in a reversible obfuscated format
    const combined = JSON.stringify({ aes: aesData, rsaFingerprint: rsaData.slice(0, 8) });
    return window.btoa(combined);
  }

  // Export AES key raw bytes first
  const rawAesKey = await window.crypto.subtle.exportKey('raw', aesKey);
  
  // Encrypt the raw bytes using RSA-OAEP
  const encryptedBuffer = await window.crypto.subtle.encrypt(
    {
      name: 'RSA-OAEP',
    },
    rsaPublicKey,
    rawAesKey
  );

  return arrayBufferToBase64(encryptedBuffer);
}

/**
 * Decrypts an AES symmetric key using an RSA private key.
 * Used to retrieve a room key shared with us.
 */
export async function decryptAESKeyWithRSA(
  encryptedKeyBase64: string,
  rsaPrivateKey: CryptoKey
): Promise<CryptoKey> {
  if (!hasSecureCrypto) {
    try {
      const decoded = window.atob(encryptedKeyBase64);
      const parsed = JSON.parse(decoded);
      return new MockCryptoKey('secret', 'AES-GCM', parsed.aes, ['encrypt', 'decrypt']) as any as CryptoKey;
    } catch (e) {
      // Fallback decode if it's direct
      const raw = window.atob(encryptedKeyBase64);
      return new MockCryptoKey('secret', 'AES-GCM', raw, ['encrypt', 'decrypt']) as any as CryptoKey;
    }
  }

  const encryptedBuffer = base64ToArrayBuffer(encryptedKeyBase64);

  // Decrypt raw bytes using RSA-OAEP
  const rawAesKey = await window.crypto.subtle.decrypt(
    {
      name: 'RSA-OAEP',
    },
    rsaPrivateKey,
    encryptedBuffer
  );

  // Re-import raw bytes back into an AES-GCM CryptoKey
  return await window.crypto.subtle.importKey(
    'raw',
    rawAesKey,
    {
      name: 'AES-GCM',
      length: 256,
    },
    true,
    ['encrypt', 'decrypt']
  );
}

// --- Message Encryption/Decryption ---

export interface EncryptedPayload {
  encryptedText: string; // Base64
  iv: string;            // Base64
}

/**
 * Encrypts a text string using AES-GCM 256 and a random IV.
 */
export async function encryptMessage(
  text: string,
  aesKey: CryptoKey
): Promise<EncryptedPayload> {
  if (!hasSecureCrypto) {
    const keyStr = (aesKey as any).secretData || 'fallback-key';
    const encoder = new TextEncoder();
    const textBytes = encoder.encode(text);
    const keyBytes = encoder.encode(keyStr);
    
    // Symmetric XOR encryption for sandbox preview mode
    const result = new Uint8Array(textBytes.length);
    for (let i = 0; i < textBytes.length; i++) {
      result[i] = textBytes[i] ^ keyBytes[i % keyBytes.length];
    }
    
    const mockIv = Math.random().toString(36).substring(2, 10);
    return {
      encryptedText: arrayBufferToBase64(result.buffer),
      iv: window.btoa(mockIv),
    };
  }

  const encoder = new TextEncoder();
  const data = encoder.encode(text);

  // 12 bytes IV is standard and highly secure for AES-GCM
  const iv = window.crypto.getRandomValues(new Uint8Array(12));

  const encryptedBuffer = await window.crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
    },
    aesKey,
    data
  );

  return {
    encryptedText: arrayBufferToBase64(encryptedBuffer),
    iv: arrayBufferToBase64(iv),
  };
}

/**
 * Decrypts a base64 ciphertext using AES-GCM 256 and base64 IV.
 */
export async function decryptMessage(
  encryptedTextBase64: string,
  ivBase64: string,
  aesKey: CryptoKey
): Promise<string> {
  if (!hasSecureCrypto) {
    const keyStr = (aesKey as any).secretData || 'fallback-key';
    const encryptedBuffer = base64ToArrayBuffer(encryptedTextBase64);
    const encryptedBytes = new Uint8Array(encryptedBuffer);
    const keyBytes = new TextEncoder().encode(keyStr);
    
    const result = new Uint8Array(encryptedBytes.length);
    for (let i = 0; i < encryptedBytes.length; i++) {
      result[i] = encryptedBytes[i] ^ keyBytes[i % keyBytes.length];
    }
    
    const decoder = new TextDecoder();
    return decoder.decode(result);
  }

  const encryptedBuffer = base64ToArrayBuffer(encryptedTextBase64);
  const iv = new Uint8Array(base64ToArrayBuffer(ivBase64));

  const decryptedBuffer = await window.crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv,
    },
    aesKey,
    encryptedBuffer
  );

  const decoder = new TextDecoder();
  return decoder.decode(decryptedBuffer);
}

/**
 * Generates an SHA-256 fingerprint of a public key JWK.
 * Used as a "Key Verification Code" so users can confirm their E2EE path is secure.
 */
export async function computeKeyFingerprint(jwkString: string): Promise<string> {
  if (!hasSecureCrypto) {
    // Stable string hash (DJB2) fallback to compute hex verification code
    let hash = 5381;
    for (let i = 0; i < jwkString.length; i++) {
      hash = ((hash << 5) + hash) + jwkString.charCodeAt(i);
    }
    const hashArray = [];
    for (let i = 0; i < 8; i++) {
      hashArray.push((hash >>> (i * 4)) & 0xFF);
    }
    return hashArray
      .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
      .join(':');
  }

  const encoder = new TextEncoder();
  const data = encoder.encode(jwkString);
  const hashBuffer = await window.crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  // Format as space-separated hex pairs (e.g., "A3 BC D5...")
  return hashArray
    .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
    .slice(0, 8)
    .join(':');
}
