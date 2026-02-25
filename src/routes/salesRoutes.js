"use strict";
const router = require("express").Router();
const auth = require("../middleware/auth");
const c = require("../controllers/salesInvoiceEmailController");

// ✅ global first
router.get("/email-logs", auth, c.getGlobalInvoiceEmailLogs);

router.get("/:invoiceId/email-preview", auth, c.getEmailPreview);
router.post("/:invoiceId/send-email", auth, c.sendInvoiceEmail);
router.get("/:invoiceId/email-logs", auth, c.getInvoiceEmailLogs);

module.exports = router;