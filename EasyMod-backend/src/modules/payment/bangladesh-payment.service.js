const axios = require('axios');
const { AppError } = require('../../utils/AppError');
// D-10 ratified DEFECT CORRECTION (contract §7 row 17, §4.1): the v1 execute
// field docs return title-case 'Completed' while this file compared
// 'COMPLETED'. Compared through the canonical, case-insensitive taxonomy set
// instead — pinned by __tests__/bangladesh-payment.casing.test.js. The file
// stays billing-owned (§4.6): platform env credentials only.
const { isSettledStatus, canonicalStatus } = require('./payment-taxonomy');

/**
 * bKash is a live-money integration. It is OFF unless it is switched on AND
 * every merchant credential is present — a half-configured gateway must never
 * reach the network, and no surface may imply a customer can pay.
 *
 * Read at call time rather than construction time so a config change does not
 * require a restart to take effect, and so a module imported at boot cannot
 * capture a stale "enabled" verdict.
 */
function isBkashEnabled(env = process.env) {
    if (String(env.BKASH_ENABLED || '').toLowerCase() !== 'true') return false;
    return ['BKASH_BASE_URL', 'BKASH_USERNAME', 'BKASH_PASSWORD', 'BKASH_APP_KEY', 'BKASH_APP_SECRET']
        .every((name) => Boolean(env[name]));
}

class BangladeshPaymentService {
    constructor() {
        this.bkashConfig = {
            baseUrl: process.env.BKASH_BASE_URL || 'https://checkout.sandbox.bka.sh/v1.2.0-beta',
            username: process.env.BKASH_USERNAME,
            password: process.env.BKASH_PASSWORD,
            appKey: process.env.BKASH_APP_KEY,
            appSecret: process.env.BKASH_APP_SECRET,
            isSandbox: process.env.BKASH_SANDBOX === 'true'
        };
    }

    /** @returns {boolean} */
    static isEnabled() {
        return isBkashEnabled();
    }

    /**
     * Single choke point for every bKash network call. Throws before any HTTP
     * request when the gateway is disabled, so a disabled deployment cannot
     * initiate, verify, or refund a real payment.
     */
    assertEnabled() {
        if (!isBkashEnabled()) {
            throw new AppError('bKash payments are not available', 503);
        }
    }

    /**
     * Initialize bKash payment
     */
    async initializeBkashPayment(orderData) {
        this.assertEnabled();
        const {
            order_id,
            amount,
            customer_name,
            customer_phone,
            callback_url,
            shop_id
        } = orderData;

        const token = await this.getBkashToken();

        const response = await axios.post(
            `${this.bkashConfig.baseUrl}/checkout/payment/create`,
            {
                mode: '0011',
                payerReference: customer_phone,
                callbackURL: callback_url,
                amount: amount.toString(),
                currency: 'BDT',
                intent: 'sale',
                merchantInvoiceNumber: order_id,
                merchantAssociationInfo: `MI${shop_id}`,
                productType: 'GENERAL',
                productDetails: `Order ${order_id}`,
                customerMsisdn: customer_phone,
                customerName: customer_name
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Authorization': token,
                    'X-APP-Key': this.bkashConfig.appKey
                }
            }
        );

        if (response.data?.paymentID) {
            return {
                success: true,
                payment_id: response.data.paymentID,
                bkash_url: response.data.bkashURL,
                payment_method: 'bKash',
                amount,
                order_id
            };
        }
        throw new Error('Invalid bKash response');
    }

    /**
     * Verify bKash payment
     */
    async verifyBkashPayment(payment_id) {
        this.assertEnabled();
        const token = await this.getBkashToken();

        const response = await axios.post(
            `${this.bkashConfig.baseUrl}/checkout/payment/execute`,
            { paymentID: payment_id },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Authorization': token,
                    'X-APP-Key': this.bkashConfig.appKey
                }
            }
        );

        if (isSettledStatus(response.data?.transactionStatus)) {
            return {
                success: true,
                transaction_id: response.data.trxID,
                amount: response.data.amount,
                currency: response.data.currency,
                payment_time: response.data.paymentTime,
                customer_msisdn: response.data.customerMsisdn,
                merchant_invoice: response.data.merchantInvoiceNumber,
                status: 'completed'
            };
        }
        if (canonicalStatus(response.data?.transactionStatus) === 'initiated') {
            return { success: false, status: 'pending', message: 'Payment is still being processed' };
        }
        return {
            success: false,
            status: 'failed',
            message: response.data?.errorMessage || 'Payment verification failed'
        };
    }

    /**
     * Get bKash OAuth token
     */
    async getBkashToken() {
        this.assertEnabled();
        const response = await axios.post(
            `${this.bkashConfig.baseUrl}/checkout/token/grant`,
            { app_key: this.bkashConfig.appKey, app_secret: this.bkashConfig.appSecret },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'username': this.bkashConfig.username,
                    'password': this.bkashConfig.password
                }
            }
        );

        if (response.data?.id_token) return response.data.id_token;
        throw new Error('Failed to get bKash token');
    }

    /**
     * Process bKash payment callback (webhook)
     */
    async processPaymentCallback(callback_data) {
        const { paymentID, status, trxID, amount, merchantInvoiceNumber } = callback_data;

        if (status === 'success' || status === 'COMPLETED') {
            return {
                success: true,
                payment_id: paymentID,
                transaction_id: trxID,
                amount,
                order_id: merchantInvoiceNumber,
                payment_method: 'bKash',
                status: 'completed'
            };
        }
        return {
            success: false,
            payment_id: paymentID,
            order_id: merchantInvoiceNumber,
            payment_method: 'bKash',
            status,
            message: `Payment ${status}`
        };
    }

    /**
     * Refund bKash payment
     */
    async refundBkashPayment(payment_id, amount, reason) {
        this.assertEnabled();
        const token = await this.getBkashToken();

        const response = await axios.post(
            `${this.bkashConfig.baseUrl}/checkout/payment/refund`,
            {
                paymentID: payment_id,
                amount: amount.toString(),
                trxID: '',
                sku: 'order_refund',
                reason: reason || 'Customer requested refund'
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Authorization': token,
                    'X-APP-Key': this.bkashConfig.appKey
                }
            }
        );

        if (response.data?.refundID) {
            return {
                success: true,
                refund_id: response.data.refundID,
                transaction_id: response.data.trxID,
                amount,
                status: 'refunded'
            };
        }
        throw new Error('Refund failed');
    }

    getSupportedPaymentMethods() {
        return [
            {
                method: 'bKash',
                display_name: 'bKash',
                icon: '/icons/bkash.png',
                enabled: isBkashEnabled(),
                description: 'Pay with bKash mobile wallet'
            }
        ];
    }

    validatePaymentConfig() {
        const issues = [];
        if (!isBkashEnabled()) issues.push('bKash is disabled (BKASH_ENABLED is not "true")');
        if (!this.bkashConfig.appKey) issues.push('bKash app key not configured');
        if (!this.bkashConfig.appSecret) issues.push('bKash app secret not configured');
        return { valid: issues.length === 0, issues };
    }
}

module.exports = BangladeshPaymentService;
module.exports.isBkashEnabled = isBkashEnabled;
