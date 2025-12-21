// src/server.js
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

const buildServer = () => {
  const fastify = fastifyFactory({
    logger: {
      level: "info",
      transport:
        process.env.NODE_ENV === "development"
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
    limits: { fileSize: 25 * 1024 * 1024 }, // ✅ 25MB (logos/pdfs etc)
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

  /* ----------------------------------------------------------
     LOGO UPLOAD ROUTE
     URL: POST /api/company-profile/logo-upload
     Saves files → /uploads/company-logos/<filename>
  ---------------------------------------------------------- */
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

  /* ---------------- REGISTER OTHER ROUTES ---------------- */
  fastify.register(require("./routes/authRoutes"), { prefix: "/api/auth" });
  fastify.register(require("./routes/bookRoutes"), { prefix: "/api/books" });

  // Publishers CRUD (independent)
  fastify.register(require("./routes/publisherRoutes"), {
    prefix: "/api/publishers",
  });

  // ✅ Suppliers CRUD
  fastify.register(require("./routes/supplierRoutes"), {
    prefix: "/api/suppliers",
  });

  fastify.register(require("./routes/transportRoutes"), {
    prefix: "/api/transports",
  });

  fastify.register(require("./routes/classRoutes"), { prefix: "/api/classes" });

  fastify.register(require("./routes/schoolRoutes"), {
    prefix: "/api/schools",
  });

  fastify.register(require("./routes/schoolBookRequirementRoutes"), {
    prefix: "/api/requirements",
  });

  fastify.register(require("./routes/publisherOrderRoutes"), {
    prefix: "/api/publisher-orders",
  });

  fastify.register(require("./routes/schoolOrderRoutes"), {
    prefix: "/api/school-orders",
  });

  // ✅ Step-2 Bundles/Kits (Reserve / Unreserve / List)
  fastify.register(require("./routes/bundleRoutes"), {
    prefix: "/api/bundles",
  });

  // ✅ NEW: Distributors
  // routes: GET/POST/PUT/DELETE under /api/distributors
  fastify.register(require("./routes/distributorRoutes"), {
    prefix: "/api/distributors",
  });

  // ✅ NEW: Bundle Issue (Issue to School/Distributor) + list issues
  // routes:
  // POST /api/bundle-issues/bundles/:id/issue
  // GET  /api/bundle-issues/bundles/:id/issues
  fastify.register(require("./routes/bundleIssueRoutes"), {
    prefix: "/api/bundle-issues",
  });

  // ✅ NEW: Bundle Dispatch (dispatch + delivered)
  // routes:
  // POST /api/bundle-dispatches
  // PATCH /api/bundle-dispatches/:id/status
  fastify.register(require("./routes/bundleDispatchRoutes"), {
    prefix: "/api/bundle-dispatches",
  });

  fastify.register(require("./routes/stockRoutes"), { prefix: "/api/stock" });

  fastify.register(require("./routes/companyProfileRoutes"), {
    prefix: "/api",
  });

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

    // ✅ safer sync: do NOT alter prod tables accidentally
    // In dev you can do ALTER via migrations / manual SQL (recommended)
    const isProd = process.env.NODE_ENV === "production";
    await sequelize.sync({ alter: !isProd });
    fastify.log.info(`✅ Models synced (alter=${!isProd})`);

    await fastify.listen({ port: config.port, host: "0.0.0.0" });
    fastify.log.info(`🚀 Server running on port ${config.port}`);
  } catch (err) {
    console.error("Startup Error:", err);
    process.exit(1);
  }
};

start();

module.exports = { buildServer };
