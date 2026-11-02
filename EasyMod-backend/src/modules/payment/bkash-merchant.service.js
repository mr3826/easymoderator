/**
 * bKash Merchant API Service
 * Handles bKash Checkout API integration for merchant accounts
 * Cost-optimized with caching and batch operations
 */

const axios = require('axios');
const crypto = require('crypto');
const { PaymentConfig, Order } = require('../entities');
const { AppError } = require('../../utils/AppError');
const BaseMerchantService = require('./base-merchant.service');
const { getOrigins, joinOrigin } = require('../../config/origins');

const safeErrorCode = (error) => {
    const code = typeof error?.code === 'string' ? error.code.toUpperCase() : '';
    return /^[A-Z][A-Z0-9_:-]{0,63}$/.test(code) ? code : 'BKASH_MERCHANT_ERROR';
};
const safeCorrelationId = (value) => (
    typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value) ? value : null
);
const safePaymentStatus = (value) => (
    ['Completed', 'Initiated', 'Pending', 'Cancelled', 'Failed'].includes(value) ? value : 'unknown'
);

class BkashMerchantService extends BaseMerchantService {
    constructor() {
        const baseUrl = process.env.BKASH_ENVIRONMENT === 'production' 
            ? 'https://checkout.bka.sh' 
            : 'https://checkout.sandbox.bka.sh';
        super('bKash', baseUrl);
    }

    /**
     * Get or refresh bKash OAuth token
     * Tokens are cached for 50 minutes (bKash tokens expire in 60 minutes)
     */
    async getOAuthToken(shopId) {
        const cacheKey = `bkash_token_${shopId}`;
        return this.getCachedToken(cacheKey, async () => {
            const config = await PaymentConfig.findOne({
                where: { shop_id: shopId, gateway: 'bkash', is_enabled: true }
            });

            if (!config?.credentials) {
                throw new AppError('bKash merchant configuration not found', 404);
            }

            const { username, password } = config.credentials;

            const credentials = Buffer.from(`${username}:${password}`).toString('base64');
            
            const response = await axios.post(`${this.baseUrl}/v1.2.0/oauth/token`, 
                'grant_type=password', {
                headers: {
                    'Authorization': `Basic ${credentials}`,
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'application/json'
                }
            });

            return response.data.id_token;
        });
    }

    /**
     * Create bKash checkout payment
     * Returns payment URL for customer to complete payment
     */
    async createPayment(shopId, orderData) {
        const token = await this.getOAuthToken(shopId);
        const config = await PaymentConfig.findOne({
            where: { shop_id: shopId, gateway: 'bkash', is_enabled: true }
        });

        const { app_key, merchant_app_merchant_id } = config.credentials;

        const paymentData = {
            mode: '0011', // Checkout mode
            payerReference: orderData.customer_phone || 'N/A',
            callbackURL: joinOrigin(getOrigins().api, '/api/webhooks/bkash/payment-status'),
            amount: orderData.total.toString(),
            currency: 'BDT',
            intent: 'sale',
            merchantInvoiceNumber: orderData.order_number,
            merchantAssociationInfo: `Shop ${shopId}`,
            productType: 'physical-goods',
            productCategory: 'general',
            productName: `Order ${orderData.order_number}`,
            productDetails: `Payment for order ${orderData.order_number}`,
            additionalMerchantInfo: {
                order_id: orderData.id,
                customer_name: orderData.customer_name,
                customer_phone: orderData.customer_phone
            }
        };

        try {
            const response = await axios.post(`${this.baseUrl}/v1.2.0/checkout/payment/create`,
                paymentData, {
                headers: {
                    'Authorization': token,
                    'X-APP-Key': app_key,
                    'Content-Type': 'application/json'
                }
            });

            const { paymentID, bkashURL } = response.data;

            // Store payment transaction
            await this.createPaymentTransaction({
                orderId: orderData.id,
                shopId,
                paymentId: paymentID,
                amount: orderData.total,
                status: 'initiated',
                gateway: 'bkash'
            });

            this.logger.info('bKash payment created', {
                shopId,
                orderId: orderData.id,
                paymentId: safeCorrelationId(paymentID),
            });

            return {
                success: true,
                paymentId: paymentID,
                paymentUrl: bkashURL,
                expiresAt: new Date(Date.now() + 10 * 60 * 1000) // 10 minutes
            };

        } catch (error) {
            this.logger.error('bKash payment creation failed', {
                shopId,
                orderId: orderData.id,
                errorCode: safeErrorCode(error),
            });
            throw new AppError('Failed to create bKash payment', 500);
        }
    }

