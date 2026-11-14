const User = require('./user/user.entity');
const Tenant = require('./tenant/tenant.entity');
const Shop = require('./shop/shop.entity');
const UserShop = require('./user-shop/user-shop.entity');
const Session = require('./auth/session.entity'); // ADR M-004: now exported below too (was previously wired for associations only)
const PasswordResetToken = require('./auth/password-reset-token.entity');
const Category = require('./category/category.entity');
const Product = require('./product/product.entity');
// Bug #5: relational variant table (replaces flat JSON array in Product.variants)
const ProductVariant = require('./product/product-variant.entity');
const Customer = require('./customer/customer.entity');
const Order = require('./order/order.entity');
const OrderReturn = require('./order/order-return.entity');
const PartnerBillingAdjustment = require('./subscription/partner-billing-adjustment.entity');
const OrderItem = require('./order/order-item.entity');
const { Conversation, Message } = require('./conversation/conversation.entity');
const InboxDeliveryOutbox = require('./conversation/inbox-delivery-outbox.entity');
const ConversationTurn = require('./conversation/conversation-turn.entity');
const AuditLog = require('./audit/audit-log.entity');
const IdempotencyKey = require('./audit/idempotency-key.entity');
const DeliveryIntegration = require('./delivery/delivery-integration.entity');
const DeliveryCost = require('./delivery/delivery-cost.entity');
const KnownArea = require('./delivery/known-area.entity');
const ShopPickupLocation = require('./delivery/shop-pickup-location.entity');
const PaymentConfig = require('./payment/payment-config.entity');
const Subscription = require('./subscription/subscription.entity');
const Invoice = require('./subscription/invoice.entity');
const BillingLine = require('./commercial/billing-line.entity');
const PartnerApplication = require('./subscription/partner-application.entity');
const UsageEvent = require('./subscription/usage-event.entity');
const Keyword = require('./keyword/keyword.entity');
const FaqResponse = require('./knowledge/faq-response.entity');
const BanglishDictionary = require('./language/banglish-dictionary.entity');
const Analytics = require('./analytics/analytics.entity');
const KnowledgeGap = require('./analytics/knowledge-gap.entity');
const SupportTicket = require('./support/support-ticket.entity');
const ResponseTemplate = require('./template/response-template.entity');
const CustomerPreference = require('./customer/customer-preference.entity');
const CustomerNote = require('./customer/customer-note.entity');
const CustomerTag = require('./customer/customer-tag.entity');
const CustomerTagAssignment = require('./customer/customer-tag-assignment.entity');
const TrxIDLog = require('./payment/trx-id-log.entity');
const PaymentTransaction = require('./billing/payment-transaction.entity');
const OwnerNotification = require('./notification/owner-notification.entity');
const OrderInvoice = require('./billing/invoice.entity');
const DeliveryTracking = require('./order/delivery-tracking.entity');
const CourierDispatch = require('./delivery/courier-dispatch.entity');
const PushSubscription = require('./notification/push-subscription.entity');
const TelegramNotificationBinding = require('./notification/telegram-notification-binding.entity');
const CustomerDeliveryStats = require('./rto-shield/customer-delivery-stats.entity');
const CourierCodCollection = require('./reconciliation/courier-collection.entity');
const ReconciliationDispute = require('./reconciliation/reconciliation-dispute.entity');
const GrowthOsUserRole = require('./growth-os/growth-os-user-role.entity');
// Pilot intelligence — Customer 360 Lite, Sales Opportunities, Order Confidence
const ShopPilotFeatures = require('./pilot-features/shop-pilot-features.entity');
const ShopAddon = require('./shop-addons/shop-addon.entity');
const { AiReplyShadowLedger } = require('./subscription/ai-reply-shadow-ledger.entity');
const { AdsStudioReport, AdsStudioCampaignMetric, AdsStudioDraft } = require('./ads-studio/ads-studio.entity');
const { Storefront, StorefrontProduct } = require('./storefront/storefront.entity');
const CustomerOpportunity = require('./customer-intelligence/customer-opportunity.entity');
const OrderConfidence = require('./order-confidence/order-confidence.entity');

