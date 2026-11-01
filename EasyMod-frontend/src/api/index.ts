/**
 * New API Layer - Centralized HTTP Client and Domain APIs
 * 
 * This module provides a clean, domain-based API structure
 * that consolidates all HTTP communication through a single client.
 * 
 * Migration from old api.ts:
 * - Import types from '@/api/types'
 * - Import API functions from '@/api/domains/[domain]'
 * - The httpClient is available at '@/shared/lib/http/client'
 * 
 * Example usage:
 * ```typescript
 * import { auth, product } from '@/api/domains';
 * import type { User, Product } from '@/api/types';
 * 
 * const user = await auth.getAuthContext();
 * const products = await product.getProducts();
 * ```
 */

// Re-export types
export * from './types';

// Re-export domain APIs as namespaces
export * from './domains';

// Re-export httpClient for advanced use cases
export { httpClient } from '@/shared/lib/http/client';
export type { ExtendedAxiosRequestConfig } from '@/shared/lib/http/client';

// Re-export error utilities
export {
  normalizeApiError,
  isApiError,
  getErrorMessage,
  getValidationErrors,
  type ApiErrorType,
  type NormalizedApiError,
} from '@/shared/lib/http/errors';

/**
 * Backward compatibility exports
 * These maintain compatibility with the old api.ts exports
 * while migrating to the new structure
 */

// Import domains for re-export
import * as authDomain from './domains/auth';
import * as productDomain from './domains/product';
import * as orderDomain from './domains/order';
import * as customerDomain from './domains/customer';
import {
  listMetaChannels,
  initiateMetaOAuth,
  handleMetaOAuthCallback,
  connectMetaAsset,
  disconnectMetaChannel,
  reconnectMetaChannel,
  pingMetaChannel,
  getMetaChannelConsentSummary,
} from './domains/meta-channels';
import * as dashboardDomain from './domains/dashboard';
import * as knowledgeDomain from './domains/knowledge';
import * as subscriptionDomain from './domains/subscription';
import * as conversationDomain from './domains/conversation';
import * as shopDomain from './domains/shop';
import * as setupDomain from './domains/setup';
import * as paymentDomain from './domains/payment';
import * as auditDomain from './domains/audit';
import * as rtoShieldDomain from './domains/rto-shield';
import * as notificationDomain from './domains/notification';

// Legacy ApiClient singleton for gradual migration
import { httpClient } from '@/shared/lib/http/client';
import type { AxiosResponse } from 'axios';

/**
 * @deprecated Use auth domain directly: import { auth } from '@/api/domains'
 */
