import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Building2, MessagesSquare, Bot, Truck, CreditCard, ChevronRight, Bell, BookOpen } from "lucide-react";

const items = [
  {
    nameKey: 'manageShop.hub.businessInfo.name',
    descKey: 'manageShop.hub.businessInfo.desc',
    path: '/manage-shop/business-info',
    icon: Building2,
    color: 'text-blue-600 bg-blue-50',
  },
  {
    nameKey: 'manageShop.hub.channels.name',
    descKey: 'manageShop.hub.channels.desc',
    path: '/manage-shop/channels',
    icon: MessagesSquare,
    color: 'text-purple-600 bg-purple-50',
  },
  {
    nameKey: 'manageShop.hub.automation.name',
    descKey: 'manageShop.hub.automation.desc',
    path: '/manage-shop/automation',
    icon: Bot,
    color: 'text-violet-700 bg-violet-50',
  },
  {
    nameKey: 'manageShop.hub.deliverySettings.name',
    descKey: 'manageShop.hub.deliverySettings.desc',
    path: '/manage-shop/delivery-settings',
    icon: Truck,
    color: 'text-emerald-600 bg-emerald-50',
  },
  {
    nameKey: 'manageShop.hub.paymentSettings.name',
    descKey: 'manageShop.hub.paymentSettings.desc',
    path: '/manage-shop/payment-settings',
    icon: CreditCard,
    color: 'text-amber-600 bg-amber-50',
  },
  {
    nameKey: 'manageShop.hub.notifications.name',
    descKey: 'manageShop.hub.notifications.desc',
    path: '/manage-shop/notifications',
    icon: Bell,
    color: 'text-cyan-700 bg-cyan-50',
  },
  {
    nameKey: 'manageShop.hub.faqs.name',
    descKey: 'manageShop.hub.faqs.desc',
    path: '/manage-shop/faqs',
    icon: BookOpen,
    color: 'text-green-700 bg-green-50',
  },
  {
    nameKey: 'manageShop.hub.subscription.name',
    descKey: 'manageShop.hub.subscription.desc',
    path: '/subscription',
    icon: CreditCard,
    color: 'text-rose-600 bg-rose-50',
  },
];

export default function SettingsHub() {
  const { t } = useTranslation();
  return (
    <div className="p-4 md:p-8 max-w-3xl">
      <div className="mb-6">
        <h1 className="text-xl md:text-2xl font-bold text-gray-900">{t('manageShop.hub.title')}</h1>
        <p className="text-sm text-gray-500 mt-1">{t('manageShop.hub.subtitle')}</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <Link
              key={item.path}
              to={item.path}
              className="flex items-center gap-4 bg-white border border-gray-200 rounded-xl p-4 hover:border-blue-300 hover:shadow-sm transition-all group"
            >
              <div className={`w-11 h-11 rounded-lg flex items-center justify-center shrink-0 ${item.color}`}>
                <Icon className="w-5 h-5" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-gray-900">{t(item.nameKey)}</div>
                <div className="text-xs text-gray-500 mt-0.5 truncate">{t(item.descKey)}</div>
              </div>
              <ChevronRight className="w-4 h-4 text-gray-400 group-hover:text-blue-500 shrink-0" />
            </Link>
          );
        })}
      </div>
    </div>
  );
}
