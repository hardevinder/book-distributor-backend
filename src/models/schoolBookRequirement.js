// src/models/schoolBookRequirement.js

module.exports = (sequelize, DataTypes) => {
  const SchoolBookRequirement = sequelize.define(
    "SchoolBookRequirement",
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },

      // 🔗 Which school is giving this requirement
      school_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
      },

      // 🔗 Which book (publisher comes via Book → Publisher relation)
      book_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
      },

      // Optional: link to Class table (for reports / filters)
      class_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: true,
      },

      // For which academic year, e.g. "2025-26"
      academic_session: {
        type: DataTypes.STRING(20),
        allowNull: true,
      },

      // 📦 Number of copies required
      required_copies: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
      },

      // Status: draft while Excel is being filled, confirmed when final
      status: {
        type: DataTypes.ENUM("draft", "confirmed"),
        allowNull: false,
        defaultValue: "draft",
      },

      // Any note from school (optional)
      remarks: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },

      // Lock after finalisation so school can’t change without your approval
      is_locked: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
    },
    {
      tableName: "school_book_requirements",
      timestamps: true,
      indexes: [
        {
          name: "uniq_school_book_session",
          unique: true,
          fields: ["school_id", "book_id", "academic_session"],
        },
        {
          fields: ["school_id"],
        },
        {
          fields: ["book_id"],
        },
      ],
    }
  );

  // 🧩 Associations (if you are using model.associate pattern in models/index.js)
  SchoolBookRequirement.associate = (models) => {
    SchoolBookRequirement.belongsTo(models.School, {
      foreignKey: "school_id",
      as: "school",
    });

    SchoolBookRequirement.belongsTo(models.Book, {
      foreignKey: "book_id",
      as: "book",
    });

    SchoolBookRequirement.belongsTo(models.Class, {
      foreignKey: "class_id",
      as: "class",
    });
  };

  return SchoolBookRequirement;
};
