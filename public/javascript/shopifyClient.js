/* Shared App Bridge helpers.
 *
 * App Bridge is loaded from cdn.shopify.com/shopifycloud/app-bridge.js and
 * exposes a global `shopify` object. It attaches a session token to same-origin
 * fetches automatically, but we set the header explicitly so requests still
 * authenticate if that behaviour changes.
 */
(function () {
  function appBridgeReady() {
    return Boolean(window.shopify && typeof window.shopify.idToken === "function");
  }

  async function idToken() {
    if (!appBridgeReady()) {
      throw new Error("App Bridge is not available on this page");
    }
    return window.shopify.idToken();
  }

  /** fetch() with the Shopify session token attached. */
  async function appFetch(input, init) {
    const options = Object.assign({}, init);
    const headers = new Headers(options.headers || {});

    try {
      headers.set("Authorization", "Bearer " + (await idToken()));
    } catch (error) {
      console.warn(error.message);
    }

    options.headers = headers;
    return fetch(input, options);
  }

  /** Navigate within the app, carrying the session token on the URL. */
  async function appNavigate(pathname) {
    const url = new URL(pathname, window.location.origin);

    try {
      url.searchParams.set("id_token", await idToken());
    } catch (error) {
      console.warn(error.message);
    }

    window.location.assign(url.toString());
  }

  /** Show a message using the admin toast when available. */
  function appToast(message, isError) {
    if (window.shopify && window.shopify.toast) {
      window.shopify.toast.show(message, { isError: Boolean(isError) });
      return;
    }
    window.alert(message);
  }

  window.appFetch = appFetch;
  window.appNavigate = appNavigate;
  window.appToast = appToast;

  /*
   * Anything carrying data-navigate goes there when clicked.
   *
   * Inside the admin iframe a plain <a href> loses the session token and the
   * page comes back unauthenticated, so every internal link has to go through
   * appNavigate. Doing it once here, delegated, is what lets a partial like the
   * pager be dropped into any screen without also copying a click handler into
   * that screen's script block.
   *
   * Delegated from the document, so it also works for rows added after load.
   */
  document.addEventListener("click", function (event) {
    var target = event.target.closest("[data-navigate]");

    if (!target || target.disabled) return;

    var href = target.getAttribute("data-navigate");

    // Empty is deliberate -- the current page's own number, and the Prev button
    // on page one, are rendered as disabled controls rather than removed.
    if (!href) return;

    event.preventDefault();
    appNavigate(href);
  });

  /*
   * A GET form that navigates instead of submitting.
   *
   * A real <form method="get"> inside the admin iframe posts to the top window
   * and comes back without a session token, so the search box has to become an
   * appNavigate. Keeping it a FORM rather than an input plus a click handler is
   * what makes Enter submit, phone keyboards show a Search key, and the browser
   * offer what was typed here before.
   *
   * Empty fields are dropped rather than sent as key=, so clearing the box
   * really clears the search instead of searching for nothing.
   */
  document.addEventListener("submit", function (event) {
    var form = event.target.closest("form[data-navigate-form]");

    if (!form) return;

    event.preventDefault();

    var params = new URLSearchParams();

    new FormData(form).forEach(function (value, key) {
      var trimmed = String(value).trim();
      if (trimmed) params.set(key, trimmed);
    });

    var query = params.toString();
    appNavigate(form.getAttribute("action") + (query ? "?" + query : ""));
  });
})();
