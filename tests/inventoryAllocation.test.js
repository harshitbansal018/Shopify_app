require("dotenv").config({ quiet: true });

const path = require("path");
const allocation = require(path.join(__dirname, "..", "services/inventoryAllocation"));

let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` -> ${detail}` : ""}`);
  }
}

console.log("\nInventory allocation");

check("source adjustments use Shopify idempotency",
  allocation.ADJUST_INVENTORY_MUTATION.includes("@idempotent"));
check("destination stock sets use Shopify idempotency",
  allocation.SET_DESTINATION_INVENTORY_MUTATION.includes("@idempotent"));
check("inventory levels do not require the read_locations scope",
  allocation.INVENTORY_LEVELS_QUERY.includes("location { id }") &&
    !allocation.INVENTORY_LEVELS_QUERY.includes("isActive") &&
    !allocation.INVENTORY_LEVELS_QUERY.includes("location { id name"));

const levels = [
  {
    location: { id: "gid://shopify/Location/1", isActive: true },
    quantities: [{ name: "available", quantity: 10 }],
  },
  {
    location: { id: "gid://shopify/Location/2", isActive: true },
    quantities: [{ name: "available", quantity: 30 }],
  },
];

const reserved = allocation.planIncrease(levels, 25);
check("an allocation can span source locations",
  reserved.length === 2 && reserved[0].quantity === 10 && reserved[1].quantity === 15);

const reduced = allocation.planDecrease(reserved, 7);
check("a reduction returns stock to its original location",
  reduced.returned.length === 1 &&
    reduced.returned[0].locationId === "gid://shopify/Location/2" &&
    reduced.returned[0].quantity === 7);
check("the unsold location reservation remains balanced",
  reduced.kept.reduce((sum, row) => sum + row.quantity, 0) === 18);

check("orders consume the destination pool without touching source again",
  allocation.remaining(25, 8) === 17);
check("remaining stock can never become negative",
  allocation.remaining(5, 8) === 0);

let refused = false;
try {
  allocation.planIncrease(levels, 41);
} catch (error) {
  refused = error.statusCode === 409;
}
check("allocation cannot exceed live source availability", refused);

const merged = allocation.mergeLocations(
  [{ locationId: "gid://shopify/Location/1", quantity: 5 }],
  [{ locationId: "gid://shopify/Location/1", quantity: 3 }]
);
check("repeated allocation at one location is merged",
  merged.length === 1 && merged[0].quantity === 8);

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
