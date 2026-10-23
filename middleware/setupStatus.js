// middleware/setupStatus.js
//
// Gives every authenticated store screen its current setup progress. The
// shared navigation renders the banner, so individual controllers do not
// need to repeat this work.
//
// Progress is read only when a page is rendered. JSON actions therefore do
// not run setup queries, and a controller-provided snapshot is reused.
const setupController = require("../controllers/setupController");

function setupStatus(req, res, next) {
  const render = res.render.bind(res);

  res.render = function renderWithSetupStatus(view, locals, callback) {
    if (typeof locals === "function") {
      callback = locals;
      locals = {};
    }

    const data = locals || {};
    const store = req.store;

    // There is no role-specific setup before a role is selected. The setup
    // screen already shows the full checklist, so repeating its banner there
    // would add noise.
    if (!store || !store.store_type || view === "setup") {
      return render(view, data, callback);
    }

    if (Object.prototype.hasOwnProperty.call(data, "setup")) {
      return render(view, data, callback);
    }

    setupController
      .statusFor(store)
      .then((status) =>
        render(
          view,
          { ...data, setup: status.complete ? null : status },
          callback
        )
      )
      .catch((err) => {
        // Setup progress must never prevent the requested screen from loading.
        console.error("Setup status could not be read:", err.message);
        render(view, data, callback);
      });
  };

  next();
}

module.exports = setupStatus;
