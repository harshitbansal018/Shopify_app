// middleware/planStatus.js
//
// Gives every destination screen its plan status, so the warning banner in
// views/partials/planBanner.ejs can appear on all of them without each
// controller having to fetch and pass it.
//
// Done at render time, not up front: most requests are JSON actions that
// render nothing, and they should not pay for counting products and orders.
// res.render is wrapped for this request only, and the wrapper does its work
// only when a page is actually rendered for a destination store.
//
// A screen that already has the snapshot (the Plans screen counts everything
// anyway) passes it as `planStatus`, and it is reused rather than counted twice.
const planLimits = require("../services/planLimits");

function planStatus(req, res, next) {
  const render = res.render.bind(res);

  res.render = function renderWithPlanStatus(view, locals, callback) {
    if (typeof locals === "function") {
      callback = locals;
      locals = {};
    }

    const data = locals || {};
    const store = req.store;

    // Source stores, the landing page, the role picker: no plan to show.
    if (!store || store.store_type !== "destination") {
      return render(view, data, callback);
    }

    if (data.planStatus) {
      return render(
        view,
        { ...data, planBanner: planLimits.bannerItems(data.planStatus) },
        callback
      );
    }

    planLimits
      .snapshot(store)
      .then((snap) =>
        render(
          view,
          { ...data, planStatus: snap, planBanner: planLimits.bannerItems(snap) },
          callback
        )
      )
      .catch((err) => {
        // A failed count must not take the screen down with it: render it
        // without the banner, and say why in the log.
        console.error("Plan status could not be read:", err.message);
        render(view, data, callback);
      });
  };

  next();
}

module.exports = planStatus;
