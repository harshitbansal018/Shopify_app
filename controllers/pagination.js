// controllers/pagination.js
//
// One page of a list, worked out once and handed to the view.
//
// Every table in the app grows without a ceiling -- a source store's catalogue,
// a destination's sales, a supplier's payments -- and each one used to render
// whatever the model's default LIMIT happened to return. That is two separate
// problems: the screen becomes unusable long before the limit is reached, and
// past the limit rows are silently missing with nothing on the page to say so.
//
// The page number lives in the query string rather than in a POST or in
// session, so a link is shareable, the back button works, and a reload does not
// resubmit anything.
const PAGE_SIZE = 15;

/** How many numbered links to draw around the current page. */
const WINDOW = 2;

/**
 * The numbers to draw, with `null` standing for a gap.
 *
 * First and last are always present, so however deep the merchant is they can
 * always get back to the start or jump to the end in one click.
 */
function numbersFor(page, pages) {
  if (pages <= 1) return [1];

  const wanted = new Set([1, pages]);

  for (let n = page - WINDOW; n <= page + WINDOW; n += 1) {
    if (n > 1 && n < pages) wanted.add(n);
  }

  const sorted = [...wanted].sort((a, b) => a - b);
  const out = [];

  sorted.forEach((n, index) => {
    // A gap of exactly one number is drawn as that number: "1 … 3" is longer
    // than "1 2 3" and tells the merchant less.
    if (index > 0 && n - sorted[index - 1] > 1) out.push(null);
    out.push(n);
  });

  return out;
}

/**
 * Read ?page, clamp it, and return everything both the query and the view need.
 *
 * `total` is a COUNT from the database, not the length of a loaded array -- the
 * whole point is to avoid loading the rest.
 *
 * Clamping rather than 404ing on an out-of-range page matters more than it
 * looks: bookmarks go stale as rows are added and removed, and landing on the
 * last page is a far better answer than an error or an empty table.
 */
function paginate(
  req,
  total,
  { path, params = {}, pageSize = PAGE_SIZE, param = "page" } = {}
) {
  const count = Math.max(0, Number(total) || 0);
  const size = Math.max(1, Number(pageSize) || PAGE_SIZE);
  const pages = Math.max(1, Math.ceil(count / size));

  // A repeated key -- ?page=2&page=9 -- reaches Express as an ARRAY, and
  // parseInt would quietly coerce ["2","9"] to 2. Only a plain string counts.
  const raw = req.query ? req.query[param] : undefined;
  const asked = typeof raw === "string" ? Number.parseInt(raw, 10) : NaN;
  const page = Math.min(Math.max(Number.isFinite(asked) ? asked : 1, 1), pages);

  const offset = (page - 1) * size;

  return {
    page,
    pages,
    total: count,
    pageSize: size,
    // For the model.
    limit: size,
    offset,
    // "Showing 16-30 of 214". Both are 0 when there is nothing, so the view can
    // tell an empty list from a full one without a second check.
    from: count ? offset + 1 : 0,
    to: Math.min(offset + size, count),
    hasPrev: page > 1,
    hasNext: page < pages,
    numbers: numbersFor(page, pages),

    /**
     * The URL for another page of THIS list.
     *
     * The filter and tab travel with it, or paging inside "Unshared" would
     * quietly drop the merchant back into the full catalogue. `id_token` is not
     * added here -- appNavigate attaches a fresh one, and an old token copied
     * onto a link would be expired by the time it was clicked.
     *
     * `params` is also how a screen with TWO lists keeps them apart: each pager
     * uses its own `param` and carries the other one's current page along, so
     * turning the page on the payments does not reset the orders beside it.
     */
    href(n) {
      const search = new URLSearchParams();

      Object.entries(params).forEach(([key, value]) => {
        if (value !== null && value !== undefined && value !== "") {
          search.set(key, String(value));
        }
      });

      // Page 1 is the bare URL: it is the one people copy and share.
      if (n > 1) search.set(param, String(n));
      else search.delete(param);

      const queryString = search.toString();
      return queryString ? `${path}?${queryString}` : path;
    },
  };
}

module.exports = { paginate, PAGE_SIZE };
