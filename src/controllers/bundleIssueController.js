"use strict";

const { Op } = require("sequelize");

const {
  Bundle,
  BundleItem,
  BundleIssue,
  InventoryBatch,
  InventoryTxn,
  School,
  Distributor,
  Book,
  sequelize,
} = require("../models");

/* ---------------- Helpers ---------------- */

const TXN_TYPE = {
  IN: "IN",
  RESERVE: "RESERVE",
  UNRESERVE: "UNRESERVE",
  OUT: "OUT", // ✅ DB enum supports OUT, NOT "ISSUE"
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function makeIssueNo() {
  return (
    "BI" +
    Math.random()
      .toString(36)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 6)
  );
}

// allocate qty from available batches (FIFO by id)
async function allocateFromBatches({ book_id, qtyNeeded, t, lock }) {
  const batches = await InventoryBatch.findAll({
    where: { book_id, available_qty: { [Op.gt]: 0 } },
    order: [["id", "ASC"]],
    transaction: t,
    lock: lock ? t.LOCK.UPDATE : undefined,
  });

  let remaining = qtyNeeded;
  const allocations = [];

  for (const b of batches) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, Number(b.available_qty || 0));
    if (take > 0) {
      allocations.push({ batch_id: b.id, qty: take });
      remaining -= take;
    }
  }

  return { allocations, remaining };
}

// include builder for list endpoints
function issueInclude() {
  return [
    {
      model: Bundle,
      as: "bundle",
      required: false,
      // ✅ if you ever add `attributes` here, ensure `notes` is included.
      include: [
        { model: School, as: "school", required: false },
        {
          model: BundleItem,
          as: "items",
          required: false,
          include: [{ model: Book, as: "book", required: false }],
        },
      ],
    },

    // ✅ IMPORTANT: use your real alias names
    { model: School, as: "issuedSchool", required: false },
    { model: Distributor, as: "issuedDistributor", required: false },
  ];
}

/**
 * ✅ Normalize issue json so frontend always gets `notes`
 * Your DB column is `remarks` (formerly notes), but UI expects `notes`.
 */
function normalizeIssueRow(r) {
  const obj = r?.toJSON ? r.toJSON() : r;
  if (!obj) return obj;

  // ✅ Make sure issue notes always available in `notes`
  obj.notes = obj.notes ?? obj.remarks ?? null;

  // ✅ Also expose bundle notes in a consistent key (optional convenience)
  // frontend can still use obj.bundle?.notes
  obj.bundle_notes = obj.bundle?.notes ?? null;

  return obj;
}

/* =========================================================
   ✅ POST /api/bundle-issues
   Wrapper -> calls issueBundle() (bundles/:id/issue)
   ========================================================= */
exports.create = async (request, reply) => {
  const body = request.body || {};
  const bundle_id = num(body.bundle_id);
  if (!bundle_id) return reply.code(400).send({ message: "bundle_id is required" });

  request.params = request.params || {};
  request.params.id = String(bundle_id);

  request.body = request.body || {};
  // Accept notes from frontend, store into remarks internally
  request.body.remarks = request.body.remarks ?? request.body.notes ?? null;
  request.body.qty = Math.max(1, num(request.body.qty) || 1);

  return exports.issueBundle(request, reply);
};

/* =========================================================
   POST /api/bundle-issues/bundles/:id/issue
   ✅ Deduct inventory (OUT txns)
   ✅ UNRESERVE (if bundle had reserved)
   ✅ Update BundleItems
   ✅ Create BundleIssue record
   ========================================================= */
