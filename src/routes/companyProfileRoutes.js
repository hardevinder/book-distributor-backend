// src/routes/companyProfileRoutes.js

const companyProfileController = require("../controllers/companyProfileController");

async function companyProfileRoutes(fastify) {
  // List all company profiles
  fastify.get(
    "/company-profiles",
    companyProfileController.getCompanyProfiles
  );

  // Get a single profile
  fastify.get(
    "/company-profiles/:id",
    companyProfileController.getCompanyProfileById
  );

  // Create new profile
  fastify.post(
    "/company-profiles",
    companyProfileController.createCompanyProfile
  );

  // Update existing profile
  fastify.put(
    "/company-profiles/:id",
    companyProfileController.updateCompanyProfile
  );

  // Toggle active/inactive
  fastify.patch(
    "/company-profiles/:id/toggle",
    companyProfileController.toggleCompanyProfileActive
  );

  // Get default profile (used in PO/Invoice header)
  fastify.get(
    "/company-profile/default",
    companyProfileController.getDefaultCompanyProfile
  );

  // ❌ REMOVE THIS — upload is now in server.js
  // Do NOT include: fastify.post("/company-profile/logo-upload", ...)
}

module.exports = companyProfileRoutes;
