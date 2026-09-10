# landing/ — the public marketing site

The page a stranger sees at the app's address. Separate from the merchant
screens in every way that matters: its own router, its own templates, its own
stylesheet, its own copy. Nothing in here imports from `views/`, `routes/` or
`public/css/app.css`, and nothing out there imports from in here — except the
one line in `server.js` that mounts it.

That separation is the point. The admin screens live inside Shopify's iframe
and are meant to disappear into it; this page has to hold a stranger's
attention on its own. Sharing components between the two would mean a change to
the marketing hero could move a button in a merchant's dashboard.

## Where it lives

| URL | What it does |
| --- | --- |
| `/` | The landing page **only when the request has no Shopify parameters**. |
| `/home` | The landing page, always. Use this to preview changes. |
| `/landing-assets/landing.css` | The stylesheet. |

`/` is shared with the embedded app on purpose — it is the address on the App
Store listing and the one merchants are given, so it has to serve both. They
are told apart by the query string: the Shopify admin always appends `shop` and
`host` when it opens an embedded app, and App Bridge adds `id_token`. A browser
typing the address in has none of them, so it gets the site.

When Shopify **is** asking, the router calls `next()` and the request carries on
to `storeRoutes` and `dashboardRoutes` exactly as it did before this folder
existed. Mounting the landing page cannot change the embedded app's entry path.

## The files

```
landing/
  index.js        the router. The ONLY file server.js touches.
  content.js      every word on the page. No HTML in here.
  pricing.js      reads the `plans` table and shapes it into cards.
  views/
    landing.ejs   the page: <head>, then one include per section.
    partials/
      nav.ejs       sticky top bar
      hero.ejs      headline + the install form + the flow diagram
      roles.ejs     source vs destination, side by side
      steps.ejs     the four-step install
      features.ejs  the capability grid
      pricing.ejs   the plan cards (data from pricing.js)
      faq.ejs       details/summary accordion
      closing.ejs   the last call to action
      footer.ejs    company, links, legal
      icon.ejs      inline SVGs, by name
  public/
    landing.css   the whole stylesheet
```

## How to change things

**Reword anything** → `content.js`. Every string on the page is there, grouped
by section. The templates hold layout and no copy, so you never open HTML to
change what the page says.

**Add or remove a feature card** → add an object to `FEATURES.items` in
`content.js`. Use an `icon` name that exists in `views/partials/icon.ejs`; an
unknown name renders nothing rather than a broken box.

**Add a new icon** → add one entry to the `paths` object in
`views/partials/icon.ejs`. They are 24×24, stroked, drawn with `currentColor`
so each takes the colour of whatever it sits in.

**Change a colour, a spacing, a breakpoint** → `public/landing.css`. The tokens
at the top (`--brand`, `--ink`, `--radius`, …) drive everything below them, so
a rebrand is a handful of lines.

**Add a whole section** → make `views/partials/<name>.ejs`, put its copy in
`content.js`, and add one `include` line to `views/landing.ejs` in the position
you want it.

## Pricing is not typed in

The plan cards come from the **`plans` table** — the same rows the in-app Plans
screen and the Shopify charge are built from.

```
plans.name          the card title
plans.price         0 renders as "Free"; anything else as "$N"
plans.days          30 → "/ month", 365 → "/ year"
plans.is_popular    which card is lifted out and badged
plans.max_limit     the "Up to N synced products" line
plans.plan_content  a JSON array of feature strings
plans.is_active     0 hides the plan from the page
```

Change a price in the database and the page follows on the next load, with no
deploy. That shared source is what stops the page quoting one number while
Shopify charges another.

Two failure modes are handled deliberately:

- **Bad `plan_content` JSON** → that plan still renders, with an empty feature
  list, and a warning is logged. A plan with a name and a price is still worth
  showing.
- **The database is unreachable** → the whole pricing section is skipped and
  the rest of the page renders. A marketing page that 500s over a database
  hiccup explains nothing and leads nowhere; one missing its prices still does
  both.

## The FAQ here is not the FAQ in the app

The `faqs` table answers *"how do I do this now that I have installed it"*. The
list in `content.js` answers *"should I install it at all"* — a different
audience asking different questions. Keeping them apart stops each set being
watered down to serve both. If you ever want the landing FAQ editable from the
database too, add a `landing` role to `models/faqModel.js` and read it from
`index.js`; nothing else would need to change.

## Things worth knowing before editing

- **No external requests.** System fonts, inline SVG, no CDN, no analytics. It
  loads behind a proxy, in a dev tunnel, and with no third party told who
  visited. Please keep it that way.
- **No JavaScript.** The accordion is `<details>`, the nav links are anchors,
  the install is a real `<form>`. Everything works before any script would have
  run, and the browser handles the back button.
- **The install form posts to the app's real route** (`/api/auth/install`). That
  route already validates the store address and already shows its own form when
  it is missing or wrong, so there is no validation here to fall out of step
  with it.
- **`:target { scroll-margin-top }`** in the CSS is what stops the sticky nav
  covering a section when you follow an anchor to it. Change the nav height and
  change that too.
