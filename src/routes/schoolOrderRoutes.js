// src/routes/schoolOrderRoutes.js
"use strict";

const schoolOrderController = require("../controllers/schoolOrderController");
const availabilityController = require("../controllers/availabilityController");

module.exports = async function (fastify, opts) {
  // 🔐 Protect all school-order routes with JWT auth
  fastify.addHook("onRequest", fastify.authenticate);

  // ✅ STATIC ROUTES FIRST (avoid conflict with /:orderId)

  // GET /api/school-orders
  fastify.get("/", schoolOrderController.listSchoolOrders);

  // POST /api/school-orders/generate
  fastify.post("/generate", schoolOrderController.generateOrdersForSession);

  /**
   * ✅ School → Class → Book availability
   * GET /api/school-orders/availability?schoolId=&academic_session=
   */
  fastify.get("/availability", availabilityController.schoolAvailability);

  // ----------------------------
  // PARAM ROUTES AFTER THIS
  // ----------------------------

  // PATCH /api/school-orders/:orderId/meta
  fastify.patch("/:orderId/meta", schoolOrderController.updateSchoolOrderMeta);

  // PATCH /api/school-orders/:orderId/order-no
  fastify.patch("/:orderId/order-no", schoolOrderController.updateSchoolOrderNo);

  // POST /api/school-orders/:orderId/receive
  fastify.post("/:orderId/receive", schoolOrderController.receiveOrderItems);

  // POST /api/school-orders/:orderId/reorder-pending
  fastify.post(
    "/:orderId/reorder-pending",
    schoolOrderController.reorderPendingForOrder
  );

  // POST /api/school-orders/:orderId/send-email
  fastify.post(
    "/:orderId/send-email",
    schoolOrderController.sendOrderEmailForOrder
  );

  // GET /api/school-orders/:orderId/pdf
  fastify.get("/:orderId/pdf", schoolOrderController.printOrderPdf);

  /**
   * ✅ OPTIONAL (if you later add receipt PDF endpoint in schoolOrderController)
   * fastify.get("/:orderId/receipt-pdf", schoolOrderController.printSupplierReceiptPdf);
   */
};
