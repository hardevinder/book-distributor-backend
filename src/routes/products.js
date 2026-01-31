"use strict";

const productController = require("../controllers/productController");

module.exports = async function (fastify, opts) {
  // 🔐 protect all product routes
  fastify.addHook("onRequest", fastify.authenticate);

  // ======================================================
  // PRODUCTS
  // ======================================================

  // GET /api/products
  // supports:
  // ?type=BOOK|MATERIAL
  // ?include_book=1
  // ?q=search
  // ?ensure_books=1   <-- ✅ auto-create BOOK products from Books
  fastify.get("/", productController.listProducts);

  // 🔥 OPTIONAL ADMIN / FIX ROUTE
  // POST /api/products/ensure-books
  // creates BOOK products for all books (one-time / safe)
  fastify.post("/ensure-books", productController.ensureBooks);

  // GET /api/products/:id
  fastify.get("/:id", productController.getProductById);

  // POST /api/products
  fastify.post("/", productController.createProduct);

  // PUT /api/products/:id
  fastify.put("/:id", productController.updateProduct);

  // DELETE /api/products/:id
  fastify.delete("/:id", productController.deleteProduct);
};
