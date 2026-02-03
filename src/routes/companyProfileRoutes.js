// src/routes/companyProfileRoutes.js
"use strict";

const companyProfileController = require("../controllers/companyProfileController");
const requireRoles = require("../middlewares/requireRoles");
const { SUPERADMIN_ONLY } = require("../constants/roles");

async function companyProfileRoutes(fastify) {
  // 🔐 JWT auth for all routes
  fastify.addHook("onRequest", fastify.authenticate);

  // 🔒 SUPERADMIN only
  fastify.addHook("preHandler", requireRoles(...SUPERADMIN_ONLY));

  // ------------------------------------------------------
  // List all company profiles
  // GET /company-profiles
  // ------------------------------------------------------
  fastify.get(
    "/company-profiles",
    companyProfileController.getCompanyProfiles
  );

  // ------------------------------------------------------
  // Get a single profile
  // GET /company-profiles/:id
  // ------------------------------------------------------
  fastify.get(
    "/company-profiles/:id",
    companyProfileController.getCompanyProfileById
  );

  // ------------------------------------------------------
  // Create new profile
  // POST /company-profiles
  // ------------------------------------------------------
  fastify.post(
    "/company-profiles",
    companyProfileController.createCompanyProfile
  );

  // ------------------------------------------------------
  // Update existing profile
  // PUT /company-profiles/:id
  // ------------------------------------------------------
  fastify.put(
    "/company-profiles/:id",
    companyProfileController.updateCompanyProfile
  );

  // ------------------------------------------------------
  // Toggle active / inactive
  // PATCH /company-profiles/:id/toggle
  // ------------------------------------------------------
  fastify.patch(
    "/company-profiles/:id/toggle",
    companyProfileController.toggleCompanyProfileActive
  );

  // ------------------------------------------------------
  // Get default profile (used in PO / Invoice header)
  // GET /company-profile/default
  // ------------------------------------------------------
  fastify.get(
    "/company-profile/default",
    companyProfileController.getDefaultCompanyProfile
  );

  // ❌ Logo upload intentionally NOT here (handled in server.js)
}

module.exports = companyProfileRoutes;
