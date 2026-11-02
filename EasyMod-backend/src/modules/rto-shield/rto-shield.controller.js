const RtoShieldService = require('./rto-shield.service');
const { getNetworkSettings, updateNetworkSettings } = require('./rto-network-settings');

const resolveShopId = (req) => req.shop?.id || req.user?.shopId;

class RtoShieldController {
  static async checkPhone(req, res) {
    try {
      const { phone } = req.body;
      const shopId = resolveShopId(req);
      const result = await RtoShieldService.checkPhone(phone, shopId, {
        trustedContext: false,
        enforceNetwork: false,
      });
      res.json({ success: true, data: result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  /** Free-form phone stats stay local-only; cross-shop reads require an internal verified context. */
  static async networkStats(req, res) {
    try {
      const result = await RtoShieldService.getNetworkStats(req.query.phone, resolveShopId(req), {
        trustedContext: false,
      });
      res.json({ success: true, data: result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  static async addToBlacklist(req, res) {
    try {
      const shopId = resolveShopId(req);
      const addedBy = req.user?.userId;
      const entry = await RtoShieldService.addToBlacklist({ ...req.body, shop_id: shopId, added_by: addedBy });
      res.status(201).json({ success: true, data: entry });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  }

  /** Appeal: shop vouches for a customer, clearing them for this shop only. */
  static async whitelist(req, res) {
    try {
      const shopId = resolveShopId(req);
      const addedBy = req.user?.userId;
      const entry = await RtoShieldService.whitelistPhone({ ...req.body, shop_id: shopId, added_by: addedBy });
      res.status(201).json({ success: true, data: entry });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  }

  static async removeFromBlacklist(req, res) {
    try {
      const shopId = resolveShopId(req);
      const result = await RtoShieldService.removeFromBlacklist(req.params.id, shopId);
      res.json({ success: true, data: result });
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : err.message.includes('denied') ? 403 : 400;
      res.status(status).json({ success: false, error: err.message });
    }
  }

  static async listBlacklist(req, res) {
    try {
      const shopId = resolveShopId(req);
      const { page, limit, search } = req.query;
      const result = await RtoShieldService.listBlacklist({ shopId, page: Number(page) || 1, limit: Number(limit) || 20, search });
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  static async bulkImport(req, res) {
    try {
      const shopId = resolveShopId(req);
      const addedBy = req.user?.userId;
      const result = await RtoShieldService.bulkImport(req.body.entries, shopId, addedBy);
      res.json({ success: true, data: result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  /** Read this shop's network participation (contribute / enforce). */
  static async getSettings(req, res) {
    try {
      const settings = await getNetworkSettings(resolveShopId(req));
      res.json({ success: true, data: settings });
    } catch (err) {
      res.status(err.status || err.statusCode || 500).json({ success: false, error: err.message });
    }
  }

  /** Update this shop's network participation. */
  static async updateSettings(req, res) {
    try {
      const settings = await updateNetworkSettings(resolveShopId(req), req.body, {
        userId: req.user?.userId,
        ipAddress: req.ip,
        userAgent: req.headers?.['user-agent'],
      });
      res.json({ success: true, data: settings });
    } catch (err) {
      const status = err.status || err.statusCode || 400;
      res.status(status).json({ success: false, error: err.message });
    }
  }
}

module.exports = RtoShieldController;
