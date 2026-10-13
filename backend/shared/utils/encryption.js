import crypto from 'crypto';

// Encryption key - should be stored in environment variable
// Fallback to a default key (change in production!)
// Use a 32-byte key for AES-256
const getEncryptionKey = () => {
  if (process.env.ENCRYPTION_KEY) {
    const key = process.env.ENCRYPTION_KEY.trim();
    
    // Check if it's a hex string (64 hex characters = 32 bytes)
    if (/^[0-9a-fA-F]{64}$/.test(key)) {
      // Convert hex string to buffer (32 bytes)
      return Buffer.from(key, 'hex');
    }
    
    // If it's a hex string but not exactly 64 chars, try to use it
    if (/^[0-9a-fA-F]+$/i.test(key)) {
      // Pad or truncate to 64 hex chars (32 bytes)
      const hexKey = key.padEnd(64, '0').slice(0, 64);
      return Buffer.from(hexKey, 'hex');
    }
    
    // If it's a regular string, derive 32-byte key from it
    if (key.length >= 32) {
      // Use first 32 bytes as UTF-8
      return Buffer.from(key.slice(0, 32), 'utf8');
    }
    
    // Derive key using scrypt
    return crypto.scryptSync(key, 'salt', 32);
  }
  // Fallback: generate a key from a default string (CHANGE IN PRODUCTION!)
  return crypto.scryptSync('appzeto-food-encryption-key-change-in-production-2024', 'salt', 32);
};

const ENCRYPTION_KEY = getEncryptionKey();

// Validate encryption key
if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 32) {
  console.warn('⚠️  WARNING: Encryption key is invalid or not 32 bytes. Encryption may fail.');
  console.warn('Please set ENCRYPTION_KEY in .env file (64 hex characters = 32 bytes)');
}

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM standard IV length
const SALT_LENGTH = 32;
const TAG_LENGTH = 16;
const TAG_POSITION = SALT_LENGTH + IV_LENGTH;
const ENCRYPTED_POSITION = TAG_POSITION + TAG_LENGTH;

// Each decrypt() runs scryptSync, which costs ~40ms and blocks the event loop.
// Callers re-read the same stored values on nearly every request, so memoise on
// the ciphertext: a changed value re-encrypts to a new string and misses the
// cache, meaning entries can never go stale.
const decryptCache = new Map();
const DECRYPT_CACHE_MAX = 500;

function rememberDecrypted(key, value) {
  // Cheap FIFO eviction keeps the map bounded without tracking access order.
  if (decryptCache.size >= DECRYPT_CACHE_MAX) {
    const oldest = decryptCache.keys().next().value;
    decryptCache.delete(oldest);
  }
  decryptCache.set(key, value);
  return value;
}

/**
 * Encrypt sensitive data
 * @param {string} text - Text to encrypt
 * @returns {string} Encrypted text (hex encoded)
 */
export function encrypt(text) {
  // Handle null, undefined, or empty strings
  if (!text) {
    return '';
  }
  
  // Convert to string if not already
  if (typeof text !== 'string') {
    text = String(text);
  }
  
  // Check if empty after conversion
  if (text.trim() === '') {
    return '';
  }

  try {
    // Validate encryption key
    if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 32) {
      throw new Error('Invalid encryption key: must be 32 bytes');
    }
    
    const iv = crypto.randomBytes(IV_LENGTH);
    const salt = crypto.randomBytes(SALT_LENGTH);
    
    // Derive key from encryption key and salt
    const key = crypto.scryptSync(ENCRYPTION_KEY, salt, 32);
    
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const tag = cipher.getAuthTag();
    
    // Combine salt + iv + tag + encrypted data
    const result = salt.toString('hex') + iv.toString('hex') + tag.toString('hex') + encrypted;
    
    // Validate result
    if (!result || result.length < ENCRYPTED_POSITION * 2) {
      throw new Error('Encryption produced invalid result');
    }
    
    return result;
  } catch (error) {
    console.error('Encryption error:', error);
    console.error('Text to encrypt length:', text?.length);
    console.error('Encryption key length:', ENCRYPTION_KEY?.length);
    throw new Error(`Failed to encrypt data: ${error.message}`);
  }
}

/**
 * Decrypt sensitive data
 * @param {string} encryptedText - Encrypted text (hex encoded)
 * @returns {string} Decrypted text
 */
export function decrypt(encryptedText) {
  if (!encryptedText || encryptedText.trim() === '') {
    return '';
  }

  const cached = decryptCache.get(encryptedText);
  if (cached !== undefined) {
    return cached;
  }

  try {
    // Extract components
    const salt = Buffer.from(encryptedText.slice(0, SALT_LENGTH * 2), 'hex');
    const iv = Buffer.from(encryptedText.slice(SALT_LENGTH * 2, TAG_POSITION * 2), 'hex');
    const tag = Buffer.from(encryptedText.slice(TAG_POSITION * 2, ENCRYPTED_POSITION * 2), 'hex');
    const encrypted = encryptedText.slice(ENCRYPTED_POSITION * 2);
    
    // Derive key from encryption key and salt
    const key = crypto.scryptSync(ENCRYPTION_KEY, salt, 32);
    
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return rememberDecrypted(encryptedText, decrypted);
  } catch (error) {
    // A value encrypted under a different key fails the same way every time.
    // Remember the failure so it is reported once, not on every request, and
    // the costly key derivation is not repeated.
    console.error(`Decryption error (value will read as empty): ${error.message}`);
    // If decryption fails, return empty string (might be unencrypted legacy data)
    return rememberDecrypted(encryptedText, '');
  }
}

/**
 * Check if a string is encrypted (has the expected format)
 * @param {string} text - Text to check
 * @returns {boolean} True if encrypted
 */
export function isEncrypted(text) {
  if (!text || text.length < ENCRYPTED_POSITION * 2) {
    return false;
  }
  
  // Check if it's hex encoded and has minimum length
  return /^[0-9a-f]+$/i.test(text) && text.length >= ENCRYPTED_POSITION * 2;
}

