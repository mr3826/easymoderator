import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Building2, MessagesSquare, Bot, Truck, CreditCard, ChevronRight, Bell, BookOpen } from "lucide-react";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light focus-visible:transition-none";

const items = [
  {
    nameKey: 'manageShop.hub.businessInfo.name',
    descKey: 'manageShop.hub.businessInfo.desc',
    path: '/manage-shop/business-info',
    icon: Building2,
  },
  {
    nameKey: 'manageShop.hub.channels.name',
    descKey: 'manageShop.hub.channels.desc',
    path: '/manage-shop/channels',
    icon: MessagesSquare,
  },
  {
    nameKey: 'manageShop.hub.automation.name',
    descKey: 'manageShop.hub.automation.desc',
    path: '/manage-shop/automation',
    icon: Bot,
  },
  {
    nameKey: 'manageShop.hub.deliverySettings.name',
    descKey: 'manageShop.hub.deliverySettings.desc',
    path: '/manage-shop/delivery-settings',
    icon: Truck,
  },
  {
    nameKey: 'manageShop.hub.paymentSettings.name',
    descKey: 'manageShop.hub.paymentSettings.desc',
    path: '/manage-shop/payment-settings',
    icon: CreditCard,
  },
  {
    nameKey: 'manageShop.hub.notifications.name',
    descKey: 'manageShop.hub.notifications.desc',
    path: '/manage-shop/notifications',
    icon: Bell,
  },
  {
    nameKey: 'manageShop.hub.faqs.name',
    descKey: 'manageShop.hub.faqs.desc',
    path: '/manage-shop/faqs',
    icon: BookOpen,
  },
  {
    nameKey: 'manageShop.hub.subscription.name',
    descKey: 'manageShop.hub.subscription.desc',
    path: '/subscription',
    icon: CreditCard,
  },
];

export default function SettingsHub() {
  const { t } = useTranslation();
  return (
    <div className="p-4 md:p-8 max-w-3xl">
      <div className="mb-6">
        <h1 className="text-xl md:text-2xl font-semibold text-em-text-primary">{t('manageShop.hub.title')}</h1>
        <p className="text-sm text-em-text-secondary mt-1">{t('manageShop.hub.subtitle')}</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <Link
              key={item.path}
              to={item.path}
              className={`flex min-h-11 items-center gap-4 bg-em-bg-surface border border-em-border rounded-xl p-4 hover:border-em-violet-300 hover:bg-em-violet-50/40 transition-colors group ${FOCUS_RING}`}
            >
              <div className="w-11 h-11 rounded-lg flex items-center justify-center shrink-0 bg-em-violet-50 text-em-violet-700">
                <Icon className="w-5 h-5" aria-hidden="true" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-em-text-primary">{t(item.nameKey)}</div>
                <div className="text-xs text-em-text-secondary mt-0.5 truncate">{t(item.descKey)}</div>
              </div>
              <ChevronRight className="w-4 h-4 text-em-text-secondary group-hover:text-em-violet-700 shrink-0" aria-hidden="true" />
            </Link>
          );
        })}
      </div>
    </div>
  );
}