    /**
     * Execute bKash payment (called after customer completes payment)
     */
    async executePayment(shopId, paymentId) {
        const token = await this.getOAuthToken(shopId);
        const config = await PaymentConfig.findOne({
            where: { shop_id: shopId, gateway: 'bkash', is_enabled: true }
        });

        const { app_key } = config.credentials;

        try {
            const response = await axios.post(`${this.baseUrl}/v1.2.0/checkout/payment/execute`,
                { paymentID: paymentId }, {
                headers: {
                    'Authorization': token,
                    'X-APP-Key': app_key,
                    'Content-Type': 'application/json'
                }
            });

            const paymentData = response.data;

            // Update payment transaction
            await this.updatePaymentTransaction(paymentId, {
                status: paymentData.transactionStatus,
                gatewayResponse: paymentData,
                verifiedAt: paymentData.transactionStatus === 'Completed' ? new Date() : null
            });

            // Update order if payment successful
            if (paymentData.transactionStatus === 'Completed') {
                await this.updateOrderPaymentStatus(paymentData.merchantInvoiceNumber, {
                    status: 'paid',
                    paidAt: new Date(),
                    transactionId: paymentData.trxID,
                    paymentMethod: 'bkash'
                });
            }

            this.logger.info('bKash payment executed', {
                shopId,
                paymentId: safeCorrelationId(paymentId),
                status: safePaymentStatus(paymentData.transactionStatus),
            });

            return {
                success: paymentData.transactionStatus === 'Completed',
                status: paymentData.transactionStatus,
                amount: paymentData.amount,
                trxID: paymentData.trxID,
                merchantInvoiceNumber: paymentData.merchantInvoiceNumber
            };

        } catch (error) {
            this.logger.error('bKash payment execution failed', {
                shopId,
                paymentId: safeCorrelationId(paymentId),
                errorCode: safeErrorCode(error),
            });
            throw new AppError('Failed to execute bKash payment', 500);
        }
    }

    /**
     * Query payment status (for verification and polling)
     */
    async queryPaymentStatus(shopId, paymentId) {
        const token = await this.getOAuthToken(shopId);
        const config = await PaymentConfig.findOne({
            where: { shop_id: shopId, gateway: 'bkash', is_enabled: true }
        });

        const { app_key } = config.credentials;

        try {
            const response = await axios.post(`${this.baseUrl}/v1.2.0/checkout/payment/query`,
                { paymentID: paymentId }, {
                headers: {
                    'Authorization': token,
                    'X-APP-Key': app_key,
                    'Content-Type': 'application/json'
                }
            });

            const paymentData = response.data;

            // Update payment transaction
            await this.updatePaymentTransaction(paymentId, {
                status: paymentData.transactionStatus,
                gatewayResponse: paymentData,
                verifiedAt: paymentData.transactionStatus === 'Completed' ? new Date() : null
            });

            // Update order if payment successful
            if (paymentData.transactionStatus === 'Completed') {
                await this.updateOrderPaymentStatus(paymentData.merchantInvoiceNumber, {
                    status: 'paid',
                    paidAt: new Date(),
                    transactionId: paymentData.trxID,
                    paymentMethod: 'bkash'
                });
            }

            return {
                success: true,
                status: paymentData.transactionStatus,
                amount: paymentData.amount,
                trxID: paymentData.trxID
            };

        } catch (error) {
            this.logger.error('bKash payment query failed', {
                shopId,
                paymentId: safeCorrelationId(paymentId),
                errorCode: safeErrorCode(error),
            });
            throw new AppError('Failed to query bKash payment status', 500);
        }
    }

    /**
     * Create payment transaction record
     */
    async createPaymentTransaction(data) {
        const { PaymentTransaction } = require('../entities');
        
        await PaymentTransaction.create({
            order_id: data.orderId,
            shop_id: data.shopId,
            payment_method: 'bkash',
            payment_gateway: 'bkash',
            transaction_id: data.paymentId,
            amount: data.amount,
            status: data.status || 'initiated',
            gateway_response: data.gatewayResponse || {},
            created_at: new Date()
        });
    }

    /**
     * Update payment transaction record
     */
    async updatePaymentTransaction(paymentId, updateData) {
        const { PaymentTransaction } = require('../entities');
        
        await PaymentTransaction.update({
            status: updateData.status,
            gateway_response: updateData.gatewayResponse,
            verified_at: updateData.verifiedAt
        }, {
            where: { transaction_id: paymentId }
        });
    }

    /**
     * Update order payment status
     */
    async updateOrderPaymentStatus(orderNumber, updateData) {
        await Order.update({
            payment_status: updateData.status,
            paid_at: updateData.paidAt,
            payment_method: updateData.paymentMethod,
            payment_method_id: updateData.paymentMethodId || null
        }, {
            where: { order_number: orderNumber }
        });
    }

    /**
     * Validate bKash configuration
     */
    async validateConfig(credentials) {
        const required = ['app_key', 'app_secret', 'username', 'password'];
        const missing = required.filter(key => !credentials[key]);
        
        if (missing.length > 0) {
            throw new AppError(`Missing bKash credentials: ${missing.join(', ')}`, 400);
        }

        // Test authentication
        try {
            this.baseUrl = process.env.BKASH_ENVIRONMENT === 'production' 
                ? 'https://checkout.bka.sh' 
                : 'https://checkout.sandbox.bka.sh';

            const testCredentials = Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64');
            
            const response = await axios.post(`${this.baseUrl}/v1.2.0/oauth/token`, 
                'grant_type=password', {
                headers: {
                    'Authorization': `Basic ${testCredentials}`,
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'application/json'
                },
                timeout: 10000 // 10 second timeout
            });

            if (response.data.id_token) {
                return { success: true, message: 'bKash credentials validated successfully' };
            }

        } catch (error) {
            throw new AppError('bKash authentication failed: ' + error.message, 400);
        }
    }

    /**
     * Clear cached token (for testing or forced refresh)
     */
    clearTokenCache(shopId) {
        const cacheKey = `bkash_token_${shopId}`;
        this.cache.delete(cacheKey);
    }
}

module.exports = new BkashMerchantService();
