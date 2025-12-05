// src/server.js
const fastifyFactory = require("fastify");
const cors = require("@fastify/cors");
const jwt = require("@fastify/jwt");
const multipart = require("@fastify/multipart");
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
              options: {
                colorize: true,
                translateTime: "HH:MM:ss",
              },
            }
          : undefined,
    },
  });

  /* ---------------- CORS (FULL FIXED) ---------------- */
  fastify.register(cors, {
    origin: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    exposedHeaders: ["Content-Type"],
    credentials: true,
    preflightContinue: false,
    optionsSuccessStatus: 204,
  });

  /* -------------- Multipart (for file uploads) -------------- */
  fastify.register(multipart, {
    limits: {
      fileSize: 5 * 1024 * 1024, // 5 MB
    },
  });

  /* ---------------- JWT ---------------- */
  fastify.register(jwt, {
    secret: config.jwt.secret,
  });

  fastify.decorate("authenticate", async function (request, reply) {
    try {
      await request.jwtVerify();
    } catch (err) {
      request.log.error({ err }, "JWT verification failed");
      return reply.code(401).send({ error: "Unauthorized" });
    }
  });

  /* ---------------- Basic Routes ---------------- */
  fastify.get("/", async () => ({
    status: "ok",
    service: "books-distribution-api",
    message: "Books Distribution API is running",
  }));

  fastify.get("/api/health", async () => ({
    status: "ok",
    service: "books-distribution-api",
  }));

  /* ---------------- Register Routes ---------------- */

  // 🔐 Auth routes
  fastify.register(require("./routes/authRoutes"), {
    prefix: "/api/auth",
  });

  // 📚 Books
  fastify.register(require("./routes/bookRoutes"), {
    prefix: "/api/books",
  });

  // 🏢 Publishers
  fastify.register(require("./routes/publisherRoutes"), {
    prefix: "/api/publishers",
  });

  // 🎓 Classes
  fastify.register(require("./routes/classRoutes"), {
    prefix: "/api/classes",
  });

  // 🏫 Schools
  fastify.register(require("./routes/schoolRoutes"), {
    prefix: "/api/schools",
  });

  // 📦 School Book Requirements
  fastify.register(require("./routes/schoolBookRequirementRoutes"), {
    prefix: "/api/requirements",
  });

  // 🧾 Publisher Orders (generate + list + receive + email)
  fastify.register(require("./routes/publisherOrderRoutes"), {
    prefix: "/api/publisher-orders",
  });

  // 📊 Stock / Inventory (book-wise summary)
  fastify.register(require("./routes/stockRoutes"), {
    prefix: "/api/stock",
  });

  /* ---------------- Error & 404 Handlers ---------------- */
  fastify.setErrorHandler((err, request, reply) => {
    request.log.error({ err }, "Unhandled error");

    const statusCode = err.statusCode || 500;
    reply.code(statusCode).send({
      error: err.name || "Error",
      message: err.message || "Something went wrong",
    });
  });

  fastify.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      error: "Not Found",
      path: request.raw.url,
      message: "The requested route does not exist.",
    });
  });

  return fastify;
};

const start = async () => {
  const fastify = buildServer();

  try {
    await sequelize.authenticate();
    fastify.log.info("✅ Database connected");

    // 👉 Normal safe sync (no alter)
    await sequelize.sync();
    fastify.log.info("✅ Models synced");

    await fastify.listen({
      port: config.port,
      host: "0.0.0.0",
    });

    fastify.log.info(`🚀 Server running on port ${config.port}`);
  } catch (err) {
    console.error("Startup Error:", err);
    process.exit(1);
  }

  const shutdown = async (signal) => {
    fastify.log.info(`${signal} received. Shutting down...`);
    try {
      await fastify.close();
      await sequelize.close();
      fastify.log.info("🛑 Server closed gracefully");
      process.exit(0);
    } catch (err) {
      console.error("Error during shutdown:", err);
      process.exit(1);
    }
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
};

start();

module.exports = { buildServer };
