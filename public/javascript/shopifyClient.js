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
})();
