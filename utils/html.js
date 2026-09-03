// utils/html.js
const HTML_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

// Built from char codes so the source itself stays free of raw separators.
const BACKSLASH = String.fromCharCode(92);
const LINE_SEPARATORS = new RegExp(
  String.fromCharCode(0x2028) + "|" + String.fromCharCode(0x2029),
  "g"
);

const SCRIPT_ESCAPES = {
  "<": BACKSLASH + "u003c",
  ">": BACKSLASH + "u003e",
  "&": BACKSLASH + "u0026",
};

/**
 * Escape untrusted text before it is interpolated into generated HTML.
 */
function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

/**
 * Escape a value for use inside a double-quoted HTML attribute.
 */
function escapeAttribute(value) {
  return escapeHtml(value);
}

/**
 * Only allow image sources we are willing to emit: http(s) URLs and
 * same-origin relative paths. Anything else (javascript:, data:, vbscript:)
 * collapses to an empty string.
 */
function safeImageUrl(value) {
  if (!value) return "";

  const raw = String(value).trim();

  if (!raw) return "";
  if (raw.startsWith("/") && !raw.startsWith("//")) return escapeAttribute(raw);

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return escapeAttribute(parsed.toString());
  } catch {
    return "";
  }
}

/**
 * Serialise a value for embedding inside a <script> block without letting a
 * literal `</script>` (or a stray line separator) terminate or break the tag.
 */
function serializeForScript(value) {
  return JSON.stringify(value === undefined ? null : value)
    .replace(/[<>&]/g, (char) => SCRIPT_ESCAPES[char])
    .replace(LINE_SEPARATORS, (char) =>
      char.charCodeAt(0) === 0x2028
        ? BACKSLASH + "u2028"
        : BACKSLASH + "u2029"
    );
}

/**
 * A page that moves the TOP window to `url`.
 *
 * OAuth must never run inside the Shopify admin iframe: Shopify's login lives
 * on accounts.shopify.com, which refuses to be framed, so an in-frame redirect
 * dead-ends at "accounts.shopify.com refused to connect". Assigning
 * window.top.location escapes the frame first.
 *
 * Safe to use when not framed too -- window.top is then window itself.
 */
function topLevelRedirectPage(url, { title = "Redirecting" } = {}) {
  const safeUrl = escapeAttribute(url);

  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <title>${escapeHtml(title)}</title>
  </head>
  <body>
    <script>
      window.top.location.href = ${serializeForScript(url)};
    </script>
    <noscript>
      <p><a href="${safeUrl}" target="_top">Continue</a></p>
    </noscript>
  </body>
</html>`;
}

module.exports = {
  escapeHtml,
  escapeAttribute,
  safeImageUrl,
  serializeForScript,
  topLevelRedirectPage,
};
