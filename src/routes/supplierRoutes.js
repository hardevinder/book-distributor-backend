// src/routes/supplierRoutes.js
const supplierController = require("../controllers/supplierController");

async function supplierRoutes(fastify) {
  // Helpers: small role check (based on your JWT payload)
  const requireRoles = (roles) => async (request, reply) => {
    // ensure authenticated
    await fastify.authenticate(request, reply);

    const role =
      request.user?.role ||
      request.user?.data?.role ||
      request.user?.user?.role;

    if (!role || !roles.includes(String(role).toLowerCase())) {
      return reply.code(403).send({ error: "Forbidden" });
    }
  };

  // Everyone logged-in can read
  fastify.get("/", { preHandler: [fastify.authenticate] }, supplierController.list);
  fastify.get("/:id", { preHandler: [fastify.authenticate] }, supplierController.getById);

  // Only admin/superadmin can write
  fastify.post(
    "/",
    { preHandler: [requireRoles(["admin", "superadmin"])] },
    supplierController.create
  );

  fastify.put(
    "/:id",
    { preHandler: [requireRoles(["admin", "superadmin"])] },
    supplierController.update
  );

  fastify.delete(
    "/:id",
    { preHandler: [requireRoles(["admin", "superadmin"])] },
    supplierController.remove
  );
}

module.exports = supplierRoutes;
