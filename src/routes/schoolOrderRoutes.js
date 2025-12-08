// src/routes/schoolOrderRoutes.js

const schoolOrderController = require("../controllers/schoolOrderController");

module.exports = async function (fastify, opts) {
  // 🔐 Protect all school-order routes with JWT auth
  fastify.addHook("onRequest", fastify.authenticate);

  // GET /api/school-orders
  fastify.get("/", schoolOrderController.listSchoolOrders);

  // POST /api/school-orders/generate
  fastify.post("/generate", schoolOrderController.generateOrdersForSession);

  // POST /api/school-orders/:orderId/receive
  fastify.post(
    "/:orderId/receive",
    schoolOrderController.receiveOrderItems
  );

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

  // 🆕 GET /api/school-orders/:orderId/pdf  → single order PDF
  fastify.get(
    "/:orderId/pdf",
    schoolOrderController.printOrderPdf
  );
};
