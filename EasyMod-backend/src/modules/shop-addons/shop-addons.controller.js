'use strict';

const { sequelize } = require('../../utils/database/database-setup');
const auditService = require('../audit/audit.service');
const service = require('./shop-addons.service');

exports.getShopAddons = async (req, res, next) => {
    try {
        const data = await service.getShopAddonState(req.user.userId, req.user.shopId);
        res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
};

exports.setShopAddon = async (req, res, next) => {
    try {
        const shopId = req.user.shopId;
        const addonCode = req.params.addonCode;
        const enabled = req.body.enabled;
        const data = await sequelize.transaction(async (transaction) => {
            const result = await service.setShopAddonEnabled({
                userId: req.user.userId,
                shopId,
                addonCode,
                enabled,
                transaction,
            });
            if (result.previous.enabled !== result.current.enabled) {
                await auditService.logOperation({
                    userId: req.user.userId,
                    shopId,
                    action: enabled ? 'shop:addon_enabled' : 'shop:addon_disabled',
                    resourceType: 'SHOP_ADDON',
                    resourceId: addonCode,
                    oldValues: result.previous,
                    newValues: result.current,
                    ipAddress: req.ip || null,
                    userAgent: req.get('user-agent') || null,
                }, { transaction, required: true });
            }
            return result.current;
        });
        res.json({ success: true, data: { code: addonCode, ...data } });
    } catch (error) {
        next(error);
    }
};
