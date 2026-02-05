// src/routes/authRoutes.js
"use strict";

const bcrypt = require("bcryptjs");
const { User } = require("../models");

const safeText = (v) => String(v ?? "").trim();

module.exports = async function (fastify, opts) {
  const auth = fastify.authenticate ? [fastify.authenticate] : [];

  // REGISTER (for development)
  fastify.post("/register", async (request, reply) => {
    try {
      const { name, email, phone, password, role, distributor_id } = request.body || {};

      if (!name || !email || !password) {
        return reply.code(400).send({ error: "name, email and password are required" });
      }

      const existing = await User.findOne({ where: { email } });
      if (existing) {
        return reply.code(409).send({ error: "User already exists with this email" });
      }

      const password_hash = await bcrypt.hash(password, 10);

      const user = await User.create({
        name,
        email,
        phone,
        password_hash,
        role: role || "distributor",
        distributor_id: distributor_id || null,
        is_active: true,
      });

      const token = fastify.jwt.sign(
        {
          id: user.id,
          email: user.email,
          role: user.role,
          distributor_id: user.distributor_id || null,
        },
        { expiresIn: process.env.JWT_EXPIRES_IN || "1d" }
      );

      return reply.code(201).send({
        token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          distributor_id: user.distributor_id || null,
        },
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: "Registration failed" });
    }
  });

  // LOGIN
  fastify.post("/login", async (request, reply) => {
    try {
      const email = safeText(request.body?.email);
      const password = safeText(request.body?.password);

      if (!email || !password) {
        return reply.code(400).send({ error: "email and password are required" });
      }

      const user = await User.findOne({ where: { email } });
      if (!user) return reply.code(401).send({ error: "Invalid credentials" });

      // ✅ block inactive users
      if (user.is_active === false) {
        return reply.code(403).send({ error: "Your account is disabled. Please contact admin." });
      }

      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) return reply.code(401).send({ error: "Invalid credentials" });

      const token = fastify.jwt.sign(
        {
          id: user.id,
          email: user.email,
          role: user.role,
          distributor_id: user.distributor_id || null,
        },
        { expiresIn: process.env.JWT_EXPIRES_IN || "1d" }
      );

      user.last_login_at = new Date();
      await user.save();

      return reply.send({
        token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          distributor_id: user.distributor_id || null,
        },
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: "Login failed" });
    }
  });

  // PROTECTED: GET CURRENT USER
  fastify.get("/me", { preHandler: auth }, async (request, reply) => {
    const user = await User.findByPk(request.user.id, {
      attributes: ["id", "name", "email", "role", "distributor_id", "createdAt", "is_active"],
    });
    if (!user) return reply.code(404).send({ error: "User not found" });
    return reply.send(user);
  });

  // ✅ CHANGE PASSWORD (protected)
  fastify.post("/change-password", { preHandler: auth }, async (request, reply) => {
    try {
      const old_password = safeText(request.body?.old_password);
      const new_password = safeText(request.body?.new_password);
      const confirm_password = safeText(request.body?.confirm_password);

      if (!old_password || !new_password || !confirm_password) {
        return reply
          .code(400)
          .send({ error: "old_password, new_password, confirm_password are required" });
      }
      if (new_password !== confirm_password) {
        return reply.code(400).send({ error: "New password and confirm password do not match" });
      }
      if (new_password.length < 6) {
        return reply.code(400).send({ error: "Password must be at least 6 characters" });
      }

      const user = await User.findByPk(request.user.id);
      if (!user) return reply.code(404).send({ error: "User not found" });

      const ok = await bcrypt.compare(old_password, user.password_hash);
      if (!ok) return reply.code(400).send({ error: "Old password is incorrect" });

      user.password_hash = await bcrypt.hash(new_password, 10);
      await user.save();

      return reply.send({ message: "Password changed successfully" });
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: "Change password failed" });
    }
  });

  // ✅ LOGOUT (JWT stateless) - frontend just deletes token
  fastify.post("/logout", { preHandler: auth }, async (request, reply) => {
    return reply.send({ message: "Logged out. Please delete token on client." });
  });
};
