/* The Help screen's questions, which live in the database.
 *
 * Run against the real database. The whole reason these moved out of the code
 * is that somebody can edit them without a deploy -- so the thing worth
 * proving is that an edit STICKS: that a later boot does not quietly write the
 * original wording back over it.
 */
require("dotenv").config({ quiet: true });

const path = require("path");

const SERVER = path.join(__dirname, "..");

const { pool, query } = require(path.join(SERVER, "config/db"));
const { runMigrations } = require(path.join(SERVER, "config/migrate"));
const faqModel = require(path.join(SERVER, "models/faqModel"));
const helpController = require(path.join(SERVER, "controllers/helpController"));

const MARK = `faqtest-${Date.now().toString(36)}`;

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` -> ${detail}` : ""}`);
  }
}

async function cleanup() {
  await query("DELETE FROM faqs WHERE question LIKE ?", [`${MARK}%`]);
}

(async () => {
  try {
    await runMigrations();
    await cleanup();

    /* ---------------- what a fresh install starts with ---------------- */

    console.log("\nThe seeded set");
    {
      for (const role of faqModel.ROLES) {
        const rows = await faqModel.listForRole(role);

        check(`${role} has its questions`,
          rows.length >= helpController.DEFAULT_FAQ[role].length,
          `${rows.length} rows`);
        check(`${role} rows carry both halves`,
          rows.every((row) => row.question.trim() && row.answer.trim()),
          "a blank answer is worse than no question");
        check(`${role} comes back in a deliberate order`,
          rows.every((row, i) => i === 0 || row.position >= rows[i - 1].position),
          "unordered help reads as a pile, not a list");
      }

      // Counted in tens, so a question can be slipped between two others.
      const [first] = await faqModel.listForRole("source");
      check("positions leave room to insert between",
        first.position >= 10,
        "consecutive integers force a renumber to add one in the middle");
    }

    /* ---------------- editing, which is the point ---------------- */

    console.log("\nEditing without a deploy");
    {
      const added = await faqModel.create({
        role: "source",
        question: `${MARK} Where does this appear?`,
        answer: "On the Help screen, without anybody redeploying the app.",
      });

      check("a question can be added", Boolean(added && added.id));
      check("and lands at the end of its role's list",
        (await faqModel.listForRole("source")).slice(-1)[0].id === added.id,
        "a new row jumping to the top would reorder a deliberate list");
      check("it shows for its own role only",
        (await faqModel.listForRole("destination"))
          .every((row) => row.id !== added.id),
        "showing a source the destination's rules is worse than showing none");

      const reworded = await faqModel.update(added.id, {
        answer: "Reworded, from the database.",
      });

      check("an answer can be reworded", reworded.answer === "Reworded, from the database.");
      check("without touching the question",
        reworded.question === `${MARK} Where does this appear?`,
        "a partial edit must not blank the other half");

      /* ---- the guarantee that makes this worth doing ---- */
      await runMigrations();

      check("and a later boot does NOT undo it",
        (await faqModel.findById(added.id)).answer ===
          "Reworded, from the database.",
        "re-seeding over edits would defeat the whole point of the table");

      const stillThere = await faqModel.listForRole("source");
      check("nor does it duplicate the seeded ones",
        stillThere.filter((row) => row.question === stillThere[0].question)
          .length === 1,
        "seeding twice would double every question on the screen");

      /* ---- hiding, rather than deleting ---- */
      await faqModel.update(added.id, { isActive: false });

      check("a question can be hidden",
        (await faqModel.listForRole("source")).every((row) => row.id !== added.id));
      check("but its text is kept",
        Boolean((await faqModel.findById(added.id)).answer),
        "a question being reworked should not lose what it said");
      check("and it is still there for whoever edits the list",
        (await faqModel.listAll("source")).some((row) => row.id === added.id));

      await faqModel.remove(added.id);
      check("and it can be deleted for good",
        (await faqModel.findById(added.id)) === null);
    }

    /* ---------------- what it refuses ---------------- */

    console.log("\nWhat it will not store");
    {
      let refused = false;
      try {
        await faqModel.create({ role: "nonsense", question: "q", answer: "a" });
      } catch (err) {
        refused = /role must be/.test(err.message);
      }
      check("an unknown role is refused", refused);

      refused = false;
      try {
        await faqModel.create({ role: "source", question: "  ", answer: "a" });
      } catch (err) {
        refused = true;
      }
      check("a blank question is refused", refused);

      refused = false;
      try {
        await faqModel.create({ role: "source", question: "q", answer: "" });
      } catch (err) {
        refused = true;
      }
      check("and so is a blank answer",
        refused,
        "an empty accordion row is a dead end on a help page");

      check("an unknown role reads back as nothing, not an error",
        (await faqModel.listForRole("nonsense")).length === 0,
        "the screen must not 500 because a role string drifted");
    }
  } catch (err) {
    check("suite ran", false, err.message);
    console.error(err);
  } finally {
    await cleanup();
    console.log(`\n${passed} passed, ${failed} failed`);
    await pool.end();
    process.exitCode = failed ? 1 : 0;
  }
})();
