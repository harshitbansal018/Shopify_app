const multer = require("multer");
const path = require("path");

const storage = multer.diskStorage({
  destination: path.join(__dirname, "..", "uploads"),
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});

const upload = multer({ storage }); // ✅ ACCEPT ANY FILES, WE'LL HANDLE IN CONTROLLER

module.exports = upload; // ✅ IMPORTANT
