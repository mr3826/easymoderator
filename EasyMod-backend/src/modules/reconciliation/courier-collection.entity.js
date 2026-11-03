const { DataTypes } = require('sequelize');
const { sequelize } = require('../../utils/database/database-setup');

const CourierCodCollection = sequelize.define('CourierCodCollection', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  shop_id: {
    type: DataTypes.UUID,
    allowNull: false
  },
  provider: {
    type: DataTypes.STRING,
    allowNull: false
  },
  payment_reference: {
    type: DataTypes.STRING,
    allowNull: false
  },
  claimed_amount: {
    type: DataTypes.DECIMAL(12, 2),
    allowNull: false
  },
  // Reconciliation outcome for this statement line. Only MATCHED means the
  // linked order evidence agrees with the courier's claim; see
  // reconciliation.service.js STATES for the full vocabulary.
  state: {
    type: DataTypes.STRING(32),
    allowNull: false,
    defaultValue: 'PROVIDER_REPORTED'
  },
  // Gross COD the linked orders expect the courier to collect. NULL while the
  // linkage or amount basis is unresolved — never backfilled from the claim.
  expected_amount: {
    type: DataTypes.DECIMAL(12, 2),
    allowNull: true
  },
  consignment_count: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0
  },
  consignment_ids: {
    type: DataTypes.TEXT,
    allowNull: false,
    defaultValue: '[]',
    get() {
      const raw = this.getDataValue('consignment_ids');
      try { return JSON.parse(raw); } catch { return []; }
    },
    set(val) {
      this.setDataValue('consignment_ids', JSON.stringify(val));
    }
  },
  payment_date: {
    type: DataTypes.DATEONLY,
    allowNull: false
  },
  raw_payload: {
    type: DataTypes.TEXT,
    allowNull: true
  }
}, {
  tableName: 'courier_cod_collections',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

module.exports = CourierCodCollection;