let growthOsProspect;
let growthOsProspectEvent;
let growthOsFollowup;
let growthOsNote;
let growthOsProspectAssociationsReady = false;

function loadGrowthOsProspectEntities() {
    if (!growthOsProspect) {
        growthOsProspect = require('./growth-os/growth-os-prospect.entity');
        growthOsProspectEvent = require('./growth-os/growth-os-prospect-event.entity');
        growthOsFollowup = require('./growth-os/growth-os-followup.entity');
        growthOsNote = require('./growth-os/growth-os-note.entity');
    }

    if (!growthOsProspectAssociationsReady) {
        growthOsProspect.belongsTo(User, { foreignKey: 'owner_user_id', as: 'ownerUser' });
        growthOsProspect.belongsTo(User, { foreignKey: 'assigned_by', as: 'assignedBy' });
        growthOsProspect.belongsTo(User, { foreignKey: 'linked_user_id', as: 'linkedUser' });
        growthOsProspect.belongsTo(User, { foreignKey: 'created_by', as: 'createdBy' });
        growthOsProspect.belongsTo(Shop, { foreignKey: 'linked_shop_id', as: 'linkedShop' });
        growthOsProspect.belongsTo(growthOsProspect, { foreignKey: 'merged_into_id', as: 'mergedInto' });
        User.hasMany(growthOsProspect, { foreignKey: 'owner_user_id', as: 'ownedGrowthProspects' });
        User.hasMany(growthOsProspect, { foreignKey: 'assigned_by', as: 'assignedGrowthProspects' });
        User.hasMany(growthOsProspect, { foreignKey: 'linked_user_id', as: 'linkedGrowthProspects' });
        User.hasMany(growthOsProspect, { foreignKey: 'created_by', as: 'createdGrowthProspects' });
        Shop.hasMany(growthOsProspect, { foreignKey: 'linked_shop_id', as: 'growthOsProspects' });
        growthOsProspect.hasMany(growthOsProspect, { foreignKey: 'merged_into_id', as: 'mergedProspects' });
        growthOsProspect.hasMany(growthOsProspectEvent, {
            foreignKey: 'prospect_id',
            as: 'events',
            onDelete: 'CASCADE',
        });
        growthOsProspectEvent.belongsTo(growthOsProspect, { foreignKey: 'prospect_id', as: 'prospect' });
        growthOsProspectEvent.belongsTo(User, { foreignKey: 'actor_user_id', as: 'actor' });
        User.hasMany(growthOsProspectEvent, { foreignKey: 'actor_user_id', as: 'growthOsProspectEvents' });

        growthOsProspect.hasMany(growthOsFollowup, { foreignKey: 'prospect_id', as: 'followups' });
        growthOsFollowup.belongsTo(growthOsProspect, { foreignKey: 'prospect_id', as: 'prospect' });
        growthOsFollowup.belongsTo(User, { foreignKey: 'owner_user_id', as: 'ownerUser' });
        growthOsFollowup.belongsTo(User, { foreignKey: 'created_by', as: 'createdByUser' });
        User.hasMany(growthOsFollowup, { foreignKey: 'owner_user_id', as: 'ownedGrowthFollowups' });

        // growth_os_notes targets are polymorphic (prospect|user|shop) and the
        // service proves target existence per write, so only the author-side
        // association is modelled here.
        growthOsNote.belongsTo(User, { foreignKey: 'author_user_id', as: 'authorUser' });
        User.hasMany(growthOsNote, { foreignKey: 'author_user_id', as: 'authoredGrowthNotes' });

        growthOsProspectAssociationsReady = true;
    }

    return {
        GrowthOsProspect: growthOsProspect,
        GrowthOsProspectEvent: growthOsProspectEvent,
        GrowthOsFollowup: growthOsFollowup,
        GrowthOsNote: growthOsNote,
    };
}

// Phase 1 — Meta Integration Redesign: new unified channel entities
const MetaChannel = require('./channel-providers/meta-channel.entity');
const MetaChannelSettings = require('./channel-providers/meta-channel-settings.entity');
const MetaChannelConsentEvent = require('./channel-providers/meta-channel-consent-event.entity');
const MetaUserIdentity = require('./channel-providers/meta-user-identity.entity');
const MetaDataDeletionRequest = require('./integration/meta-data-deletion-request.entity');
const MetaWebhookReceipt = require('./integration/meta-webhook-receipt.entity');

