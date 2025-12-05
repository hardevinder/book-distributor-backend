// src/routes/publisherOrderRoutes.js

const publisherOrderController = require("../controllers/publisherOrderController");

async function publisherOrderRoutes(fastify, opts) {
  // Enable auth if needed:
  // const auth = fastify.authenticate || ((req, reply, done) => done());

  /* ----------------------------------------------------------
   *  GET /api/publisher-orders
   *  (Used by frontend table + View button)
   * ---------------------------------------------------------- */
  fastify.get(
    "/",
    {
      // preHandler: auth,
    },
    publisherOrderController.listPublisherOrders
  );

  /* ----------------------------------------------------------
   *  POST /api/publisher-orders/generate
   *  Generate orders from confirmed school requirements
   * ---------------------------------------------------------- */
  fastify.post(
    "/generate",
    {
      // preHandler: auth,
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
   *  Update received quantities + order status
   * ---------------------------------------------------------- */
  fastify.post(
    "/:orderId/receive",
    {
      // preHandler: auth,
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
   *  Create a new PO for pending quantity of this order
   * ---------------------------------------------------------- */
  fastify.post(
    "/:orderId/reorder-pending",
    {
      // preHandler: auth,
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
   *  Send this specific PO email
   * ---------------------------------------------------------- */
  fastify.post(
    "/:orderId/send-email",
    {
      // preHandler: auth,
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
