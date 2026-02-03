// src/routes/schoolOrders.js
"use strict";

const schoolOrderController = require("../controllers/schoolOrderController");
const availabilityController = require("../controllers/availabilityController");
const requireRoles = require("../middlewares/requireRoles");
const { SUPERADMIN_ONLY } = require("../constants/roles");

module.exports = async function (fastify, opts) {
  // 🔐 JWT auth for all routes
  fastify.addHook("onRequest", fastify.authenticate);

  // 🔓 READ access: superadmin + distributor
  const READ = { preHandler: [requireRoles("superadmin", "distributor")] };

  // 🔒 WRITE access: superadmin only
  const WRITE = { preHandler: [requireRoles(...SUPERADMIN_ONLY)] };

  // ======================================================
  // ✅ STATIC ROUTES FIRST
  // ======================================================

  // READ
  fastify.get("/", READ, schoolOrderController.listSchoolOrders);
  fastify.get("/availability", READ, availabilityController.schoolAvailability);
  fastify.get("/pdf/all", READ, schoolOrderController.printAllOrdersPdf);
  fastify.get(
    "/pdf/supplier-order-index",
    READ,
    schoolOrderController.printSupplierOrderIndexPdf
  );
  fastify.get("/email-logs", READ, schoolOrderController.getAllOrderEmailLogs);

  // WRITE
  fastify.post("/generate", WRITE, schoolOrderController.generateOrdersForSession);
  fastify.post(
    "/sync-from-requirements",
    WRITE,
    schoolOrderController.syncOrderFromRequirements
  );
  fastify.post(
    "/sync-school-session",
    WRITE,
    schoolOrderController.syncSchoolSessionFromRequirements
  );

  // ======================================================
  // ✅ PARAM ROUTES
  // ======================================================

  // READ
  fastify.get(
    "/:orderId/email-preview",
    READ,
    schoolOrderController.getOrderEmailPreview
  );
  fastify.get(
    "/:orderId/email-logs",
    READ,
    schoolOrderController.getOrderEmailLogs
  );
  fastify.get("/:orderId/pdf", READ, schoolOrderController.printOrderPdf);

  // WRITE
  fastify.delete("/:orderId", WRITE, schoolOrderController.deleteSchoolOrder);
  fastify.post(
    "/:orderId/send-email",
    WRITE,
    schoolOrderController.sendOrderEmailForOrder
  );
  fastify.patch(
    "/:orderId/meta",
    WRITE,
    schoolOrderController.updateSchoolOrderMeta
  );
  fastify.patch(
    "/:orderId/order-no",
    WRITE,
    schoolOrderController.updateSchoolOrderNo
  );
  fastify.patch(
    "/:orderId/items",
    WRITE,
    schoolOrderController.updateSchoolOrderItems
  );
  fastify.post(
    "/:orderId/receive",
    WRITE,
    schoolOrderController.receiveOrderItems
  );
  fastify.post(
    "/:orderId/reorder-copy",
    WRITE,
    schoolOrderController.reorderCopyWithEdit
  );
  fastify.post(
    "/:orderId/reorder",
    WRITE,
    schoolOrderController.reorderPendingForOrder
  );
  fastify.post(
    "/:orderId/reorder-pending",
    WRITE,
    schoolOrderController.reorderPendingForOrder
  );
};