// Phase 3 — Policy Engine audit log
const PolicyDecision = require('./policy/policy-decision.entity');

// Define many-to-many relationships
User.belongsToMany(Shop, {
    through: UserShop,
    foreignKey: 'user_id',
    otherKey: 'shop_id',
    as: 'shops'
});

Shop.belongsToMany(User, {
    through: UserShop,
    foreignKey: 'shop_id',
    otherKey: 'user_id',
    as: 'users'
});

// Define belongsTo relationships for UserShop
UserShop.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
UserShop.belongsTo(Shop, { foreignKey: 'shop_id', as: 'shop' });

// Define User-Session relationship
User.hasMany(Session, {
    foreignKey: 'user_id',
    as: 'sessions',
    onDelete: 'CASCADE'
});

Session.belongsTo(User, {
    foreignKey: 'user_id',
    as: 'user'
});

// Define Shop-Session relationship
Shop.hasMany(Session, {
    foreignKey: 'shop_id',
    as: 'sessions',
    onDelete: 'CASCADE'
});

Session.belongsTo(Shop, {
    foreignKey: 'shop_id',
    as: 'shop'
});

// Define Tenant-Shop relationship
Tenant.hasMany(Shop, {
    foreignKey: 'tenant_id',
    as: 'shops',
    onDelete: 'CASCADE'
});

Shop.belongsTo(Tenant, {
    foreignKey: 'tenant_id',
    as: 'tenant'
});

// Define Shop-Category relationship
Shop.hasMany(Category, {
    foreignKey: 'shop_id',
    as: 'categories',
    onDelete: 'CASCADE'
});

Category.belongsTo(Shop, {
    foreignKey: 'shop_id',
    as: 'shop'
});

// Define Category self-referencing relationships
Category.hasMany(Category, {
    foreignKey: 'parent_category_id',
    as: 'subcategories',
    onDelete: 'CASCADE'
});

Category.belongsTo(Category, {
    foreignKey: 'parent_category_id',
    as: 'parent_category'
});

// Define Shop-Product relationship
Shop.hasMany(Product, {
    foreignKey: 'shop_id',
    as: 'products',
    onDelete: 'CASCADE'
});

Product.belongsTo(Shop, {
    foreignKey: 'shop_id',
    as: 'shop'
});

// Define Category-Product relationship
Category.hasMany(Product, {
    foreignKey: 'category_id',
    as: 'products',
    onDelete: 'SET NULL'
});

Product.belongsTo(Category, {
    foreignKey: 'category_id',
    as: 'category_ref'
});

// Define Shop-Customer relationship
Shop.hasMany(Customer, {
    foreignKey: 'shop_id',
    as: 'customers',
    onDelete: 'CASCADE'
});

Customer.belongsTo(Shop, {
    foreignKey: 'shop_id',
    as: 'shop'
});

// Define Shop-Order relationship
Shop.hasMany(Order, {
    foreignKey: 'shop_id',
    as: 'orders',
    onDelete: 'CASCADE'
});

Order.belongsTo(Shop, {
    foreignKey: 'shop_id',
    as: 'shop'
});

// Define Customer-Order relationship
Customer.hasMany(Order, {
    foreignKey: 'customer_id',
    as: 'orders',
    onDelete: 'RESTRICT'
});

Order.belongsTo(Customer, {
    foreignKey: 'customer_id',
    as: 'customer'
});

// Define Order-Product (Many-to-Many through OrderItem)
Order.belongsToMany(Product, {
    through: OrderItem,
    foreignKey: 'order_id',
    otherKey: 'product_id',
    as: 'products'
});

Product.belongsToMany(Order, {
    through: OrderItem,
    foreignKey: 'product_id',
    otherKey: 'order_id',
    as: 'orders'
});

// Define Order-OrderItem (One-to-Many)
Order.hasMany(OrderItem, {
    foreignKey: 'order_id',
    as: 'order_items',
    onDelete: 'CASCADE'
});

