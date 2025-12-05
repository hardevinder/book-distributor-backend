// src/controllers/stockController.js
const { Op, fn, col } = require("sequelize");
const {
  PublisherOrderItem,
  PublisherOrder,
  Book,
  Publisher,
} = require("../models");

/**
 * GET /api/stock/summary
 *
 * Returns aggregated book-wise stock based on Publisher Orders & Receive.
 * - total_ordered_qty: SUM of total_order_qty (non-cancelled orders)
 * - total_received_qty: SUM of received_qty (non-cancelled orders)
 * - current_stock: for now = total_received_qty (you can later subtract issues)
 */
exports.getStockSummary = async (request, reply) => {
  try {
    const rows = await PublisherOrderItem.findAll({
      include: [
        // ✅ Book is associated with alias "book"
        {
          model: Book,
          as: "book",
          attributes: [],
          include: [
            {
              model: Publisher,
              as: "publisher", // Book.belongsTo(Publisher, { as: "publisher" })
              attributes: [],
            },
          ],
        },
        // ✅ PublisherOrder is associated with alias "order"
        {
          model: PublisherOrder,
          as: "order",
          required: true,
          attributes: [],
          where: {
            status: {
              [Op.ne]: "cancelled",
            },
          },
        },
      ],
      attributes: [
        "book_id",
        [col("book.title"), "title"],
        [col("book.class_name"), "class_name"],
        [col("book.subject"), "subject"],
        [col("book.code"), "code"],
        [col("book.isbn"), "isbn"],
        [col("book->publisher.name"), "publisher_name"],
        [
          fn("SUM", col("PublisherOrderItem.total_order_qty")),
          "total_ordered_qty",
        ],
        [
          fn(
            "SUM",
            fn("COALESCE", col("PublisherOrderItem.received_qty"), 0)
          ),
          "total_received_qty",
        ],
      ],
      group: [
        "PublisherOrderItem.book_id",
        "book.id",
        "book.title",
        "book.class_name",
        "book.subject",
        "book.code",
        "book.isbn",
        "book->publisher.id",
        "book->publisher.name",
      ],
      order: [[col("book.title"), "ASC"]],
      raw: true,
    });

    const data = rows.map((r) => {
      const ordered = Number(r.total_ordered_qty || 0);
      const received = Number(r.total_received_qty || 0);
      const currentStock = received; // future: subtract issues / sales

      return {
        book_id: r.book_id,
        title: r.title,
        class_name: r.class_name,
        subject: r.subject,
        code: r.code,
        isbn: r.isbn,
        publisher_name: r.publisher_name,
        total_ordered_qty: ordered,
        total_received_qty: received,
        current_stock: currentStock,
      };
    });

    return reply.code(200).send(data);
  } catch (err) {
    request.log.error({ err }, "Error in getStockSummary");
    return reply.code(500).send({
      message: "Failed to load stock summary.",
      error: err.message || String(err),
    });
  }
};
