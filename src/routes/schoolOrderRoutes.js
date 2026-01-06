// src/routes/schoolOrders.js  (or routes/schoolOrders.js)
"use strict";

const schoolOrderController = require("../controllers/schoolOrderController");
const availabilityController = require("../controllers/availabilityController");

module.exports = async function (fastify, opts) {
  // 🔐 Protect all school-order routes with JWT auth
  fastify.addHook("onRequest", fastify.authenticate);

  // ======================================================
  // ✅ STATIC ROUTES FIRST (avoid conflict with /:orderId)
  // ======================================================

  // GET /api/school-orders
  fastify.get("/", schoolOrderController.listSchoolOrders);

  // POST /api/school-orders/generate
  fastify.post("/generate", schoolOrderController.generateOrdersForSession);

  /**
   * ✅ School → Class → Book availability
   * GET /api/school-orders/availability?schoolId=&academic_session=
   */
  fastify.get("/availability", availabilityController.schoolAvailability);

  /**
   * ✅ Bulk PDF: Print ALL orders in ONE PDF (each order on new page)
   * GET /api/school-orders/pdf/all?academic_session=&school_id=&supplier_id=&status=&order_type=&view=SUPPLIER|INTERNAL&inline=1
   */
  fastify.get("/pdf/all", schoolOrderController.printAllOrdersPdf);

  /**
   * ✅ NEW PDF: Supplier + Order No Index (2 columns only)
   * GET /api/school-orders/pdf/supplier-order-index?academic_session=&school_id=&supplier_id=&status=&order_type=&inline=1
   */
  fastify.get(
    "/pdf/supplier-order-index",
    schoolOrderController.printSupplierOrderIndexPdf
  );

  // ======================================================
  // ✅ PARAM ROUTES (Grouped)
  // ======================================================

  // ---------- Email helpers for modal ----------
  // GET /api/school-orders/:orderId/email-preview
  fastify.get("/:orderId/email-preview", schoolOrderController.getOrderEmailPreview);

  // GET /api/school-orders/:orderId/email-logs?limit=20
  fastify.get("/:orderId/email-logs", schoolOrderController.getOrderEmailLogs);

  // POST /api/school-orders/:orderId/send-email
  fastify.post("/:orderId/send-email", schoolOrderController.sendOrderEmailForOrder);

  // ---------- Meta / order no ----------
  // PATCH /api/school-orders/:orderId/meta
  fastify.patch("/:orderId/meta", schoolOrderController.updateSchoolOrderMeta);

  // PATCH /api/school-orders/:orderId/order-no
  fastify.patch("/:orderId/order-no", schoolOrderController.updateSchoolOrderNo);

  // ---------- Receive ----------
  // POST /api/school-orders/:orderId/receive
  fastify.post("/:orderId/receive", schoolOrderController.receiveOrderItems);

  // ======================================================
  // ✅ RE-ORDER ROUTES (IMPORTANT)
  // ======================================================

  /**
   * ✅ Copy reorder with manual qty
   * (does NOT touch old order, does NOT change pending)
   * POST /api/school-orders/:orderId/reorder-copy
   * body: { items: [{ item_id, total_order_qty }] }
   */
  fastify.post("/:orderId/reorder-copy", schoolOrderController.reorderCopyWithEdit);

  // ✅ Alias (frontend calling /reorder)
  // POST /api/school-orders/:orderId/reorder
  fastify.post("/:orderId/reorder", schoolOrderController.reorderPendingForOrder);

  // ✅ Canonical route (pending-only, shifts reordered_qty)
  // POST /api/school-orders/:orderId/reorder-pending
  fastify.post("/:orderId/reorder-pending", schoolOrderController.reorderPendingForOrder);

  // ======================================================
  // OTHER ACTION ROUTES
  // ======================================================

  // GET /api/school-orders/:orderId/pdf
  fastify.get("/:orderId/pdf", schoolOrderController.printOrderPdf);

  /**
   * ✅ OPTIONAL (future use)
   * GET /api/school-orders/:orderId/receipt-pdf
   *
   * fastify.get(
   *   "/:orderId/receipt-pdf",
   *   schoolOrderController.printSupplierReceiptPdf
   * );
   */
};
