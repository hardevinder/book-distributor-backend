// src/routes/salesAnalyticsRoutes.js
"use strict";

const salesAnalyticsController = require("../controllers/salesAnalyticsController");
const requireRoles = require("../middlewares/requireRoles");

// ✅ Your User.role enum: superadmin, distributor, school, staff
// ✅ Analytics is for admin-side => superadmin + staff
const ADMINISH_ROLES = ["superadmin", "staff"]; // add more only if your DB has them

module.exports = async function (fastify, opts) {
  // 🔐 JWT auth for all analytics routes
  fastify.addHook("onRequest", fastify.authenticate);

  // 🔒 Adminish only
  fastify.addHook("preHandler", requireRoles(...ADMINISH_ROLES));

  // ======================================================
  // ✅ STATIC ROUTES FIRST (no /:id here but keep consistent)
  // ======================================================

  // SUMMARY (Distributor -> School)
  fastify.get(
    "/distributor-school-summary",
    salesAnalyticsController.distributorSchoolSummary
  );

  // ITEMS (Distributor -> School -> Item aggregation)
  fastify.get(
    "/distributor-school-items",
    salesAnalyticsController.distributorSchoolItems
  );

  // SALES DRILLDOWN (invoice list + credit person details)
  fastify.get(
    "/distributor-school-sales",
    salesAnalyticsController.distributorSchoolSales
  );

  // CREDIT OUTSTANDING (student/parent wise)
  fastify.get(
    "/credit-outstanding",
    salesAnalyticsController.creditOutstanding
  );
};
