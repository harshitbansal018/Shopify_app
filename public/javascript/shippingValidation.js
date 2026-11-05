(function (root, factory) {
  var validation = factory();
  if (typeof module === "object" && module.exports) module.exports = validation;
  else root.shippingValidation = validation;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";
  var limits = { company: 128, number: 128, url: 512 };

  function errorsFor(parcel) {
    var errors = {};
    if (!parcel || typeof parcel !== "object" || Array.isArray(parcel)) {
      return { number: "Enter valid shipping tracking details." };
    }
    var values = {};
    Object.keys(limits).forEach(function (field) {
      var raw = parcel[field];
      if (raw != null && typeof raw !== "string") {
        errors[field] = "Enter " + (field === "company" ? "the carrier" : field === "number" ? "the tracking number" : "the tracking link") + " as text.";
      }
      values[field] = typeof raw === "string" ? raw.trim() : "";
      if (values[field].length > limits[field]) {
        errors[field] = (field === "company" ? "Carrier" : field === "number" ? "Tracking number" : "Tracking link") + " must be " + limits[field] + " characters or fewer.";
      }
    });
    if (values.company && !/^[\p{L}\p{N}][\p{L}\p{N} .&'()/_-]*$/u.test(values.company)) {
      errors.company = "Carrier can contain letters, numbers, spaces and standard name punctuation.";
    }
    if (values.number && !/^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/.test(values.number)) {
      errors.number = "Tracking number can contain letters, numbers, spaces, hyphens, dots, underscores and slashes.";
    }
    if (!values.number && (values.company || values.url)) {
      errors.number = "Enter a tracking number when a carrier or tracking link is provided.";
    }
    if (values.url) {
      try {
        var parsed = new URL(values.url);
        if (!/^https?:\/\//i.test(values.url) || !parsed.hostname ||
            !["https:", "http:"].includes(parsed.protocol) || /\s/.test(values.url)) throw new Error();
      } catch (_) {
        errors.url = "Tracking link must be a complete http:// or https:// URL, for example https://carrier.com/track/123.";
      }
    }
    return errors;
  }

  function cleanTracking(tracking) {
    if (tracking == null) return [];
    if (!Array.isArray(tracking) || tracking.length > 250) {
      throw Object.assign(new Error("Tracking must be a list of up to 250 parcels."), { statusCode: 400 });
    }
    return tracking.map(function (parcel) {
      var errors = errorsFor(parcel);
      var field = Object.keys(errors)[0];
      if (field) throw Object.assign(new Error(errors[field]), { statusCode: 400, field: field });
      var number = (parcel.number || "").trim();
      return number ? { number: number, company: (parcel.company || "").trim() || null,
        url: (parcel.url || "").trim() || null } : null;
    }).filter(Boolean);
  }
  return { errorsFor: errorsFor, cleanTracking: cleanTracking, limits: limits };
});