OrderItem.belongsTo(Order, {
    foreignKey: 'order_id',
    as: 'order'
});

// Define Product-OrderItem (One-to-Many)
Product.hasMany(OrderItem, {
    foreignKey: 'product_id',
    as: 'order_items',
    onDelete: 'RESTRICT'
});

OrderItem.belongsTo(Product, {
    foreignKey: 'product_id',
    as: 'product'
});

// Define Shop-Conversation relationship
Shop.hasMany(Conversation, {
    foreignKey: 'shop_id',
    as: 'conversations',
    onDelete: 'CASCADE'
});

Conversation.belongsTo(Shop, {
    foreignKey: 'shop_id',
    as: 'shop'
});

// Define Customer-Conversation relationship
Customer.hasMany(Conversation, {
    foreignKey: 'customer_id',
    as: 'conversations',
    onDelete: 'SET NULL'
});

Conversation.belongsTo(Customer, {
    foreignKey: 'customer_id',
    as: 'customer'
});

Conversation.hasMany(ConversationTurn, {
    foreignKey: 'conversation_id',
    as: 'turns',
    onDelete: 'CASCADE',
});

ConversationTurn.belongsTo(Conversation, {
    foreignKey: 'conversation_id',
    as: 'conversation',
});

Shop.hasMany(ConversationTurn, {
    foreignKey: 'shop_id',
    as: 'conversation_turns',
    onDelete: 'CASCADE',
});

ConversationTurn.belongsTo(Shop, {
    foreignKey: 'shop_id',
    as: 'shop',
});

// Define Conversation-Message relationship
Conversation.hasMany(Message, {
    foreignKey: 'conversation_id',
    as: 'messages',
    onDelete: 'CASCADE'
});

Message.belongsTo(Conversation, {
    foreignKey: 'conversation_id',
    as: 'conversation'
});

// Define audit log relationships
AuditLog.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
AuditLog.belongsTo(Shop, { foreignKey: 'shop_id', as: 'shop' });

// Define Growth OS internal role relationships. These roles are separate from
// merchant user_shops roles and users.platform_role.
GrowthOsUserRole.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
GrowthOsUserRole.belongsTo(User, { foreignKey: 'granted_by', as: 'grantedBy' });
GrowthOsUserRole.belongsTo(User, { foreignKey: 'revoked_by', as: 'revokedBy' });
User.hasMany(GrowthOsUserRole, { foreignKey: 'user_id', as: 'growthOsRoles' });

// Define idempotency key relationships
IdempotencyKey.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
IdempotencyKey.belongsTo(Shop, { foreignKey: 'shop_id', as: 'shop' });

// Define delivery integration relationships
DeliveryIntegration.belongsTo(Shop, { foreignKey: 'shop_id', as: 'shop' });
Shop.hasMany(DeliveryIntegration, { foreignKey: 'shop_id', as: 'delivery_integrations' });

// Define delivery cost and areas
DeliveryCost.belongsTo(Shop, { foreignKey: 'shop_id', as: 'shop' });
Shop.hasMany(DeliveryCost, { foreignKey: 'shop_id', as: 'delivery_costs' });
KnownArea.belongsTo(Shop, { foreignKey: 'shop_id', as: 'shop' });
Shop.hasMany(KnownArea, { foreignKey: 'shop_id', as: 'known_areas' });
ShopPickupLocation.belongsTo(Shop, { foreignKey: 'shop_id', as: 'shop' });
Shop.hasMany(ShopPickupLocation, { foreignKey: 'shop_id', as: 'pickup_locations' });
DeliveryIntegration.belongsTo(ShopPickupLocation, { foreignKey: 'pickup_location_id', as: 'pickup_location' });
ShopPickupLocation.hasMany(DeliveryIntegration, { foreignKey: 'pickup_location_id', as: 'delivery_integrations' });

// Define payment config relationships
PaymentConfig.belongsTo(Shop, { foreignKey: 'shop_id', as: 'shop' });
Shop.hasMany(PaymentConfig, { foreignKey: 'shop_id', as: 'payment_configs' });

