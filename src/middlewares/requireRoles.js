"use strict";

module.exports = (...allowedRoles) => {
  const allowed = allowedRoles.map((r) => String(r).toLowerCase());

  return async (request, reply) => {
    const role = String(request.user?.role || "").toLowerCase();

    if (!role) {
      reply.code(401);
      return reply.send({ message: "Unauthorized" });
    }

    if (!allowed.includes(role)) {
      reply.code(403);
      return reply.send({ message: "Forbidden" });
    }
  };
};
