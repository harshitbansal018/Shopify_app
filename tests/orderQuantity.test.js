const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const shippingValidation = require("../public/javascript/shippingValidation");

const template = fs.readFileSync(path.join(__dirname, "../views/source/orderDetail.ejs"), "utf8");
const script = template.match(/<script>([\s\S]*?)<\/script>/)[1].replaceAll("<%= order.id %>", "1");

function page(remaining) {
  const total = remaining.reduce((sum, quantity) => sum + quantity, 0);
  function element(properties = {}) {
    return { listeners: {}, textContent: "", value: "", disabled: false,
      attributes: {}, validationMessage: "",
      setCustomValidity(message) { this.validationMessage = message; },
      setAttribute(name, value) { this.attributes[name] = value; },
      reportValidity() {}, focus() {},
      addEventListener(event, listener) { this.listeners[event] = listener; }, ...properties };
  }
  const inputs = remaining.map((quantity, index) => element({
    value: String(quantity), min: remaining.filter((count) => count > 0).length === 1 ? "1" : "0", max: String(quantity),
    dataset: { line: String(index + 1), remaining: String(quantity) },
    validationMessage: "", attributes: {},
    setCustomValidity(message) { this.validationMessage = message; },
    setAttribute(name, value) { this.attributes[name] = value; },
    reportValidity() {}, focus() {},
  }));
  const elements = {
    back: element(), fulfil: element(), "fulfil-partial": element({ disabled: total <= 1 }),
    "page-error": element({ hidden: true }), carrier: element(),
    "tracking-number": element(), "tracking-url": element(),
  };
  const requests = [];
  vm.runInNewContext(script, {
    document: { getElementById: (id) => elements[id] || null,
      querySelectorAll: (selector) => selector === ".ship-qty" ? inputs : [] },
    window: { shippingValidation, appNavigate() {}, appToast() {},
      async appFetch(url, options) {
        requests.push({ url, body: JSON.parse(options.body) });
        return { ok: true, async json() { return { destinationUpdated: true }; } };
      },
    },
  });
  return { inputs, elements, requests };
}

test("invalid shipping quantities never send a partial or full shipment", async () => {
  for (const value of ["", "0", "-1", "1.5", "3", "NaN", "1e0"]) {
    for (const action of ["fulfil", "fulfil-partial"]) {
      const view = page([2]);
      view.inputs[0].value = value;
      view.inputs[0].listeners.input();
      assert.equal(view.inputs[0].attributes["aria-invalid"], "true");
      await view.elements[action].listeners.click();
      assert.equal(view.requests.length, 0, `${action} must reject ${JSON.stringify(value)}`);
      assert.match(view.elements["page-error"].textContent, /whole number between 1 and 2/);
    }
  }
});

test("a valid partial quantity is posted and a full quantity needs Fulfilled", async () => {
  const view = page([3]);
  view.inputs[0].value = "1";
  await view.elements["fulfil-partial"].listeners.click();
  assert.deepEqual(view.requests[0].body.lines, [{ line_id: 1, quantity: 1 }]);
  const all = page([3]);
  await all.elements["fulfil-partial"].listeners.click();
  assert.equal(all.requests.length, 0);
  assert.match(all.elements["page-error"].textContent, /Use Fulfilled/);
  await all.elements.fulfil.listeners.click();
  assert.equal(all.requests.length, 1);
  assert.equal(all.requests[0].body.lines, undefined);
});

test("the last unit cannot be partly shipped and separate unit lines can be split", async () => {
  const single = page([1]);
  await single.elements["fulfil-partial"].listeners.click();
  assert.equal(single.requests.length, 0);
  await single.elements.fulfil.listeners.click();
  assert.equal(single.requests.length, 1);
  const separate = page([1, 1]);
  separate.inputs[1].value = "0";
  await separate.elements["fulfil-partial"].listeners.click();
  assert.deepEqual(separate.requests[0].body.lines, [{ line_id: 1, quantity: 1 }, { line_id: 2, quantity: 0 }]);
});

test("both shipping actions reject invalid carrier, tracking number and URL before posting", async () => {
  for (const action of ["fulfil", "fulfil-partial"]) {
    for (const [field, value] of [["carrier", "<bad>"], ["tracking-number", "bad`="],
      ["tracking-url", "carrier.com/123"], ["tracking-url", "javascript:alert(1)"]]) {
      const view = page([2]);
      view.inputs[0].value = "1";
      view.elements["tracking-number"].value = "TRACK-123";
      view.elements[field].value = value;
      view.elements[field].listeners.input();
      assert.equal(view.elements[field].attributes["aria-invalid"], "true");
      await view.elements[action].listeners.click();
      assert.equal(view.requests.length, 0);
      assert.equal(view.elements["page-error"].hidden, false);
    }
  }
});

test("tracking cross-field requirements are enforced and errors clear after correction", async () => {
  const view = page([1]);
  view.elements.carrier.value = "DHL";
  view.elements["tracking-url"].value = "https://carrier.com/track/123";
  await view.elements.fulfil.listeners.click();
  assert.equal(view.requests.length, 0);
  assert.match(view.elements["page-error"].textContent, /Enter a tracking number/);
  view.elements["tracking-number"].value = " TRACK-123 ";
  view.elements["tracking-number"].listeners.input();
  assert.equal(view.elements["tracking-number"].attributes["aria-invalid"], "false");
  await view.elements.fulfil.listeners.click();
  assert.deepEqual(view.requests[0].body.tracking, [{
    number: "TRACK-123", company: "DHL", url: "https://carrier.com/track/123",
  }]);
});

test("server and browser use the same tracking length and URL rules", () => {
  assert.deepEqual(shippingValidation.cleanTracking([{}]), []);
  assert.deepEqual(shippingValidation.cleanTracking([{ number: " TN-123 ", company: " DHL ", url: "https://carrier.com/track/123" }]),
    [{ number: "TN-123", company: "DHL", url: "https://carrier.com/track/123" }]);
  for (const parcel of [
    { number: "X".repeat(129) }, { number: "1", company: "X".repeat(129) },
    { number: "1", url: "https://carrier.com/" + "x".repeat(512) },
    { number: "1", url: "http:/carrier.com/123" }, { number: "1", url: "https://carrier.com/a b" },
    { number: true }, { number: "1", company: {} }, null,
  ]) assert.throws(() => shippingValidation.cleanTracking([parcel]), { statusCode: 400 });
});
