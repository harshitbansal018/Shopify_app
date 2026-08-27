// utils/cookies.js
// Small cookie helper so the OAuth state nonce does not need a new dependency.

function parseCookies(req) {
  const header = req.headers.cookie;
  const jar = {};

  if (!header) return jar;

  header.split(";").forEach((pair) => {
    const index = pair.indexOf("=");
    if (index < 0) return;

    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();

    if (!key) return;

    try {
      jar[key] = decodeURIComponent(value);
    } catch {
      jar[key] = value;
    }
  });

  return jar;
}

function setCookie(res, name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];

  parts.push(`Path=${options.path || "/"}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.httpOnly !== false) parts.push("HttpOnly");
  if (options.secure !== false) parts.push("Secure");
  parts.push(`SameSite=${options.sameSite || "Lax"}`);

  const existing = res.getHeader("Set-Cookie");
  const cookie = parts.join("; ");

  res.setHeader(
    "Set-Cookie",
    existing ? [].concat(existing, cookie) : [cookie]
  );
}

function clearCookie(res, name) {
  setCookie(res, name, "", { maxAge: 0 });
}

module.exports = { parseCookies, setCookie, clearCookie };
