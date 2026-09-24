/* The JavaScript inside the views, checked without a browser.
 *
 * views.test.js renders every screen and asserts on the HTML. Neither it nor
 * anything else looks at the SCRIPT that HTML carries: a syntax error in a
 * <script> block, or a lookup for an element that was renamed out from under
 * it, renders perfectly and breaks only once a merchant clicks something.
 *
 * Both are cheap to catch here.
 */
const path = require("path");
const fs = require("fs");
const vm = require("vm");

const SERVER = path.join(__dirname, "..");
const VIEWS = path.join(SERVER, "views");

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` -> ${detail}` : ""}`);
  }
}

/** Every .ejs under views/, deepest first. */
function views(dir = VIEWS) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return views(full);
    return full.endsWith(".ejs") ? [full] : [];
  });
}

/** The <script> blocks a view writes itself, ignoring <script src=...>. */
function scriptBlocks(source) {
  return (source.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g) || [])
    .map((block) => block.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, ""));
}

const files = views();

console.log("Every view's script parses");
{
  let parsed = 0;
  const broken = [];
  // A block whose JavaScript is assembled by an EJS branch is two strings,
  // not one program, so it cannot be parsed this way. None do today; if one
  // starts to, this reports it rather than passing silently.
  const branching = [];

  files.forEach((file) => {
    const name = path.relative(VIEWS, file);

    scriptBlocks(fs.readFileSync(file, "utf8")).forEach((block, index) => {
      if (/<%[^=\-#][\s\S]*?%>/.test(block)) {
        branching.push(`${name}#${index}`);
        return;
      }

      // A rendered value is a literal as far as the parser is concerned, so
      // placeholders stand in for the output tags and no locals are needed.
      const code = block
        .replace(/<%#[\s\S]*?%>/g, "")
        .replace(/<%[=-]\s*json\([\s\S]*?\)\s*%>/g, "null")
        .replace(/<%[=-][\s\S]*?%>/g, "1");

      if (!code.trim()) return;
      parsed++;

      try {
        new vm.Script(code, { filename: `${name}#${index}` });
      } catch (error) {
        broken.push(`${name}#${index}: ${error.message}`);
      }
    });
  });

  check("every script block is valid JavaScript", broken.length === 0, broken.join("; "));
  check("and there are blocks to check", parsed >= 15, `only ${parsed} found`);
  check("none of them is assembled by an EJS branch", branching.length === 0,
    branching.join(", "));
}

console.log("\nNo script looks up an element that is not there");
{
  // Ids a shared partial renders, which any view including it may look up.
  const fromPartials = new Set();

  files.filter((file) => file.includes("partials")).forEach((file) => {
    (fs.readFileSync(file, "utf8").match(/\bid="([a-zA-Z0-9_-]+)"/g) || [])
      .forEach((hit) => fromPartials.add(hit.slice(4, -1)));
  });

  const stale = [];

  files.forEach((file) => {
    const source = fs.readFileSync(file, "utf8");
    const name = path.relative(VIEWS, file);

    const rendered = new Set(
      (source.match(/\bid="([a-zA-Z0-9_-]+)"/g) || []).map((hit) => hit.slice(4, -1))
    );
    // An element the script creates and names itself counts as rendered.
    (source.match(/\.id\s*=\s*"([a-zA-Z0-9_-]+)"/g) || [])
      .forEach((hit) => rendered.add(hit.split('"')[1]));

    const wanted = new Set();

    (source.match(/getElementById\(\s*"([a-zA-Z0-9_-]+)"\s*\)/g) || [])
      .forEach((hit) => wanted.add(hit.match(/"([^"]+)"/)[1]));
    (source.match(/querySelector(?:All)?\(\s*"#([a-zA-Z0-9_-]+)/g) || [])
      .forEach((hit) => wanted.add(hit.match(/#([a-zA-Z0-9_-]+)/)[1]));

    wanted.forEach((id) => {
      if (rendered.has(id) || fromPartials.has(id)) return;
      stale.push(`${name}: #${id}`);
    });
  });

  check("every id a script reaches for is rendered somewhere", stale.length === 0,
    stale.join(", "));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
