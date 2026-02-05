"use strict";

const fastifyFactory = require("fastify");
const cors = require("@fastify/cors");
const jwt = require("@fastify/jwt");
const multipart = require("@fastify/multipart");
const fastifyStatic = require("@fastify/static");
const pump = require("pump");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const config = require("./config");
const { sequelize } = require("./models");

// ✅ FIX: define isProd once, then use everywhere safely
const NODE_ENV = process.env.NODE_ENV || "development";
const isProd = NODE_ENV === "production";

const buildServer = () => {
  const fastify = fastifyFactory({
    logger: {
      level: "info",
      transport:
        NODE_ENV === "development"
          ? {
              target: "pino-pretty",
              options: { colorize: true, translateTime: "HH:MM:ss" },
            }
          : undefined,
    },
  });

  /* ---------------- CORS ---------------- */
  fastify.register(cors, {
    origin: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  });

  /* ---------------- Multipart Uploads ---------------- */
  fastify.register(multipart, {
    limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
  });

  /* ---------------- Serve Static Uploads ---------------- */
  fastify.register(fastifyStatic, {
    root: path.join(__dirname, "../uploads"),
    prefix: "/uploads/",
  });

  /* ---------------- JWT ---------------- */
  fastify.register(jwt, { secret: config.jwt.secret });

  fastify.decorate("authenticate", async function (request, reply) {
    try {
      await request.jwtVerify();
    } catch (err) {
      request.log.error({ err }, "JWT verification failed");
      return reply.code(401).send({ error: "Unauthorized" });
    }
  });

  /* ---------------- BASIC ROUTES ---------------- */
  fastify.get("/", async () => ({
    status: "ok",
    service: "books-distribution-api",
    message: "Books Distribution API is running",
  }));

  fastify.get("/api/health", async () => ({
    status: "ok",
    service: "books-distribution-api",
  }));

  /* ---------------- LOGO UPLOAD ---------------- */
  fastify.post("/api/company-profile/logo-upload", async (request, reply) => {
    try {
      const file = await request.file();
      if (!file) return reply.code(400).send({ message: "No file uploaded" });

      const uploadDir = path.join(__dirname, "../uploads/company-logos");
      await fsp.mkdir(uploadDir, { recursive: true });

      const ext = path.extname(file.filename) || ".png";
      const filename = `logo-${Date.now()}${ext}`;
      const fullPath = path.join(uploadDir, filename);

      await new Promise((resolve, reject) => {
        pump(file.file, fs.createWriteStream(fullPath), (err) => {
          if (err) return reject(err);
          resolve();
        });
      });

      const publicPath = `/uploads/company-logos/${filename}`;
      const baseUrl =
        process.env.APP_BASE_URL || `${request.protocol}://${request.headers.host}`;

      return reply.send({
        message: "Logo uploaded successfully",
        logo_url: `${baseUrl}${publicPath}`,
        logo_path: publicPath,
      });
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ message: "Failed to upload logo" });
    }
  });

  /* ---------------- AUTH & MASTERS ---------------- */
  fastify.register(require("./routes/authRoutes"), { prefix: "/api/auth" });
  fastify.register(require("./routes/bookRoutes"), { prefix: "/api/books" });
  fastify.register(require("./routes/publisherRoutes"), {
    prefix: "/api/publishers",
  });

  /* =========================================================
     SUPPLIER (IMPORTANT ORDER)
     ========================================================= */

  // ✅ Supplier ledger
  fastify.register(require("./routes/supplierLedgerRoutes"), {
    prefix: "/api/suppliers",
  });

  // ✅ Supplier payments
  fastify.register(require("./routes/supplierPaymentRoutes"), {
    prefix: "/api/suppliers",
  });

  // ✅ Supplier receipts
  fastify.register(require("./routes/supplierReceiptsRoutes"), {
    prefix: "/api/supplier-receipts",
  });

  // ✅ Supplier receipt allocations (NEW)
  fastify.register(require("./routes/supplierReceiptAllocations.routes"), {
    prefix: "/api",
  });

  // ✅ Supplier CRUD (keep AFTER above)
  fastify.register(require("./routes/supplierRoutes"), {
    prefix: "/api/suppliers",
  });

  /* ---------------- OTHER MASTERS ---------------- */
  fastify.register(require("./routes/transportRoutes"), {
    prefix: "/api/transports",
  });

  fastify.register(require("./routes/classRoutes"), {
    prefix: "/api/classes",
  });

  fastify.register(require("./routes/schoolRoutes"), {
    prefix: "/api/schools",
  });

  fastify.register(require("./routes/schoolBookRequirementRoutes"), {
    prefix: "/api/requirements",
  });

  // ✅ Products (BOOK + MATERIAL)
  fastify.register(require("./routes/products"), { prefix: "/api/products" });

  /* ---------------- ORDERS ---------------- */
  fastify.register(require("./routes/publisherOrderRoutes"), {
    prefix: "/api/publisher-orders",
  });

  fastify.register(require("./routes/schoolOrderRoutes"), {
    prefix: "/api/school-orders",
  });

  /* ---------------- REPORTS ---------------- */
  fastify.register(require("./routes/reportRoutes"), {
    prefix: "/api/reports",
  });

  /* ---------------- MODULE-2 ---------------- */
  fastify.register(require("./routes/bundleRoutes"), {
    prefix: "/api/bundles",
  });

  fastify.register(require("./routes/distributorRoutes"), {
    prefix: "/api/distributors",
  });

  fastify.register(require("./routes/bundleIssueRoutes"), {
    prefix: "/api/bundle-issues",
  });

  fastify.register(require("./routes/bundleDispatchRoutes"), {
    prefix: "/api/bundle-dispatches",
  });

  /* ======================
     ✅ SALES (NEW)
     ====================== */
  fastify.register(require("./routes/saleRoutes"), {
    prefix: "/api/sales",
  });

  /* ======================
     ✅ SALES ANALYTICS (NEW)
     ====================== */
  // ✅ Admin-only routes: distributor->school summary, item totals, sales drilldown, credit outstanding
  fastify.register(require("./routes/salesAnalyticsRoutes"), {
    prefix: "/api/sales-analytics",
  });

  /* ---------------- STOCK & PROFILE ---------------- */
  fastify.register(require("./routes/stockRoutes"), { prefix: "/api/stock" });
  fastify.register(require("./routes/companyProfileRoutes"), { prefix: "/api" });

  /* ---------------- ERROR HANDLERS ---------------- */
  fastify.setErrorHandler((err, request, reply) => {
    request.log.error(err);
    reply.code(err.statusCode || 500).send({
      error: err.name || "Error",
      message: err.message || "Something went wrong",
    });
  });

  fastify.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      error: "Not Found",
      path: request.raw.url,
      message: "The requested route does not exist.",
    })
  );

  return fastify;
};

/* ---------------- START SERVER ---------------- */
const start = async () => {
  const fastify = buildServer();

  try {
    await sequelize.authenticate();
    fastify.log.info("✅ Database connected");

    await sequelize.sync();
    fastify.log.info(`✅ Models synced (env=${NODE_ENV}, alter=false)`);

    await fastify.listen({ port: config.port, host: "0.0.0.0" });
    fastify.log.info(`🚀 Server running on port ${config.port}`);
  } catch (err) {
    console.error("Startup Error:", err);
    process.exit(1);
  }
};

start();

module.exports = { buildServer };
