"use strict";

const productController = require("../controllers/productController");

module.exports = async function (fastify, opts) {
  // 🔐 protect all product routes
  fastify.addHook("onRequest", fastify.authenticate);

  // GET /api/products
  fastify.get("/", productController.listProducts);

  // GET /api/products/:id
  fastify.get("/:id", productController.getProductById);

  // POST /api/products
  fastify.post("/", productController.createProduct);

  // PUT /api/products/:id
  fastify.put("/:id", productController.updateProduct);

  // DELETE /api/products/:id
  fastify.delete("/:id", productController.deleteProduct);
};
