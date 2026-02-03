// src/routes/publisherOrderRoutes.js
"use strict";

const publisherOrderController = require("../controllers/publisherOrderController");
const requireRoles = require("../middlewares/requireRoles");
const { SUPERADMIN_ONLY } = require("../constants/roles");

async function publisherOrderRoutes(fastify, opts) {
  // 🔐 Auth for all routes
  fastify.addHook("onRequest", fastify.authenticate);

  // 🔒 SUPERADMIN only
  fastify.addHook("preHandler", requireRoles(...SUPERADMIN_ONLY));

  /* ----------------------------------------------------------
   *  GET /api/publisher-orders
   * ---------------------------------------------------------- */
  fastify.get("/", publisherOrderController.listPublisherOrders);

  /* ----------------------------------------------------------
   *  POST /api/publisher-orders/generate
   * ---------------------------------------------------------- */
  fastify.post(
    "/generate",
    {
      schema: {
        body: {
          type: "object",
          required: ["academic_session"],
          properties: {
            academic_session: { type: "string" },
          },
        },
      },
    },
    publisherOrderController.generateOrdersForSession
  );

  /* ----------------------------------------------------------
   *  POST /api/publisher-orders/:orderId/receive
   * ---------------------------------------------------------- */
  fastify.post(
    "/:orderId/receive",
    {
      schema: {
        params: {
          type: "object",
          required: ["orderId"],
          properties: {
            orderId: { type: "integer" },
          },
        },
        body: {
          type: "object",
          required: ["items"],
          properties: {
            status: {
              type: "string",
              enum: ["auto", "cancelled"],
            },
            items: {
              type: "array",
              items: {
                type: "object",
                required: ["item_id", "received_qty"],
                properties: {
                  item_id: { type: "integer" },
                  received_qty: { type: "number" },
                },
              },
            },
          },
        },
      },
    },
    publisherOrderController.receiveOrderItems
  );

  /* ----------------------------------------------------------
   *  POST /api/publisher-orders/:orderId/reorder-pending
   * ---------------------------------------------------------- */
  fastify.post(
    "/:orderId/reorder-pending",
    {
      schema: {
        params: {
          type: "object",
          required: ["orderId"],
          properties: {
            orderId: { type: "integer" },
          },
        },
      },
    },
    publisherOrderController.reorderPendingForOrder
  );

  /* ----------------------------------------------------------
   *  POST /api/publisher-orders/:orderId/send-email
   * ---------------------------------------------------------- */
  fastify.post(
    "/:orderId/send-email",
    {
      schema: {
        params: {
          type: "object",
          required: ["orderId"],
          properties: {
            orderId: { type: "integer" },
          },
        },
      },
    },
    publisherOrderController.sendOrderEmailForOrder
  );
}

module.exports = publisherOrderRoutes;
