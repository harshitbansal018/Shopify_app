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

  /**
   * fetch() with the Shopify session token attached.
   *
   * Pass `busy` -- a button, or a list of them -- and it spins for as long as
   * the request runs, then goes back to how it was. The top loading bar runs
   * for every request regardless, so even a request with no button (a pill
   * click, a background save) shows that something is happening.
   *
   *   const response = await appFetch("/orders/5/fulfil", {
   *     method: "POST", body, busy: button
   *   });
   */
  async function appFetch(input, init) {
    const options = Object.assign({}, init);
    const headers = new Headers(options.headers || {});
    const controls = [].concat(options.busy || []).filter(Boolean);
    delete options.busy;

    controls.forEach((control) => appBusy(control, true));
    requestStarted();

    try {
      try {
        headers.set("Authorization", "Bearer " + (await idToken()));
      } catch (error) {
        console.warn(error.message);
      }

      options.headers = headers;
      return await fetch(input, options);
    } finally {
      requestFinished();
      controls.forEach((control) => appBusy(control, false));
    }
  }

  /* ---------------- spinners ----------------
   *
   * One rule for every button that starts a request: while the request is
   * running the button spins and cannot be clicked twice, and afterwards it
   * is exactly as it was -- same label, same disabled state -- so a screen
   * that disabled it for its own reasons is not silently re-enabled.
   */

  /** Put a button into, or take it out of, its spinning state. */
  function appBusy(control, on) {
    if (!control) return;

    // The admin's own button has a spinner built in.
    if ("loading" in control && control.localName === "s-button") {
      if (on) {
        control.dataset.busyWasDisabled = control.disabled ? "1" : "0";
        control.disabled = true;
        control.loading = true;
      } else {
        control.loading = false;
        control.disabled = control.dataset.busyWasDisabled === "1";
        delete control.dataset.busyWasDisabled;
      }
      return;
    }

    if (on) {
      control.dataset.busyWasDisabled = control.disabled ? "1" : "0";
      control.disabled = true;
      control.setAttribute("aria-busy", "true");
      control.classList.add("is-loading");
    } else {
      control.classList.remove("is-loading");
      control.removeAttribute("aria-busy");
      control.disabled = control.dataset.busyWasDisabled === "1";
      delete control.dataset.busyWasDisabled;
    }
  }

  /* ---------------- the loading bar ----------------
   *
   * Every screen is a full page load, and between the click and the next
   * page there is a token fetch plus a round trip with nothing on screen to
   * say anything is happening. Inside the admin, App Bridge's own loading bar
   * runs along the top of the admin; outside it (local development, the
   * landing page's install flow) a thin bar of our own stands in.
   *
   * Two things keep it running: a navigation in progress, and any number of
   * requests in flight. It goes off only when neither is true, so a request
   * finishing must not switch off the bar for a page that is still loading.
   */

  let navigating = false;
  let requestsInFlight = 0;
  let loadingTimer = null;

  function applyLoading() {
    const on = navigating || requestsInFlight > 0;
    const admin =
      window.shopify && typeof window.shopify.loading === "function";

    if (admin) {
      try {
        window.shopify.loading(on);
      } catch (error) {
        console.warn("App Bridge loading indicator:", error.message);
      }
    }

    // Ours only where the admin's is not available -- both at once is noise.
    document.documentElement.classList.toggle("is-navigating", on && !admin);
  }

  function setLoading(on) {
    navigating = Boolean(on);
    applyLoading();

    // A navigation that never happens (the request was blocked, the user hit
    // Escape) must not leave the bar running forever.
    clearTimeout(loadingTimer);
    if (on) loadingTimer = setTimeout(() => setLoading(false), 10000);
  }

  function requestStarted() {
    requestsInFlight++;
    applyLoading();
  }

  function requestFinished() {
    requestsInFlight = Math.max(0, requestsInFlight - 1);
    applyLoading();
  }

  /** Navigate within the app, carrying the session token on the URL. */
  async function appNavigate(pathname) {
    const url = new URL(pathname, window.location.origin);

    // Before the token fetch, not after: that fetch is most of the wait.
    setLoading(true);

    try {
      url.searchParams.set("id_token", await idToken());
    } catch (error) {
      console.warn(error.message);
    }

    window.location.assign(url.toString());
  }

  // The admin nav, back/forward, the Stores link in a notice: whatever starts
  // the navigation, the page unloading is the one signal common to all of
  // them, so the bar starts here and stops when the next page has arrived.
  window.addEventListener("pagehide", () => setLoading(true));

  // The next page. `pageshow` also covers a page restored from the back-forward
  // cache, where no load event fires and the bar would otherwise stay on.
  window.addEventListener("pageshow", () => setLoading(false));
  window.addEventListener("DOMContentLoaded", () => setLoading(false));

  // The admin nav's own links, the moment they are clicked -- App Bridge
  // relays the click to the admin and there is a beat before the page
  // unloads. Capture phase, so it runs even if App Bridge stops the event.
  document.addEventListener(
    "click",
    (event) => {
      if (event.target.closest("s-app-nav")) setLoading(true);
    },
    true
  );

  /** Show a message using the admin toast when available. */
  function appToast(message, isError) {
    if (window.shopify && window.shopify.toast) {
      window.shopify.toast.show(message, { isError: Boolean(isError) });
      return;
    }
    window.alert(message);
  }

  /* ---------------- the admin's own dialogs ----------------
   *
   * App Bridge ships Polaris web components -- <s-modal>, <s-button> -- that
   * render as the Shopify admin's own dialogs, over the whole admin rather than
   * inside the app's iframe. Every confirmation and popup in the app goes
   * through here so it looks like the rest of the admin, and so a browser's
   * bare window.confirm() -- which some browsers suppress inside an iframe
   * altogether -- is only ever a fallback outside the admin.
   */

  /**
   * Resolves true once the element is the admin's component, false if it
   * never will be.
   *
   * App Bridge registers its components lazily -- the definition for a tag
   * is fetched when that tag first appears in the page -- so the element has
   * to be IN the document before this is waited on, and a freshly created
   * <s-modal> is a plain unknown element for a moment after. Inside the
   * admin, wait for the upgrade; outside it, or if it never comes, say so
   * rather than hang.
   */
  function upgraded(element) {
    const tag = element.localName;

    if (!window.customElements) return Promise.resolve(false);
    if (window.customElements.get(tag)) return Promise.resolve(true);
    if (!appBridgeReady()) return Promise.resolve(false);

    return Promise.race([
      window.customElements.whenDefined(tag).then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
    ]);
  }

  /** Open an <s-modal>, or a <dialog> where the admin's is not available. */
  function appOpen(element) {
    return upgraded(element).then((admin) => {
      if (admin && typeof element.showOverlay === "function") {
        return element.showOverlay();
      }
      if (typeof element.showModal === "function") return element.showModal();
      element.setAttribute("open", "");
    });
  }

  function appClose(element) {
    if (typeof element.hideOverlay === "function") return element.hideOverlay();
    if (typeof element.close === "function") return element.close();
    element.removeAttribute("open");
  }

  let confirmCount = 0;

  /**
   * Ask a yes/no question, the admin's way. Resolves true or false.
   *
   *   await appConfirm("Delete this?\n\nIt cannot be undone.", {
   *     confirmLabel: "Delete", destructive: true
   *   });
   *
   * The first paragraph of the message is the dialog's heading; the rest is
   * its body -- which is exactly how every message in the app was already
   * written for window.confirm, so the call sites read the same.
   */
  function appConfirm(message, options) {
    options = options || {};

    const parts = String(message)
      .split(/\n{2,}/)
      .map((part) => part.trim())
      .filter(Boolean);
    const title = options.title || parts.shift() || "Are you sure?";

    return new Promise((resolve) => {
      const modal = document.createElement("s-modal");
      modal.id = "app-confirm-" + ++confirmCount;
      modal.setAttribute("heading", title);
      modal.setAttribute("accessibilityLabel", title);

      parts.forEach((text) => {
        const paragraph = document.createElement("p");
        paragraph.className = "modal__copy";
        paragraph.textContent = text;
        modal.appendChild(paragraph);
      });

      const ok = document.createElement("s-button");
      ok.setAttribute("slot", "primary-action");
      ok.setAttribute("variant", "primary");
      // Red for anything that deletes, refunds or cannot be undone.
      if (options.destructive) ok.setAttribute("tone", "critical");
      ok.textContent = options.confirmLabel || "Confirm";

      const cancel = document.createElement("s-button");
      cancel.setAttribute("slot", "secondary-actions");
      cancel.textContent = options.cancelLabel || "Cancel";

      let settled = false;

      function finish(value) {
        if (settled) return;
        settled = true;
        resolve(value);
        appClose(modal);
      }

      ok.addEventListener("click", () => finish(true));
      cancel.addEventListener("click", () => finish(false));
      // Closed by Escape, the X, or a click outside: that is a no.
      modal.addEventListener("afterhide", () => {
        finish(false);
        modal.remove();
      });

      modal.appendChild(ok);
      modal.appendChild(cancel);
      // Into the page before waiting: that is what makes App Bridge load it.
      document.body.appendChild(modal);

      upgraded(modal).then((admin) => {
        if (settled) return;

        if (!admin || typeof modal.showOverlay !== "function") {
          // Not in the admin (or its components never arrived): the
          // browser's own question, rather than a dialog that never opens.
          modal.remove();
          settled = true;
          resolve(window.confirm([title].concat(parts).join("\n\n")));
          return;
        }

        modal.showOverlay();
      });
    });
  }

  window.appOpen = appOpen;
  window.appClose = appClose;
  window.appConfirm = appConfirm;

  window.appFetch = appFetch;
  window.appBusy = appBusy;
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
