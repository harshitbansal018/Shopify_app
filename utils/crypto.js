// utils/crypto.js
//
// Symmetric encryption for access tokens at rest. Uses node:crypto only --
// AES-256-GCM, which authenticates the ciphertext, so a tampered value fails
// to decrypt rather than silently returning garbage.
//
// Stored format:  v1.<iv>.<authTag>.<ciphertext>   (each part base64url)
//
// The version prefix means the scheme can be rotated later without guessing
// how an existing row was encrypted.
const crypto = require("crypto");

const ALGORITHM = "aes-256-gcm";
const VERSION = "v1";
const IV_BYTES = 12; // 96 bits, the size GCM is defined for
const KEY_BYTES = 32;

let cachedKey = null;

/**
 * Reads TOKEN_ENCRYPTION_KEY, which must be 32 bytes encoded as hex or base64.
 * Generate one with:  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */
function getKey() {
  if (cachedKey) return cachedKey;

  const raw = String(process.env.TOKEN_ENCRYPTION_KEY || "").trim();

  if (!raw) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY is not set. Access tokens must never be stored in plain text."
    );
  }

  let key;

  if (/^[0-9a-f]{64}$/i.test(raw)) {
    key = Buffer.from(raw, "hex");
  } else {
    key = Buffer.from(raw, "base64");
  }

  if (key.length !== KEY_BYTES) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}`
    );
  }

  cachedKey = key;
  return key;
}

/**
 * Encrypt a token for storage. Returns null for an empty input so a missing
 * token stays NULL in the database rather than becoming an encrypted "".
 */
function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === "") {
    return null;
  }

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);

  const ciphertext = Buffer.concat([
    cipher.update(String(plaintext), "utf8"),
    cipher.final(),
  ]);

  return [
    VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/**
 * Decrypt a stored token. Returns null when there is nothing to decrypt.
 * Throws when the value is malformed or has been tampered with -- callers
 * should treat that as "this shop needs to reinstall", not as an empty token.
 */
function decrypt(payload) {
  if (payload === null || payload === undefined || payload === "") {
    return null;
  }

  const parts = String(payload).split(".");

  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Stored token is not in the expected encrypted format");
  }

  const [, ivPart, tagPart, dataPart] = parts;

  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    getKey(),
    Buffer.from(ivPart, "base64url")
  );

  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/** True when a value looks like something encrypt() produced. */
function isEncrypted(value) {
  return typeof value === "string" && value.startsWith(`${VERSION}.`);
}

function resetKeyCacheForTests() {
  cachedKey = null;
}

module.exports = { encrypt, decrypt, isEncrypted, resetKeyCacheForTests };
