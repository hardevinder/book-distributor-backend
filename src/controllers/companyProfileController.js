// src/controllers/companyProfileController.js

const { CompanyProfile, sequelize } = require("../models");
const { Op } = require("sequelize");

// for upload
const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream");
const { promisify } = require("util");
const pump = promisify(pipeline);

/* ============================================================
   GET LIST → GET /api/company-profiles
============================================================ */
async function getCompanyProfiles(request, reply) {
  try {
    const { q, is_active } = request.query || {};
    const where = {};

    if (q && String(q).trim()) {
      const search = String(q).trim();
      where[Op.or] = [
        { name: { [Op.like]: `%${search}%` } },
        { city: { [Op.like]: `%${search}%` } },
        { state: { [Op.like]: `%${search}%` } },
        { phone_primary: { [Op.like]: `%${search}%` } },
        { phone_secondary: { [Op.like]: `%${search}%` } },
        { email: { [Op.like]: `%${search}%` } },
      ];
    }

    if (typeof is_active !== "undefined") {
      if (is_active === "true" || is_active === "1") where.is_active = true;
      if (is_active === "false" || is_active === "0") where.is_active = false;
    }

    const profiles = await CompanyProfile.findAll({
      where,
      order: [
        ["is_default", "DESC"],
        ["id", "ASC"],
      ],
    });

    reply.send(profiles);
  } catch (err) {
    request.log.error(err);
    reply.code(500).send({ message: "Failed to fetch company profiles" });
  }
}

/* ============================================================
   GET SINGLE → GET /api/company-profiles/:id
============================================================ */
async function getCompanyProfileById(request, reply) {
  try {
    const { id } = request.params;

    const profile = await CompanyProfile.findByPk(id);

    if (!profile) {
      return reply.code(404).send({ message: "Company profile not found" });
    }

    reply.send(profile);
  } catch (err) {
    request.log.error(err);
    reply.code(500).send({ message: "Failed to fetch company profile" });
  }
}

/* ============================================================
   CREATE → POST /api/company-profiles
============================================================ */
async function createCompanyProfile(request, reply) {
  const t = await sequelize.transaction();
  try {
    const {
      name,
      address_line1,
      address_line2,
      city,
      state,
      pincode,
      phone_primary,
      phone_secondary,
      email,
      website,
      gstin,
      logo_url,
      is_default,
      is_active,
    } = request.body || {};

    if (!name || !String(name).trim()) {
      await t.rollback();
      return reply.code(400).send({ message: "Name is required" });
    }

    const payload = {
      name: String(name).trim(),
      address_line1,
      address_line2,
      city,
      state,
      pincode,
      phone_primary,
      phone_secondary,
      email,
      website,
      gstin,
      logo_url,
      is_default: typeof is_default === "boolean" ? is_default : true,
      is_active: typeof is_active === "boolean" ? is_active : true,
    };

    if (payload.is_default) {
      await CompanyProfile.update(
        { is_default: false },
        { where: { is_default: true }, transaction: t }
      );
    } else {
      const existingDefault = await CompanyProfile.findOne({
        where: { is_default: true },
        transaction: t,
      });
      if (!existingDefault) payload.is_default = true;
    }

    const profile = await CompanyProfile.create(payload, { transaction: t });

    await t.commit();
    reply.code(201).send(profile);
  } catch (err) {
    await t.rollback();
    request.log.error(err);
    reply.code(500).send({ message: "Failed to create company profile" });
  }
}

