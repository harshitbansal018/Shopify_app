/* The page arithmetic, and the links it produces.
 *
 * No database and no HTTP: every screen in the app hands this a COUNT and a
 * query string and trusts the offset it gets back, so the edges are the whole
 * risk -- an off-by-one in the offset silently skips or repeats a row, and a
 * link that loses the current filter drops the merchant somewhere else.
 */
require("dotenv").config({ quiet: true });

const path = require("path");

const SERVER = path.join(__dirname, "..");
const { paginate, PAGE_SIZE } = require(path.join(SERVER, "controllers/pagination"));

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

/** A request, as far as this module is concerned. */
function req(query = {}) {
  return { query };
}

console.log("\nPage size");
{
  check("a page holds 15", PAGE_SIZE === 15, String(PAGE_SIZE));

  const exact = paginate(req(), 15, { path: "/products" });
  check("exactly one page's worth is one page", exact.pages === 1, String(exact.pages));

  const spills = paginate(req(), 16, { path: "/products" });
  check("one more is two pages", spills.pages === 2, String(spills.pages));
}

console.log("\nOffsets");
{
  const first = paginate(req(), 100, { path: "/products" });
  check("no ?page means page 1", first.page === 1);
  check("page 1 starts at 0", first.offset === 0);
  check("and asks for one page", first.limit === 15);

  const third = paginate(req({ page: "3" }), 100, { path: "/products" });
  check("page 3 skips two pages", third.offset === 30, String(third.offset));

  // Rows 31-45 of 100. Getting this wrong shows the merchant a row twice or
  // never, and nothing on the page would say so.
  check("and says which rows they are",
    third.from === 31 && third.to === 45,
    `${third.from}-${third.to}`);

  const last = paginate(req({ page: "7" }), 100, { path: "/products" });
  check("the last page is short", last.to === 100, String(last.to));
}

console.log("\nBad and stale page numbers");
{
  // Bookmarks go stale as rows come and go. Landing on the last page is a
  // better answer than an error or an empty table.
  const past = paginate(req({ page: "99" }), 40, { path: "/products" });
  check("a page past the end clamps to the last one", past.page === 3, String(past.page));
  check("and its offset is still inside the data",
    past.offset === 30 && past.offset < 40);

  check("page 0 is page 1",
    paginate(req({ page: "0" }), 40, { path: "/products" }).page === 1);
  check("a negative page is page 1",
    paginate(req({ page: "-5" }), 40, { path: "/products" }).page === 1);
  check("nonsense is page 1",
    paginate(req({ page: "banana" }), 40, { path: "/products" }).page === 1);
  check("a repeated ?page is not trusted either",
    paginate(req({ page: ["2", "9"] }), 40, { path: "/products" }).page === 1,
    "Express gives an array when a query key repeats");
}

console.log("\nAn empty list");
{
  const empty = paginate(req(), 0, { path: "/products" });

  check("is still one page", empty.pages === 1);
  check("with nothing on it", empty.from === 0 && empty.to === 0,
    "showing 1-0 of 0 would be nonsense");
  check("and no way forward or back", !empty.hasPrev && !empty.hasNext);
}

console.log("\nPrev and next");
{
  const middle = paginate(req({ page: "2" }), 100, { path: "/products" });
  check("the middle has both", middle.hasPrev && middle.hasNext);

  const first = paginate(req(), 100, { path: "/products" });
  check("the first page has no prev", !first.hasPrev && first.hasNext);

  const last = paginate(req({ page: "7" }), 100, { path: "/products" });
  check("the last page has no next", last.hasPrev && !last.hasNext);
}

console.log("\nLinks");
{
  const filtered = paginate(req({ page: "2" }), 100, {
    path: "/products",
    params: { filter: "unshared" },
  });

  // Losing the filter is the failure that matters: Next would quietly drop the
  // merchant back into the full catalogue.
  check("the filter travels with the page",
    filtered.href(3) === "/products?filter=unshared&page=3",
    filtered.href(3));

  check("page 1 is the bare url",
    filtered.href(1) === "/products?filter=unshared",
    filtered.href(1));

  const plain = paginate(req(), 100, { path: "/products" });
  check("with no params page 1 is just the path",
    plain.href(1) === "/products", plain.href(1));
  check("and later pages carry only the page",
    plain.href(4) === "/products?page=4", plain.href(4));

  // An empty param is dropped rather than sent as filter= -- "all" is the
  // default, and spelling it out makes a shared link longer for no gain.
  const blank = paginate(req(), 100, {
    path: "/products",
    params: { filter: "", tab: null, other: undefined },
  });
  check("empty params are left out", blank.href(2) === "/products?page=2",
    blank.href(2));

  check("no id_token is baked into a link",
    !filtered.href(3).includes("id_token"),
    "appNavigate attaches a fresh one; a copied token would be expired");
}

console.log("\nTwo lists on one page");
{
  // A payout detail screen pages its payments and its orders independently.
  const request = req({ page: "3", payments: "2" });

  const orders = paginate(request, 100, {
    path: "/payouts/4",
    params: { payments: request.query.payments },
  });
  const payments = paginate(request, 100, {
    path: "/payouts/4",
    param: "payments",
    params: { page: request.query.page },
  });

  check("each list reads its own page number",
    orders.page === 3 && payments.page === 2,
    `${orders.page}/${payments.page}`);

  // Turning the page on one list must not reset the other.
  check("turning the orders page keeps the payments page",
    orders.href(4) === "/payouts/4?payments=2&page=4", orders.href(4));
  check("and the other way round",
    payments.href(3) === "/payouts/4?page=3&payments=3", payments.href(3));

  check("going back to page 1 of one list drops only its own key",
    payments.href(1) === "/payouts/4?page=3", payments.href(1));
}

console.log("\nThe numbers to draw");
{
  const one = paginate(req(), 10, { path: "/x" });
  check("a single page draws one number",
    one.numbers.length === 1 && one.numbers[0] === 1);

  const few = paginate(req(), 60, { path: "/x" }); // 4 pages
  check("a short list draws every page with no gaps",
    few.numbers.join(",") === "1,2,3,4", few.numbers.join(","));

  // 100 pages, sitting in the middle: first, a gap, a window, a gap, last.
  const deep = paginate(req({ page: "50" }), 1500, { path: "/x" });
  check("a long list is windowed",
    deep.numbers.join(",") === "1,,48,49,50,51,52,,100",
    deep.numbers.join(","));
  check("the first page is always reachable", deep.numbers[0] === 1);
  check("so is the last",
    deep.numbers[deep.numbers.length - 1] === deep.pages);

  const nearStart = paginate(req({ page: "2" }), 1500, { path: "/x" });
  check("near the start there is no leading gap",
    nearStart.numbers.slice(0, 4).join(",") === "1,2,3,4",
    nearStart.numbers.join(","));

  // A gap standing for a single page is drawn as that page: "1 ... 3" is
  // longer than "1 2 3" and says less.
  const tight = paginate(req({ page: "4" }), 90, { path: "/x" }); // 6 pages
  check("a one-page gap is filled in rather than elided",
    !tight.numbers.includes(null), tight.numbers.join(","));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
