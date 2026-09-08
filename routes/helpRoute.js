const express = require("express");
const router = express.Router();

const { requireSession } = require("../middleware/auth");
const { getHelp } = require("../controllers/helpController");

// Behind a verified session token like every other screen. Nothing here reads
// the database, but the page still has to know which role it is talking to.
router.use(requireSession);

router.get("/", getHelp);

module.exports = router;
