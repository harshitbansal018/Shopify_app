require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");

const authRoutes = require("./routes/authRoute");
const dashboardRoutes = require("./routes/dashboardRoute");
const pagesRoute = require("./routes/pageRoute");
const pageEditRoute = require("./routes/pageEditRoute");

const app = express();

// 🔥 MIDDLEWARE
app.use(cors());

// ✅ REQUIRED for form data
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// 🔥 VIEW ENGINE
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// 🔥 STATIC FILES (CSS/JS)
app.use(express.static(path.join(__dirname, "public")));

// 🔥 SERVE UPLOADED IMAGES (VERY IMPORTANT)
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// 🔥 ROUTES
app.use("/api/auth", authRoutes);
app.use("/", dashboardRoutes);
app.use("/pages", pagesRoute);
app.use("/webhooks", require("./routes/webhookRoute"));
app.use("/", pageEditRoute);

// 🔥 START SERVER
app.listen(process.env.PORT || 3000, () => {
  console.log(`Server running on port ${process.env.PORT || 3000}`);
});