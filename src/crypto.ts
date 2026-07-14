/**
 * Cryptographic utility functions for client-side End-to-End Encryption (E2EE)
 * using the browser's native Web Crypto API.
 */

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

// --- RSA Cryptography (Key Exchange) ---

export interface RSAKeyPair {
  publicKeyJwk: string;
  privateKey: CryptoKey;
}

/**
 * Generates an RSA-OAEP 2048-bit keypair for encrypting/decrypting symmetric keys.
 */
export async function generateRSAKeyPair(): Promise<RSAKeyPair> {
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
 * Imports an RSA public key JWK string into a CryptoKey object.
 */
export async function importRSAPublicKey(jwkString: string): Promise<CryptoKey> {
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