// Define subscription relationships
Subscription.belongsTo(Shop, { foreignKey: 'shop_id', as: 'shop' });
Shop.hasOne(Subscription, { foreignKey: 'shop_id', as: 'subscription' });

// Partner application — shop_id is nullable (public applicants), so no FK constraint.
PartnerApplication.belongsTo(Shop, { foreignKey: 'shop_id', as: 'shop', constraints: false });

// Define invoice relationships
Invoice.belongsTo(Subscription, { foreignKey: 'subscription_id', as: 'subscription' });
Invoice.belongsTo(Shop, { foreignKey: 'shop_id', as: 'shop' });
Subscription.hasMany(Invoice, { foreignKey: 'subscription_id', as: 'invoices' });
Shop.hasMany(Invoice, { foreignKey: 'shop_id', as: 'invoices' });

// ADR-0011 delivered-order ledger. tenant-scoped and invoice-linked.
BillingLine.belongsTo(Shop, { foreignKey: 'shop_id', as: 'shop' });
BillingLine.belongsTo(Order, { foreignKey: 'order_id', as: 'order' });
BillingLine.belongsTo(Subscription, { foreignKey: 'subscription_id', as: 'subscription' });
BillingLine.belongsTo(Invoice, { foreignKey: 'invoice_id', as: 'invoice' });
Shop.hasMany(BillingLine, { foreignKey: 'shop_id', as: 'billing_lines' });
Order.hasMany(BillingLine, { foreignKey: 'order_id', as: 'billing_lines' });
Invoice.hasMany(BillingLine, { foreignKey: 'invoice_id', as: 'billing_lines' });

// Define usage event relationships
UsageEvent.belongsTo(Shop, { foreignKey: 'shop_id', as: 'shop' });
Shop.hasMany(UsageEvent, { foreignKey: 'shop_id', as: 'usage_events' });

// Define keyword and faq relationships
Keyword.belongsTo(Shop, { foreignKey: 'shop_id', as: 'shop' });
Shop.hasMany(Keyword, { foreignKey: 'shop_id', as: 'keywords' });
FaqResponse.belongsTo(Shop, { foreignKey: 'shop_id', as: 'shop' });
Shop.hasMany(FaqResponse, { foreignKey: 'shop_id', as: 'faq_responses' });

// Define analytics relationships
Analytics.belongsTo(Shop, { foreignKey: 'shop_id', as: 'shop' });
Shop.hasMany(Analytics, { foreignKey: 'shop_id', as: 'analytics' });

// Define knowledge gap relationships
KnowledgeGap.belongsTo(Shop, { foreignKey: 'shop_id', as: 'shop' });
Shop.hasMany(KnowledgeGap, { foreignKey: 'shop_id', as: 'knowledge_gaps' });

// Define support ticket relationships
SupportTicket.belongsTo(Shop, { foreignKey: 'shop_id', as: 'shop' });
Shop.hasMany(SupportTicket, { foreignKey: 'shop_id', as: 'support_tickets' });

// Define response template relationships
ResponseTemplate.belongsTo(Shop, { foreignKey: 'shop_id', as: 'shop' });
Shop.hasMany(ResponseTemplate, { foreignKey: 'shop_id', as: 'response_templates' });

// Define customer preference relationships
CustomerPreference.belongsTo(Shop, { foreignKey: 'shop_id', as: 'shop' });
CustomerPreference.belongsTo(Customer, { foreignKey: 'customer_id', as: 'customer' });
Customer.hasOne(CustomerPreference, { foreignKey: 'customer_id', as: 'preference' });
Shop.hasMany(CustomerPreference, { foreignKey: 'shop_id', as: 'customer_preferences' });

// MW-V1 CRM Lite: staff-private notes bound to the shop-scoped customer
CustomerNote.belongsTo(Shop, { foreignKey: 'shop_id', as: 'shop' });
CustomerNote.belongsTo(Customer, { foreignKey: 'customer_id', as: 'customer' });
Customer.hasMany(CustomerNote, { foreignKey: 'customer_id', as: 'notes' });
Shop.hasMany(CustomerNote, { foreignKey: 'shop_id', as: 'customer_notes' });