export const apiClient = {
  // Auth methods
  signin: authDomain.signin,
  signup: authDomain.signup,
  forgotPassword: authDomain.forgotPassword,
  resetPassword: authDomain.resetPassword,
  logout: authDomain.logout,
  getAuthContext: authDomain.getAuthContext,
  refreshToken: authDomain.refreshToken,
  verifyTwoFactor: authDomain.verifyTwoFactor,
  getShops: authDomain.getShops,
  createShop: authDomain.createShop,
  switchShop: authDomain.switchShop,
  getShopAgents: authDomain.getShopAgents,

  // Product methods
  getProducts: productDomain.getProducts,
  getProduct: productDomain.getProduct,
  createProduct: productDomain.createProduct,
  updateProduct: productDomain.updateProduct,
  deleteProduct: productDomain.deleteProduct,
  uploadProductImage: productDomain.uploadProductImage,
  extractProductsFromUpload: productDomain.extractProductsFromUpload,
  getCategories: productDomain.getCategories,
  getCategory: productDomain.getCategory,
  getSubcategoryDetails: productDomain.getSubcategoryDetails,
  createCategory: productDomain.createCategory,
  updateCategory: productDomain.updateCategory,
  deleteCategory: productDomain.deleteCategory,

  // Order methods
  getOrders: orderDomain.getOrders,
  getOrder: orderDomain.getOrder,
  createOrder: orderDomain.createOrder,
  updateOrder: orderDomain.updateOrder,
  confirmOrder: orderDomain.confirmOrder,
  cancelOrder: orderDomain.cancelOrder,
  bookCourier: orderDomain.bookCourier,
  getDeliverySettings: orderDomain.getDeliverySettings,
  connectDeliveryProvider: orderDomain.connectDeliveryProvider,
  disconnectDeliveryProvider: orderDomain.disconnectDeliveryProvider,
  toggleDeliveryProvider: orderDomain.toggleDeliveryProvider,
  updateDeliverySettings: orderDomain.updateDeliverySettings,
  testDeliveryConnection: orderDomain.testDeliveryConnection,

  // Customer methods
  getCustomers: customerDomain.getCustomers,
  getCustomer: customerDomain.getCustomer,
  createCustomer: customerDomain.createCustomer,
  updateCustomer: customerDomain.updateCustomer,
  deleteCustomer: customerDomain.deleteCustomer,

  // RTO Shield (cross-shop fraud network) methods
  rtoCheckPhone: rtoShieldDomain.checkPhone,
  rtoNetworkStats: rtoShieldDomain.getNetworkStats,
  rtoWhitelistPhone: rtoShieldDomain.whitelistPhone,
  getRtoNetworkSettings: rtoShieldDomain.getNetworkSettings,
  updateRtoNetworkSettings: rtoShieldDomain.updateNetworkSettings,

  // Meta channel methods (Phase 5 — canonical)
  listMetaChannels,
  initiateMetaOAuth,
  handleMetaOAuthCallback,
  connectMetaAsset,
  disconnectMetaChannel,
  reconnectMetaChannel,
  pingMetaChannel,
  getMetaChannelConsentSummary,

  // Dashboard methods
  getDashboardMetrics: dashboardDomain.getDashboardMetrics,
  getDashboardQueue: dashboardDomain.getDashboardQueue,
  getKnowledgeGaps: dashboardDomain.getKnowledgeGaps,
  getAnalytics: dashboardDomain.getAnalytics,

  // Knowledge methods
  listKnowledgeFaqs: knowledgeDomain.listFaqs,
  createKnowledgeFaq: knowledgeDomain.createFaq,
  updateKnowledgeFaq: knowledgeDomain.updateFaq,
  deleteKnowledgeFaq: knowledgeDomain.deleteFaq,

  // Subscription methods
  getSubscription: subscriptionDomain.getSubscription,
  getSubscriptionPlans: subscriptionDomain.getSubscriptionPlans,
  getAiReplyShadowUsage: subscriptionDomain.getAiReplyShadowUsage,
  subscribeToPlan: subscriptionDomain.subscribeToPlan,
  cancelSubscription: subscriptionDomain.cancelSubscription,
  reactivateSubscription: subscriptionDomain.reactivateSubscription,
  getPaymentMethods: subscriptionDomain.getPaymentMethods,
  addPaymentMethod: subscriptionDomain.addPaymentMethod,
  removePaymentMethod: subscriptionDomain.removePaymentMethod,
  setDefaultPaymentMethod: subscriptionDomain.setDefaultPaymentMethod,
  getInvoices: subscriptionDomain.getInvoices,
  getInvoice: subscriptionDomain.getInvoice,

  // Conversation methods
  getConversations: conversationDomain.getConversations,
  getConversation: conversationDomain.getConversation,
  getMessages: conversationDomain.getMessages,
  createMessage: conversationDomain.createMessage,
  approveAiDraft: conversationDomain.approveAiDraft,
  dismissAiDraft: conversationDomain.dismissAiDraft,
  markConversationRead: conversationDomain.markConversationRead,
  updateConversation: conversationDomain.updateConversation,
  transcribeVoice: conversationDomain.transcribeVoice,
  getResponseTemplates: conversationDomain.getResponseTemplates,
  createTemplate: conversationDomain.createTemplate,
  updateTemplate: conversationDomain.updateTemplate,
  deleteTemplate: conversationDomain.deleteTemplate,

  // Shop methods
  getShopBusinessInfo: shopDomain.getShopBusinessInfo,
  updateShopBusinessInfo: shopDomain.updateShopBusinessInfo,
  getShopAISettings: shopDomain.getShopAISettings,
  updateShopAISettings: shopDomain.updateShopAISettings,
  getShop: shopDomain.getShop,
  updateShop: shopDomain.updateShop,
  getSetupStatus: setupDomain.getSetupStatus,

  // Payment config methods
  getPaymentConfig: paymentDomain.getPaymentConfig,
  updatePaymentConfig: paymentDomain.updatePaymentConfig,
  testPaymentConnection: paymentDomain.testPaymentConnection,
  deletePaymentConfig: paymentDomain.deletePaymentConfig,

  // Subscription invoice alias
  getSubscriptionInvoices: subscriptionDomain.getInvoices,

  // bKash invoice payment + integrated top-up
  payInvoice: subscriptionDomain.payInvoice,
  renewSubscription: subscriptionDomain.renewSubscription,
  completeInvoicePayment: subscriptionDomain.completeInvoicePayment,
  cancelInvoicePayment: subscriptionDomain.cancelInvoicePayment,
  getTopupPacks: subscriptionDomain.getTopupPacks,
  initiateTopup: subscriptionDomain.initiateTopup,
  completeTopup: subscriptionDomain.completeTopup,

  // Audit methods
  getAuditLogs: auditDomain.getAuditLogs,
  getResourceAuditLogs: auditDomain.getResourceAuditLogs,

  // Notification methods
  getTelegramNotificationStatus: notificationDomain.getTelegramNotificationStatus,
  createTelegramConnectIntent: notificationDomain.createTelegramConnectIntent,
  sendTelegramTestAlert: notificationDomain.sendTelegramTestAlert,
  updateTelegramPreferences: notificationDomain.updateTelegramPreferences,
  disconnectTelegramAlerts: notificationDomain.disconnectTelegramAlerts,
  getInAppNotifications: notificationDomain.getInAppNotifications,
  markInAppNotificationRead: notificationDomain.markInAppNotificationRead,

  // Utility methods
  initCsrfToken: () => httpClient.initCsrfToken(),
  setAccessToken: (token: string | null) => httpClient.setAccessToken(token),

  // Raw HTTP passthrough — normalises paths that omit the /api prefix
  get: <T = unknown>(url: string, config?: any): Promise<AxiosResponse<T>> =>
    httpClient.get<T>(url.startsWith('/api/') ? url : `/api${url}`, config),
  post: <T = unknown>(url: string, data?: any, config?: any): Promise<AxiosResponse<T>> =>
    httpClient.post<T>(url.startsWith('/api/') ? url : `/api${url}`, data, config),
  put: <T = unknown>(url: string, data?: any, config?: any): Promise<AxiosResponse<T>> =>
    httpClient.put<T>(url.startsWith('/api/') ? url : `/api${url}`, data, config),
  delete: <T = unknown>(url: string, config?: any): Promise<AxiosResponse<T>> =>
    httpClient.delete<T>(url.startsWith('/api/') ? url : `/api${url}`, config),
};

// Utility functions
export function normalizeApiBaseUrl(url: string): string {
  // Remove trailing slash if present
  return url.replace(/\/$/, '');
}

// Default export for compatibility
export default apiClient;
