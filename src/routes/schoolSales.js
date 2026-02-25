"use strict";

const schoolSalesController = require("../controllers/schoolSalesController");

/**
 * School Sales Routes
 * Mounted at: /api/school-sales
 *
 * ⚠️ ORDER MATTERS:
 * Static routes BEFORE param routes (/:id)
 */
module.exports = async function schoolSalesRoutes(fastify) {
  const auth = fastify.authenticate ? [fastify.authenticate] : [];

  // ---------- Safe handler picker (never crash) ----------
  const pick = (...fns) =>
    fns.find((fn) => typeof fn === "function") ||
    (async (req, reply) => reply.code(501).send({ message: "Handler not implemented" }));

  /* =========================
     ✅ UI Helpers (STATIC)
     ========================= */

  // Grouping options (UI helper)
  // Frontend expects: res.data.options OR res.data (array)
  fastify.get(
    "/grouping-options",
    { preHandler: auth },
    pick(
      schoolSalesController.groupingOptions,
      schoolSalesController.getGroupingOptions,
      async (req, reply) =>
        reply.send({
          success: true,
          options: [
            { value: "NONE", label: "Single Invoice" },
            { value: "CLASS", label: "Class-wise Invoices" },
            { value: "PUBLISHER", label: "Publisher-wise Invoices" },
          ],
        })
    )
  );

  /* =========================
     ✅ Requirements → Sales (STATIC)
     ========================= */

  // Preview invoices to be created (no DB write)
  fastify.post(
    "/from-requirements/preview",
    { preHandler: auth },
    pick(schoolSalesController.previewFromRequirements)
  );

  // Create invoices from requirements
  fastify.post(
    "/from-requirements",
    { preHandler: auth },
    pick(schoolSalesController.createFromRequirements)
  );

  /* =========================
     ✅ PDF routes (STATIC FIRST)
     ========================= */

  // Bulk PDF (static) - MUST be before "/:id"
  fastify.get(
    "/pdf/all",
    { preHandler: auth },
    pick(schoolSalesController.printAllSalesPdf)
  );

  /* =========================
     ✅ EMAIL routes (STATIC FIRST)
     ========================= */

  // Global email logs (static) - MUST be before "/:id"
  fastify.get(
    "/email-logs",
    { preHandler: auth },
    pick(schoolSalesController.getAllSaleEmailLogs)
  );

  /* =========================
     ✅ List (STATIC)
     ========================= */

  fastify.get(
    "/",
    { preHandler: auth },
    pick(schoolSalesController.list)
  );

  /* =========================
     ✅ Param routes (MORE SPECIFIC FIRST)
     ========================= */

  // Print single invoice PDF
  fastify.get(
    "/:id/pdf",
    { preHandler: auth },
    pick(schoolSalesController.printSalePdf)
  );

  // Email preview (subject/html/to/cc)
  fastify.get(
    "/:id/email-preview",
    { preHandler: auth },
    pick(schoolSalesController.getSaleEmailPreview)
  );

  // Send email with PDF attachment
  fastify.post(
    "/:id/send-email",
    { preHandler: auth },
    pick(schoolSalesController.sendSaleInvoiceEmail)
  );

  // Email logs for one invoice
  fastify.get(
    "/:id/email-logs",
    { preHandler: auth },
    pick(schoolSalesController.getSaleEmailLogs)
  );

  // Cancel sale (more specific than "/:id")
  fastify.post(
    "/:id/cancel",
    { preHandler: auth },
    pick(schoolSalesController.cancel)
  );

  // ✅ Update sale (PUT) — used by frontend Save Edit
  fastify.put(
    "/:id",
    { preHandler: auth },
    pick(schoolSalesController.updateSale)
  );

  // Get One (param last)
  fastify.get(
    "/:id",
    { preHandler: auth },
    pick(schoolSalesController.getOne)
  );
};