// MW-V1 CRM Lite: merchant tags (vocabulary + assignments)
CustomerTag.belongsTo(Shop, { foreignKey: 'shop_id', as: 'shop' });
CustomerTagAssignment.belongsTo(Shop, { foreignKey: 'shop_id', as: 'shop' });
CustomerTagAssignment.belongsTo(CustomerTag, { foreignKey: 'tag_id', as: 'tag' });
CustomerTagAssignment.belongsTo(Customer, { foreignKey: 'customer_id', as: 'customer' });
Customer.hasMany(CustomerTagAssignment, { foreignKey: 'customer_id', as: 'tag_assignments' });

// TrxIDLog — MFS payment screenshot audit trail
TrxIDLog.belongsTo(Shop, { foreignKey: 'shop_id', as: 'shop' });
TrxIDLog.belongsTo(Order, { foreignKey: 'order_id', as: 'order' });
Shop.hasMany(TrxIDLog, { foreignKey: 'shop_id', as: 'trx_logs' });
Order.hasMany(TrxIDLog, { foreignKey: 'order_id', as: 'trx_logs' });

// Payment Transaction relationships
PaymentTransaction.belongsTo(Shop, { foreignKey: 'shop_id', as: 'shop' });
PaymentTransaction.belongsTo(Order, { foreignKey: 'order_id', as: 'order' });
Shop.hasMany(PaymentTransaction, { foreignKey: 'shop_id', as: 'payment_transactions' });
Order.hasMany(PaymentTransaction, { foreignKey: 'order_id', as: 'payment_transactions' });

// Owner Notification relationships
OwnerNotification.belongsTo(Shop, { foreignKey: 'shop_id', as: 'shop' });
Shop.hasMany(OwnerNotification, { foreignKey: 'shop_id', as: 'owner_notifications' });

// Order Invoice relationships
OrderInvoice.belongsTo(Shop, { foreignKey: 'shop_id', as: 'shop' });
OrderInvoice.belongsTo(Order, { foreignKey: 'order_id', as: 'order' });
Shop.hasMany(OrderInvoice, { foreignKey: 'shop_id', as: 'order_invoices' });
Order.hasMany(OrderInvoice, { foreignKey: 'order_id', as: 'invoices' });

// Delivery Tracking relationships
DeliveryTracking.belongsTo(Order, { foreignKey: 'order_id', as: 'order' });
Order.hasMany(DeliveryTracking, { foreignKey: 'order_id', as: 'delivery_tracking' });

// Durable courier booking claim/reconciliation state
CourierDispatch.belongsTo(Shop, { foreignKey: 'shop_id', as: 'shop' });
CourierDispatch.belongsTo(Order, { foreignKey: 'order_id', as: 'order' });
Shop.hasMany(CourierDispatch, { foreignKey: 'shop_id', as: 'courier_dispatches' });
Order.hasMany(CourierDispatch, { foreignKey: 'order_id', as: 'courier_dispatches' });

