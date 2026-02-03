// src/routes/authRoutes.js
"use strict";

const bcrypt = require("bcryptjs");
const { User } = require("../models");

module.exports = async function (fastify, opts) {
  // REGISTER (for development)
  fastify.post("/register", async (request, reply) => {
    try {
      const { name, email, phone, password, role, distributor_id } = request.body || {};

      if (!name || !email || !password) {
        reply.code(400);
        return { error: "name, email and password are required" };
      }

      const existing = await User.findOne({ where: { email } });
      if (existing) {
        reply.code(409);
        return { error: "User already exists with this email" };
      }

      const password_hash = await bcrypt.hash(password, 10);

      const user = await User.create({
        name,
        email,
        phone,
        password_hash,
        role: role || "distributor",
        // ✅ if you pass distributor_id during register (optional)
        distributor_id: distributor_id || null,
      });

      const token = fastify.jwt.sign(
        {
          id: user.id,
          email: user.email,
          role: user.role,
          // ✅ MUST include for distributor flows
          distributor_id: user.distributor_id || null,
        },
        {
          expiresIn: process.env.JWT_EXPIRES_IN || "1d",
        }
      );

      reply.code(201);
      return {
        token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          // ✅ return it too
          distributor_id: user.distributor_id || null,
        },
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: "Registration failed" });
    }
  });

  // LOGIN
  fastify.post("/login", async (request, reply) => {
    try {
      const { email, password } = request.body || {};

      if (!email || !password) {
        reply.code(400);
        return { error: "email and password are required" };
      }

      const user = await User.findOne({ where: { email } });
      if (!user) {
        reply.code(401);
        return { error: "Invalid credentials" };
      }

      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) {
        reply.code(401);
        return { error: "Invalid credentials" };
      }

      const token = fastify.jwt.sign(
        {
          id: user.id,
          email: user.email,
          role: user.role,
          // ✅ MUST include for distributor flows
          distributor_id: user.distributor_id || null,
        },
        {
          expiresIn: process.env.JWT_EXPIRES_IN || "1d",
        }
      );

      user.last_login_at = new Date();
      await user.save();

      return {
        token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          // ✅ return it too
          distributor_id: user.distributor_id || null,
        },
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: "Login failed" });
    }
  });

  // PROTECTED: GET CURRENT USER
  fastify.get("/me", { preHandler: [fastify.authenticate] }, async (request) => {
    const user = await User.findByPk(request.user.id, {
      attributes: ["id", "name", "email", "role", "distributor_id", "createdAt"],
    });

    return user;
  });
};