/* ============================================================
   UPDATE → PUT /api/company-profiles/:id
============================================================ */
async function updateCompanyProfile(request, reply) {
  const t = await sequelize.transaction();
  try {
    const { id } = request.params;
    const {
      name,
      address_line1,
      address_line2,
      city,
      state,
      pincode,
      phone_primary,
      phone_secondary,
      email,
      website,
      gstin,
      logo_url,
      is_default,
      is_active,
    } = request.body || {};

    const profile = await CompanyProfile.findByPk(id, { transaction: t });

    if (!profile) {
      await t.rollback();
      return reply.code(404).send({ message: "Company profile not found" });
    }

    const updates = {};

    if (typeof name !== "undefined") updates.name = String(name).trim();
    if (typeof address_line1 !== "undefined") updates.address_line1 = address_line1;
    if (typeof address_line2 !== "undefined") updates.address_line2 = address_line2;
    if (typeof city !== "undefined") updates.city = city;
    if (typeof state !== "undefined") updates.state = state;
    if (typeof pincode !== "undefined") updates.pincode = pincode;
    if (typeof phone_primary !== "undefined") updates.phone_primary = phone_primary;
    if (typeof phone_secondary !== "undefined") updates.phone_secondary = phone_secondary;
    if (typeof email !== "undefined") updates.email = email;
    if (typeof website !== "undefined") updates.website = website;
    if (typeof gstin !== "undefined") updates.gstin = gstin;
    if (typeof logo_url !== "undefined") updates.logo_url = logo_url;
    if (typeof is_active !== "undefined") updates.is_active = !!is_active;

    const defaultFlagProvided = typeof is_default !== "undefined";

    if (defaultFlagProvided && !!is_default) {
      updates.is_default = true;
      await CompanyProfile.update(
        { is_default: false },
        { where: { id: { [Op.ne]: profile.id }, is_default: true }, transaction: t }
      );
    } else if (defaultFlagProvided && !is_default) {
      updates.is_default = false;

      const anotherDefault = await CompanyProfile.findOne({
        where: { id: { [Op.ne]: profile.id }, is_default: true },
        transaction: t,
      });

      if (!anotherDefault) updates.is_default = true;
    }

    await profile.update(updates, { transaction: t });

    await t.commit();
    reply.send(profile);
  } catch (err) {
    await t.rollback();
    request.log.error(err);
    reply.code(500).send({ message: "Failed to update company profile" });
  }
}

/* ============================================================
   TOGGLE ACTIVE → PATCH /api/company-profiles/:id/toggle
============================================================ */
async function toggleCompanyProfileActive(request, reply) {
  try {
    const { id } = request.params;

    const profile = await CompanyProfile.findByPk(id);

    if (!profile) {
      return reply.code(404).send({ message: "Company profile not found" });
    }

    profile.is_active = !profile.is_active;
    await profile.save();

    reply.send(profile);
  } catch (err) {
    request.log.error(err);
    reply.code(500).send({ message: "Failed to toggle status" });
  }
}

/* ============================================================
   GET DEFAULT PROFILE → GET /api/company-profile/default
============================================================ */
async function getDefaultCompanyProfile(request, reply) {
  try {
    let profile = await CompanyProfile.findOne({
      where: { is_default: true },
    });

    if (!profile) profile = await CompanyProfile.findOne();

    reply.send(profile || null);
  } catch (err) {
    request.log.error(err);
    reply.code(500).send({ message: "Failed to fetch default company profile" });
  }
}

/* ============================================================
   UPLOAD LOGO → POST /api/company-profile/logo-upload
============================================================ */
async function uploadCompanyLogo(request, reply) {
  try {
    const file = await request.file();

    if (!file) {
      return reply.code(400).send({ message: "No file uploaded" });
    }

    const allowedMime = ["image/png", "image/jpeg", "image/jpg", "image/webp"];
    if (!allowedMime.includes(file.mimetype)) {
      return reply.code(400).send({ message: "Only PNG, JPG, JPEG, WEBP allowed" });
    }

    const uploadDir = path.join(__dirname, "..", "uploads", "company-logos");
    fs.mkdirSync(uploadDir, { recursive: true });

    const ext = path.extname(file.filename) || ".png";
    const fileName = `logo-${Date.now()}${ext}`;
    const fullPath = path.join(uploadDir, fileName);

    await pump(file.file, fs.createWriteStream(fullPath));

    const logoUrl = `/uploads/company-logos/${fileName}`;

    return reply.send({
      message: "Logo uploaded successfully",
      logo_url: logoUrl,
    });
  } catch (err) {
    request.log.error(err);
    reply.code(500).send({ message: "Failed to upload logo", error: err.message });
  }
}

module.exports = {
  getCompanyProfiles,
  getCompanyProfileById,
  createCompanyProfile,
  updateCompanyProfile,
  toggleCompanyProfileActive,
  getDefaultCompanyProfile,
  uploadCompanyLogo,
};