// Pilot intelligence relationships
Shop.hasOne(ShopPilotFeatures, { foreignKey: 'shop_id', as: 'pilot_features' });
ShopPilotFeatures.belongsTo(Shop, { foreignKey: 'shop_id', as: 'shop' });
Shop.hasMany(ShopAddon, { foreignKey: 'shop_id', as: 'addons', onDelete: 'CASCADE' });
ShopAddon.belongsTo(Shop, { foreignKey: 'shop_id', as: 'shop' });
ShopAddon.belongsTo(User, { foreignKey: 'enabled_by', as: 'enabledBy' });
Shop.hasMany(AiReplyShadowLedger, { foreignKey: 'shop_id', as: 'aiReplyShadowUsage' });
AiReplyShadowLedger.belongsTo(Shop, { foreignKey: 'shop_id', as: 'shop' });
Shop.hasMany(AdsStudioReport, { foreignKey: 'shop_id', as: 'adsStudioReports', onDelete: 'CASCADE' });
AdsStudioReport.belongsTo(Shop, { foreignKey: 'shop_id', as: 'shop' });
AdsStudioReport.belongsTo(User, { foreignKey: 'importer_user_id', as: 'importer', onDelete: 'RESTRICT', onUpdate: 'CASCADE' });
AdsStudioReport.hasMany(AdsStudioCampaignMetric, { foreignKey: 'report_id', as: 'campaignMetrics', onDelete: 'CASCADE' });
AdsStudioCampaignMetric.belongsTo(AdsStudioReport, { foreignKey: 'report_id', as: 'report' });
AdsStudioDraft.belongsTo(AdsStudioReport, { foreignKey: 'report_id', as: 'report', onDelete: 'RESTRICT', onUpdate: 'CASCADE' });
AdsStudioDraft.belongsTo(AdsStudioCampaignMetric, { foreignKey: 'campaign_metric_id', as: 'campaignMetric', onDelete: 'RESTRICT', onUpdate: 'CASCADE' });
AdsStudioDraft.belongsTo(User, { foreignKey: 'created_by', as: 'createdBy', onDelete: 'RESTRICT', onUpdate: 'CASCADE' });
AdsStudioDraft.belongsTo(User, { foreignKey: 'approved_by', as: 'approvedBy', onDelete: 'RESTRICT', onUpdate: 'CASCADE' });
Shop.hasOne(Storefront, { foreignKey: 'shop_id', as: 'storefront', onDelete: 'CASCADE' });
Storefront.belongsTo(Shop, { foreignKey: 'shop_id', as: 'shop' });
Storefront.hasMany(StorefrontProduct, { foreignKey: 'storefront_id', as: 'selectedProducts', onDelete: 'CASCADE' });
StorefrontProduct.belongsTo(Storefront, { foreignKey: 'storefront_id', as: 'storefront' });
StorefrontProduct.belongsTo(Product, { foreignKey: 'product_id', as: 'product' });
CustomerOpportunity.belongsTo(Customer, { foreignKey: 'customer_id', as: 'customer' });
Customer.hasMany(CustomerOpportunity, { foreignKey: 'customer_id', as: 'opportunities' });
OrderConfidence.belongsTo(Order, { foreignKey: 'order_id', as: 'order' });
Order.hasOne(OrderConfidence, { foreignKey: 'order_id', as: 'confidence' });

// Push Subscription relationships
PushSubscription.belongsTo(Shop, { foreignKey: 'shop_id', as: 'shop' });
Shop.hasMany(PushSubscription, { foreignKey: 'shop_id', as: 'push_subscriptions' });

// Telegram Notification Binding relationships
TelegramNotificationBinding.belongsTo(Shop, { foreignKey: 'shop_id', as: 'telegram_notification_binding' });
Shop.hasOne(TelegramNotificationBinding, { foreignKey: 'shop_id', as: 'telegram_notification_binding' });

// ── Phase 1: MetaChannel associations ──────────────────────────────────────
// Shop <-> MetaChannel (one shop, many authorized Pages)
Shop.hasMany(MetaChannel, {
    foreignKey: 'shop_id',
    as: 'metaChannels',
    onDelete: 'CASCADE'
});
MetaChannel.belongsTo(Shop, {
    foreignKey: 'shop_id',
    as: 'shop'
});

// Conversation <-> MetaChannel FK. Each conversation can be pinned to a
// specific Meta Page; null is retained only for legacy rows.
MetaChannel.hasMany(Conversation, {
    foreignKey: 'meta_channel_id',
    as: 'conversations',
    onDelete: 'SET NULL'
});
Conversation.belongsTo(MetaChannel, {
    foreignKey: 'meta_channel_id',
    as: 'metaChannel'
});

// MetaChannel <-> MetaChannelSettings (1:1)
MetaChannel.hasOne(MetaChannelSettings, {
    foreignKey: 'channel_id',
    as: 'settings',
    onDelete: 'CASCADE'
});
MetaChannelSettings.belongsTo(MetaChannel, {
    foreignKey: 'channel_id',
    as: 'channel'
});

// MetaChannel <-> MetaChannelConsentEvent (1:many, append-only)
MetaChannel.hasMany(MetaChannelConsentEvent, {
    foreignKey: 'channel_id',
    as: 'consentEvents',
    onDelete: 'CASCADE'
});
MetaChannelConsentEvent.belongsTo(MetaChannel, {
    foreignKey: 'channel_id',
    as: 'channel'
});

