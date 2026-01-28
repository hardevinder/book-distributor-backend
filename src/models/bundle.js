// src/models/bundle.js
"use strict";

module.exports = (sequelize, DataTypes) => {
  const Bundle = sequelize.define(
    "Bundle",
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },

      school_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
      },

      // preferred: class_id (if you maintain a classes master)
      class_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: true,
      },

      // fallback: class_name (if class_id is not used)
      class_name: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },

      academic_session: {
        type: DataTypes.STRING(20),
        allowNull: true,
      },

      // kit name (e.g., "Class 5 Student Kit")
      name: {
        type: DataTypes.STRING(200),
        allowNull: false,
      },

      is_active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },

      sort_order: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
      },
    },
    {
      tableName: "bundles",
      timestamps: true,
      indexes: [
        // Common filters
        { name: "idx_bundles_school", fields: ["school_id"] },
        { name: "idx_bundles_session", fields: ["academic_session"] },
        { name: "idx_bundles_active", fields: ["is_active"] },

        // School + class filters (both supported)
        { name: "idx_bundles_school_classid", fields: ["school_id", "class_id"] },
        { name: "idx_bundles_school_classname", fields: ["school_id", "class_name"] },

        // Sorting list UI
        { name: "idx_bundles_school_sort", fields: ["school_id", "sort_order"] },
      ],
      hooks: {
        // Normalize inputs
        beforeValidate: (row) => {
          // trim
          if (row.name != null) row.name = String(row.name).trim();
          if (row.class_name != null) {
            const s = String(row.class_name).trim();
            row.class_name = s ? s : null;
          }
          if (row.academic_session != null) {
            const s = String(row.academic_session).trim();
            row.academic_session = s ? s : null;
          }

          // normalize numbers
          row.sort_order = Number.isFinite(Number(row.sort_order)) ? Number(row.sort_order) : 0;

          // normalize booleans
          row.is_active = row.is_active === false || row.is_active === 0 || row.is_active === "0" ? false : true;

          // normalize empty class_id
          if (row.class_id === "" || row.class_id === undefined) row.class_id = null;
        },
      },
      validate: {
        // Ensure at least one of class_id / class_name is present (optional but helpful)
        classSelectorValid() {
          const hasClassId = this.class_id != null && this.class_id !== 0;
          const hasClassName = this.class_name != null && String(this.class_name).trim().length > 0;

          // Allow both null if you want school-wide bundles.
          // If you want to force class, uncomment below:
          // if (!hasClassId && !hasClassName) {
          //   throw new Error("Either class_id or class_name is required.");
          // }

          // If class_id is present, class_name can be null (cleaner)
          if (hasClassId) {
            // keep class_name optional; controller may set it
          } else if (hasClassName) {
            // ok
          }
        },
      },
    }
  );

  /* ============================
   * Associations
   * ============================ */
  Bundle.associate = (models) => {
    // ✅ Bundle → School
    if (models.School) {
      Bundle.belongsTo(models.School, {
        foreignKey: "school_id",
        as: "school",
      });
    }

    // ✅ Bundle → Class (optional)
    if (models.Class) {
      Bundle.belongsTo(models.Class, {
        foreignKey: "class_id",
        as: "class",
      });
    }

    // ✅ Bundle → Items
    if (models.BundleItem) {
      Bundle.hasMany(models.BundleItem, {
        foreignKey: "bundle_id",
        as: "items",
        onDelete: "CASCADE",
        hooks: true,
      });
    }
  };

  return Bundle;
};
