// utils/jwt.js
// Minimal HS256 verifier for Shopify session tokens (id_token).
// Kept dependency-free on purpose: only HS256 is accepted.
const crypto = require("crypto");
const { normalizeShopDomain } = require("./shop");

const LEEWAY_SECONDS = 10;

function base64UrlDecode(segment) {
  return Buffer.from(segment, "base64url");
}

function timingSafeCompare(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);

  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verify a Shopify session token and return { shop, payload }.
 * Throws on any validation failure — callers must treat a throw as "not authenticated".
 */
function verifySessionToken(token, { apiKey, apiSecret } = {}) {
  if (!apiKey || !apiSecret) {
    throw new Error("SHOPIFY_API_KEY / SHOPIFY_API_SECRET are not configured");
  }

  if (typeof token !== "string" || !token) {
    throw new Error("Missing session token");
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed session token");
  }

  const [headerSegment, payloadSegment, signatureSegment] = parts;

  let header;
  let payload;

  try {
    header = JSON.parse(base64UrlDecode(headerSegment).toString("utf8"));
    payload = JSON.parse(base64UrlDecode(payloadSegment).toString("utf8"));
  } catch {
    throw new Error("Session token is not valid JSON");
  }

  if (header.alg !== "HS256") {
    throw new Error("Unsupported session token algorithm");
  }

  const expectedSignature = crypto
    .createHmac("sha256", apiSecret)
    .update(headerSegment + "." + payloadSegment)
    .digest("base64url");

  if (!timingSafeCompare(signatureSegment, expectedSignature)) {
    throw new Error("Session token signature mismatch");
  }

  const now = Math.floor(Date.now() / 1000);

  if (typeof payload.exp !== "number" || payload.exp < now - LEEWAY_SECONDS) {
    throw new Error("Session token expired");
  }

  if (typeof payload.nbf === "number" && payload.nbf > now + LEEWAY_SECONDS) {
    throw new Error("Session token not yet valid");
  }

  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audience.includes(apiKey)) {
    throw new Error("Session token audience mismatch");
  }

  let shop;
  try {
    shop = normalizeShopDomain(new URL(payload.dest).hostname);
  } catch {
    throw new Error("Session token has an invalid dest");
  }

  if (!shop) {
    throw new Error("Session token dest is not a myshopify domain");
  }

  // `iss` is the admin URL for the same shop; make sure the two agree.
  try {
    const issuerHost = normalizeShopDomain(new URL(payload.iss).hostname);
    if (issuerHost && issuerHost !== shop) {
      throw new Error("Session token issuer does not match dest");
    }
  } catch (err) {
    if (err.message === "Session token issuer does not match dest") throw err;
    throw new Error("Session token has an invalid iss");
  }

  return { shop, payload };
}

module.exports = { verifySessionToken };