// Customer <-> MetaChannelConsentEvent (1:many)
Customer.hasMany(MetaChannelConsentEvent, {
    foreignKey: 'customer_id',
    as: 'consentEvents',
    onDelete: 'SET NULL'
});
MetaChannelConsentEvent.belongsTo(Customer, {
    foreignKey: 'customer_id',
    as: 'customer'
});

// OAuth-captured app-scoped <-> Page-scoped identity bridge.
MetaChannel.hasMany(MetaUserIdentity, {
    foreignKey: 'channel_id',
    as: 'userIdentities',
    onDelete: 'CASCADE',
});
MetaUserIdentity.belongsTo(MetaChannel, {
    foreignKey: 'channel_id',
    as: 'channel',
});
Shop.hasMany(MetaUserIdentity, {
    foreignKey: 'shop_id',
    as: 'metaUserIdentities',
    onDelete: 'CASCADE',
});
MetaUserIdentity.belongsTo(Shop, {
    foreignKey: 'shop_id',
    as: 'shop',
});
User.hasMany(MetaUserIdentity, {
    foreignKey: 'internal_user_id',
    as: 'metaUserIdentities',
    onDelete: 'SET NULL',
});
MetaUserIdentity.belongsTo(User, {
    foreignKey: 'internal_user_id',
    as: 'internalUser',
});

// Export entities
module.exports = {
    User,
    Tenant,
    Shop,
    UserShop,
    Session,
    Category,
    Product,
    ProductVariant,
    Customer,
    Order,
    OrderReturn,
    PartnerBillingAdjustment,
    // ADR-0011 name for the same credit ledger; the table keeps its historical
    // partner_billing_adjustments name for existing rows.
    BillingAdjustment: PartnerBillingAdjustment,
    BillingLine,
    OrderItem,
    Conversation,
    Message,
    InboxDeliveryOutbox,
    ConversationTurn,
    AuditLog,
    IdempotencyKey,
    DeliveryIntegration,
    DeliveryCost,
    KnownArea,
    ShopPickupLocation,
    PaymentConfig,
    Subscription,
    Invoice,
    BillingLine,
    PartnerApplication,
    UsageEvent,
    Keyword,
    FaqResponse,
    BanglishDictionary,
    Analytics,
    KnowledgeGap,
    SupportTicket,
    ResponseTemplate,
    CustomerPreference,
    CustomerNote,
    CustomerTag,
    CustomerTagAssignment,
    TrxIDLog,
    PaymentTransaction,
    OwnerNotification,
    OrderInvoice,
    DeliveryTracking,
    CourierDispatch,
    PushSubscription,
    TelegramNotificationBinding,
    PasswordResetToken,
    CustomerDeliveryStats,
    CourierCodCollection,
    ReconciliationDispute,
    GrowthOsUserRole,
    ShopPilotFeatures,
    ShopAddon,
    AiReplyShadowLedger,
    AdsStudioReport,
    AdsStudioCampaignMetric,
    AdsStudioDraft,
    Storefront,
    StorefrontProduct,
    CustomerOpportunity,
    OrderConfidence,
    // Phase 1 — Meta Integration Redesign
    MetaChannel,
    MetaChannelSettings,
    MetaChannelConsentEvent,
    MetaUserIdentity,
    MetaDataDeletionRequest,
    MetaWebhookReceipt,
    PolicyDecision,
};

Object.defineProperties(module.exports, {
    GrowthOsProspect: {
        enumerable: true,
        get: () => loadGrowthOsProspectEntities().GrowthOsProspect,
    },
    GrowthOsProspectEvent: {
        enumerable: true,
        get: () => loadGrowthOsProspectEntities().GrowthOsProspectEvent,
    },
    GrowthOsFollowup: {
        enumerable: true,
        get: () => loadGrowthOsProspectEntities().GrowthOsFollowup,
    },
    GrowthOsNote: {
        enumerable: true,
        get: () => loadGrowthOsProspectEntities().GrowthOsNote,
    },
});