exports.issueBundle = async (request, reply) => {
  const bundleId = num(request.params?.id);
  const body = request.body || {};

  const issue_date = (body.issue_date && String(body.issue_date).trim()) || null;
  const issued_to_type = String(body.issued_to_type || "SCHOOL").toUpperCase();
  const issued_to_id = num(body.issued_to_id);

  const qtyMultiplier = Math.max(1, num(body.qty) || 1);

  // accept either `remarks` or `notes`
  const remarksRaw = body.remarks ?? body.notes;
  const remarks = remarksRaw ? String(remarksRaw).trim() : null;

  const sessionFromBody = body.academic_session ? String(body.academic_session).trim() : null;

  if (!bundleId) return reply.code(400).send({ message: "Invalid bundle id" });
  if (!["SCHOOL", "DISTRIBUTOR"].includes(issued_to_type)) {
    return reply.code(400).send({ message: "issued_to_type must be SCHOOL or DISTRIBUTOR" });
  }
  if (!issued_to_id) return reply.code(400).send({ message: "issued_to_id is required" });

  const t = await sequelize.transaction();
  try {
    const bundle = await Bundle.findByPk(bundleId, {
      include: [
        {
          model: BundleItem,
          as: "items",
          include: [{ model: Book, as: "book", required: false }],
          required: false,
        },
        { model: School, as: "school", required: false },
      ],
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    if (!bundle) {
      await t.rollback();
      return reply.code(404).send({ message: "Bundle not found" });
    }

    // Optional: session check if provided
    if (sessionFromBody && String(bundle.academic_session || "").trim() !== sessionFromBody) {
      await t.rollback();
      return reply.code(400).send({
        message: `Academic session mismatch. Bundle is ${bundle.academic_session}`,
      });
    }

    const st = String(bundle.status || "").toUpperCase();
    if (["ISSUED", "DISPATCHED", "DELIVERED"].includes(st)) {
      await t.rollback();
      return reply.code(400).send({ message: `Bundle already ${bundle.status}` });
    }
    if (st === "CANCELLED") {
      await t.rollback();
      return reply.code(400).send({ message: "Cannot issue a CANCELLED bundle" });
    }

    // verify issued_to exists
    if (issued_to_type === "SCHOOL") {
      const s = await School.findByPk(issued_to_id, { transaction: t });
      if (!s) {
        await t.rollback();
        return reply.code(404).send({ message: "Target school not found" });
      }
    } else {
      const d = await Distributor.findByPk(issued_to_id, { transaction: t });
      if (!d) {
        await t.rollback();
        return reply.code(404).send({ message: "Target distributor not found" });
      }
    }

    const items = (bundle.items || []).map((it) => ({
      id: it.id,
      book_id: num(it.book_id),
      required_qty: num(it.required_qty),
      reserved_qty: num(it.reserved_qty),
      issued_qty: num(it.issued_qty),
      book_title: it.book?.title || null,
    }));

    /**
     * ✅ Issue logic:
     * - if reserved_qty > 0 => issue reserved * qtyMultiplier
     * - else => issue remaining required (required - issued) * qtyMultiplier
     */
    const issueItems = items
      .map((it) => {
        const reserved = Math.max(0, it.reserved_qty);
        const required = Math.max(0, it.required_qty);
        const alreadyIssued = Math.max(0, it.issued_qty);

        const baseToIssue = reserved > 0 ? reserved : Math.max(0, required - alreadyIssued);
        const toIssue = baseToIssue * qtyMultiplier;

        return {
          ...it,
          baseReserved: reserved, // for UNRESERVE only
          baseToIssue,
          toIssue,
        };
      })
      .filter((x) => x.book_id && x.toIssue > 0);

    if (!issueItems.length) {
      await t.rollback();
      return reply.code(400).send({
        message: "Nothing left to issue for this bundle (already issued / no required qty).",
      });
    }

    // 1) Check availability from batches for each book
    const shortages = [];
    const allocationsByBook = new Map(); // book_id -> [{batch_id, qty}]

    for (const it of issueItems) {
      const { allocations, remaining } = await allocateFromBatches({
        book_id: it.book_id,
        qtyNeeded: it.toIssue,
        t,
        lock: true,
      });

      if (remaining > 0) {
        shortages.push({
          book_id: it.book_id,
          title: it.book_title,
          requested: it.toIssue,
          shortBy: remaining,
        });
      } else {
        allocationsByBook.set(it.book_id, allocations);
      }
    }

    if (shortages.length) {
      await t.rollback();
      return reply.code(400).send({
        message: "Insufficient available stock to issue",
        shortages,
      });
    }

    // 2) Create BundleIssue (unique issue_no)
    let issue_no = makeIssueNo();
    for (let i = 0; i < 5; i++) {
      const exists = await BundleIssue.findOne({
        where: { issue_no },
        transaction: t,
      });
      if (!exists) break;
      issue_no = makeIssueNo();
    }

    const issue = await BundleIssue.create(
      {
        bundle_id: bundle.id,
        issue_no,
        issue_date: issue_date || new Date().toISOString().slice(0, 10),
        issued_to_type,
        issued_to_id,
        issued_by: request.user?.id || null,
        remarks, // ✅ DB column is remarks
        status: "ISSUED",
      },
      { transaction: t }
    );

    // 3) Create InventoryTxn OUT per allocation + decrement InventoryBatch.available_qty
    const outTxns = [];

    for (const it of issueItems) {
      const allocs = allocationsByBook.get(it.book_id) || [];

      for (const a of allocs) {
        outTxns.push({
          txn_type: TXN_TYPE.OUT,
          book_id: it.book_id,
          batch_id: a.batch_id,
          qty: a.qty,
          ref_type: "BUNDLE_ISSUE",
          ref_id: issue.id,
          notes: `Issue bundle #${bundle.id} (x${qtyMultiplier}) via issue #${issue.issue_no} to ${issued_to_type}:${issued_to_id}`,
        });
      }

      for (const a of allocs) {
        await InventoryBatch.update(
          { available_qty: sequelize.literal(`available_qty - ${a.qty}`) },
          { where: { id: a.batch_id }, transaction: t }
        );
      }
    }

    await InventoryTxn.bulkCreate(outTxns, { transaction: t });

    // 4) UNRESERVE only if bundle had reserved_qty > 0
    const unreserveTxns = issueItems
      .filter((it) => it.baseReserved > 0)
      .map((it) => ({
        txn_type: TXN_TYPE.UNRESERVE,
        book_id: it.book_id,
        batch_id: null,
        qty: it.baseReserved,
        ref_type: "BUNDLE",
        ref_id: bundle.id,
        notes: `Auto unreserve on issue for bundle #${bundle.id} (issue #${issue.issue_no})`,
      }));

    if (unreserveTxns.length) {
      await InventoryTxn.bulkCreate(unreserveTxns, { transaction: t });
    }

    // 5) Update bundle_items:
    // - reserved_qty -> 0
    // - issued_qty += toIssue
    for (const it of issueItems) {
      await BundleItem.update(
        {
          reserved_qty: 0,
          issued_qty: sequelize.literal(`issued_qty + ${it.toIssue}`),
        },
        { where: { id: it.id }, transaction: t }
      );
    }

    // 6) Update bundle status
    await bundle.update({ status: "ISSUED" }, { transaction: t });

    await t.commit();

    const issued_summary = issueItems.map((it) => ({
      book_id: it.book_id,
      title: it.book_title,
      qty: it.toIssue,
    }));

    // ✅ IMPORTANT: return BOTH issue notes + bundle notes
    return reply.send({
      message: "Bundle issued successfully",
      issue: {
        id: issue.id,
        issue_no: issue.issue_no,
        issue_date: issue.issue_date,
        issued_to_type: issue.issued_to_type,
        issued_to_id: issue.issued_to_id,
        notes: issue.remarks ?? null, // ✅ frontend expects notes
        remarks: issue.remarks ?? null, // optional
        qty_multiplier: qtyMultiplier,
        status: issue.status,
      },
      bundle: {
        id: bundle.id,
        status: "ISSUED",
        notes: bundle.notes ?? null, // ✅ bundle notes
      },
      issued_summary,
    });
  } catch (err) {
    request.log.error(err);
    await t.rollback();
    return reply.code(500).send({ message: "Internal Server Error" });
  }
};

/* =========================================================
   GET /api/bundle-issues/bundles/:id/issues
   (issues for one bundle)
   ========================================================= */
exports.listIssuesForBundle = async (request, reply) => {
  const bundleId = num(request.params?.id);
  if (!bundleId) return reply.code(400).send({ message: "Invalid bundle id" });

  try {
    const rows = await BundleIssue.findAll({
      where: { bundle_id: bundleId },
      include: issueInclude(),
      order: [["id", "DESC"]],
    });

    const out = rows.map(normalizeIssueRow);
    return reply.send({ rows: out });
  } catch (err) {
    request.log.error(err);
    return reply.code(500).send({ message: "Internal Server Error" });
  }
};

/* =========================================================
   GET /api/bundle-issues
   Query:
     ?academic_session=2026-27
     ?limit=200
     ?status=ISSUED|CANCELLED
   ✅ for Issued History page
   ========================================================= */
exports.list = async (request, reply) => {
  try {
    const academic_session = request.query?.academic_session
      ? String(request.query.academic_session).trim()
      : null;

    const status = request.query?.status
      ? String(request.query.status).trim().toUpperCase()
      : null;

    const limit = Math.min(500, Math.max(1, num(request.query?.limit) || 200));

    const where = {};
    if (status) where.status = status;

    const rows = await BundleIssue.findAll({
      where,
      include: issueInclude(),
      order: [["id", "DESC"]],
      limit,
    });

    // optional filter by session through joined bundle
    const filtered = academic_session
      ? rows.filter((r) => {
          const s = r.bundle?.academic_session ? String(r.bundle.academic_session).trim() : "";
          return s === academic_session;
        })
      : rows;

    const out = filtered.map(normalizeIssueRow);
    return reply.send({ rows: out });
  } catch (err) {
    request.log.error(err);
    return reply.code(500).send({ message: "Internal Server Error" });
  }
};

/* =========================================================
   POST /api/bundle-issues/:id/cancel
   ✅ Revert inventory back to batches (IN txns)
   ✅ Reduce bundle_items.issued_qty
   ✅ Mark issue as CANCELLED
   ✅ Recalculate bundle status (ISSUED vs RESERVED)
   ========================================================= */
exports.cancel = async (request, reply) => {
  const issueId = num(request.params?.id);
  if (!issueId) return reply.code(400).send({ message: "Invalid issue id" });

  const t = await sequelize.transaction();
  try {
    // lock issue
    const issue = await BundleIssue.findByPk(issueId, {
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    if (!issue) {
      await t.rollback();
      return reply.code(404).send({ message: "Issue not found" });
    }

    const issueStatus = String(issue.status || "ISSUED").toUpperCase();
    if (issueStatus === "CANCELLED") {
      await t.rollback();
      return reply.code(400).send({ message: "Issue already CANCELLED" });
    }

    // load bundle + items
    const bundle = await Bundle.findByPk(issue.bundle_id, {
      include: [
        {
          model: BundleItem,
          as: "items",
          include: [{ model: Book, as: "book", required: false }],
          required: false,
        },
      ],
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    if (!bundle) {
      await t.rollback();
      return reply.code(404).send({ message: "Bundle not found for this issue" });
    }

    // find OUT txns for this issue (exact allocations)
    const outTxns = await InventoryTxn.findAll({
      where: {
        ref_type: "BUNDLE_ISSUE",
        ref_id: issue.id,
        txn_type: TXN_TYPE.OUT,
      },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    if (!outTxns.length) {
      await t.rollback();
      return reply.code(400).send({
        message: "No OUT inventory transactions found for this issue. Cannot auto-revert.",
      });
    }

    // group by batch and by book
    const byBatch = new Map(); // batch_id -> qty
    const byBook = new Map(); // book_id -> qty

    for (const tx of outTxns) {
      const bId = num(tx.batch_id);
      const bookId = num(tx.book_id);
      const q = num(tx.qty);
      if (bId) byBatch.set(bId, (byBatch.get(bId) || 0) + q);
      if (bookId) byBook.set(bookId, (byBook.get(bookId) || 0) + q);
    }

    // 1) Add back to InventoryBatch.available_qty
    for (const [batch_id, qtyAdd] of byBatch.entries()) {
      await InventoryBatch.update(
        { available_qty: sequelize.literal(`available_qty + ${qtyAdd}`) },
        { where: { id: batch_id }, transaction: t }
      );
    }

    // 2) Create IN txns for audit (revert)
    const inTxns = [];
    for (const [batch_id, qtyAdd] of byBatch.entries()) {
      const any = outTxns.find((x) => num(x.batch_id) === num(batch_id));
      inTxns.push({
        txn_type: TXN_TYPE.IN,
        book_id: num(any?.book_id),
        batch_id: num(batch_id),
        qty: qtyAdd,
        ref_type: "BUNDLE_ISSUE_CANCEL",
        ref_id: issue.id,
        notes: `Cancel issue #${issue.issue_no || issue.id} -> stock revert for bundle #${bundle.id}`,
      });
    }
    await InventoryTxn.bulkCreate(inTxns, { transaction: t });

    // 3) Reduce BundleItem.issued_qty per book
    for (const it of bundle.items || []) {
      const bookId = num(it.book_id);
      const dec = num(byBook.get(bookId) || 0);
      if (dec <= 0) continue;

      await BundleItem.update(
        {
          issued_qty: sequelize.literal(
            `CASE WHEN issued_qty - ${dec} < 0 THEN 0 ELSE issued_qty - ${dec} END`
          ),
        },
        { where: { id: it.id }, transaction: t }
      );
    }

    // 4) Mark Issue cancelled
    await issue.update(
      {
        status: "CANCELLED",
        cancelled_at: new Date(),
        cancelled_by: request.user?.id || null,
      },
      { transaction: t }
    );

    // 5) Recalculate bundle status:
    // If any item still has issued_qty > 0 => ISSUED else RESERVED
    const itemsAfter = await BundleItem.findAll({
      where: { bundle_id: bundle.id },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    const stillIssued = itemsAfter.some((x) => num(x.issued_qty) > 0);
    await bundle.update({ status: stillIssued ? "ISSUED" : "RESERVED" }, { transaction: t });

    await t.commit();

    return reply.send({
      message: "Issue cancelled successfully",
      issue: {
        id: issue.id,
        issue_no: issue.issue_no,
        status: "CANCELLED",
        notes: issue.remarks ?? null,
        remarks: issue.remarks ?? null, // optional
      },
      bundle: {
        id: bundle.id,
        status: stillIssued ? "ISSUED" : "RESERVED",
        notes: bundle.notes ?? null, // ✅ bundle notes
      },
      reverted: {
        batches: Array.from(byBatch.entries()).map(([batch_id, qty]) => ({
          batch_id,
          qty,
        })),
      },
    });
  } catch (err) {
    request.log.error(err);
    await t.rollback();
    return reply.code(500).send({ message: "Internal Server Error" });
  }
};
