import { lazy, createElement, Suspense, type ComponentType, type LazyExoticComponent } from "react";
import { createBrowserRouter, redirect } from "react-router-dom";
import { authService } from "./lib/auth";
import { hasSeparateProductOrigins, isMarketingSurface } from "./lib/config";
import { getSignupSuccessPath } from "./lib/signupIntent";
import { readStoredLanguage } from "@/i18n/language";
import { AdminRoute } from "@/shared/components/guards";
import { PlatformAdminRoute } from "@/shared/components/guards/PlatformAdminRoute";
import PageLoader from "./components/PageLoader";

const DashboardLayout = lazy(() => import("./components/DashboardLayout"));
const Dashboard = lazy(() => import("./components/Dashboard"));
const UnifiedInbox = lazy(() => import("./components/UnifiedInbox"));
const OAuthCallbackPage = lazy(() => import("./components/OAuthCallbackPage"));
const Products = lazy(() => import("./components/Products"));
const Orders = lazy(() => import("./components/Orders"));
const Reports = lazy(() => import("./components/Reports"));
const AuditLogs = lazy(() => import("./components/AuditLogs"));
const AddProduct = lazy(() => import("./components/AddProduct"));
const ProductDetails = lazy(() => import("./components/ProductDetails"));
const Customers = lazy(() => import("./components/Customers"));
const CustomerDetailPage = lazy(() => import("./components/customers/CustomerDetailPage"));
const Categories = lazy(() => import("./components/Categories"));
const CategoryDetails = lazy(() => import("./components/CategoryDetails"));
const SubcategoryDetails = lazy(() => import("./components/SubcategoryDetails"));
const ManageShop = lazy(() => import("./components/ManageShop"));
const SettingsHub = lazy(() => import("./components/SettingsHub"));
const ChatSettings = lazy(() => import("./components/ChatSettings"));
const DeliverySettings = lazy(() => import("./components/DeliverySettings"));
const PaymentSettings = lazy(() => import("./components/PaymentSettings"));
const NotificationSettings = lazy(() => import("./components/NotificationSettings"));
const BusinessInfoSettings = lazy(() => import("./components/BusinessInfoSettings"));
const FaqSettings = lazy(() => import("./components/FaqSettings"));
const SignIn = lazy(() => import("./components/SignIn"));
const Signup = lazy(() => import("./components/Signup"));
const ForgotPassword = lazy(() => import("./components/ForgotPassword"));
const ResetPassword = lazy(() => import("./components/ResetPassword"));
const TwoFactorVerify = lazy(() => import("./components/TwoFactorVerify"));
const RouteError = lazy(() => import("./components/RouteError"));
const Subscription = lazy(() => import("./components/Subscription"));
const Addons = lazy(() => import("./components/Addons"));
const AdsStudioPage = lazy(() => import("./components/ads-studio/AdsStudioPage"));
const StorefrontManager = lazy(() => import("./components/storefront/StorefrontManager"));
const StorefrontBuyer = lazy(() => import("./components/storefront/StorefrontBuyer"));
const PrivacyPolicy = lazy(() => import("./components/PrivacyPolicy"));
const TermsOfService = lazy(() => import("./components/TermsOfService"));
const DataDeletion = lazy(() => import("./components/DataDeletion"));
const LandingPage = lazy(() => import("./components/LandingPage"));
const Pricing = lazy(() => import("./components/Pricing"));
const UsersPage = lazy(() => import("./features/users/components/UsersPage"));

// Phase 1 — EasyModerator operations admin panel (platform-admin only)
const AdminLayout = lazy(() => import("./components/admin/AdminLayout"));
const AdminDashboard = lazy(() => import("./components/admin/AdminDashboard"));
const AdminShops = lazy(() => import("./components/admin/AdminShops"));
const AdminShopDetail = lazy(() => import("./components/admin/AdminShopDetail"));
const AdminAuditLogs = lazy(() => import("./components/admin/AdminAuditLogs"));

const NotFound = lazy(() => import("./components/NotFound"));

// Loader function to check authentication
async function protectedLoader() {
	await authService.ensureInitialized();
	if (!authService.isAuthenticated()) {
		return redirect("/signin");
	}
	return null;
}

async function publicLoader() {
	await authService.ensureInitialized();
	if (authService.isAuthenticated()) {
		return redirect("/dashboard");
	}
	return null;
}

async function signupLoader({ request }: { request: Request }) {
	await authService.ensureInitialized();
	if (!authService.isAuthenticated()) return null;

	return redirect(getSignupSuccessPath(new URL(request.url).searchParams, readStoredLanguage() ?? "bn"));
}

async function rootLoader() {
	// A single localhost origin still serves the marketing homepage during
	// development. In production, the app hostname owns `/`, so authenticated
	// merchants go straight to the dashboard and everyone else goes to sign-in.
	if (!hasSeparateProductOrigins() || isMarketingSurface()) return null;
	await authService.ensureInitialized();
	return redirect(authService.isAuthenticated() ? "/dashboard" : "/signin");
}

function legacyAppPathLoader({ request }: { request: Request }) {
	const url = new URL(request.url);
	const cleanPath = url.pathname === "/app"
		? "/dashboard"
		: url.pathname === "/app/admin/users"
			? "/team/users"
			: url.pathname.replace(/^\/app(?=\/)/, "");
	return redirect(`${cleanPath}${url.search}`);
}

type RoutableComponent<P extends object = Record<string, never>> =
	ComponentType<P> | LazyExoticComponent<ComponentType<P>>;

const withSuspense = <P extends object>(Component: RoutableComponent<P>) => (props: P) =>
	createElement(
		Suspense,
		{ fallback: createElement(PageLoader) },
		createElement(Component as ComponentType<P>, props)
	);

export const router = createBrowserRouter([
	{
		path: "/signin",
		Component: withSuspense(SignIn),
		loader: publicLoader,
		errorElement: createElement(RouteError),
	},
	{
		// No publicLoader guard — the user arrives here mid-login (not yet authenticated).
		// The component itself guards against direct navigation by checking pendingTwoFactor.
		path: "/2fa-verify",
		Component: withSuspense(TwoFactorVerify),
		errorElement: createElement(RouteError),
	},
	{
		path: "/forgot-password",
		Component: withSuspense(ForgotPassword),
		loader: publicLoader,
		errorElement: createElement(RouteError),
	},
	{
		path: "/reset-password",
		Component: withSuspense(ResetPassword),
		loader: publicLoader,
		errorElement: createElement(RouteError),
	},
	{
		path: "/privacy-policy",
		Component: withSuspense(PrivacyPolicy),
		errorElement: createElement(RouteError),
	},
	{
		path: "/terms",
		Component: withSuspense(TermsOfService),
		errorElement: createElement(RouteError),
	},
	{
		path: "/data-deletion",
		Component: withSuspense(DataDeletion),
		errorElement: createElement(RouteError),
	},
	{
		path: "/pricing",
		Component: withSuspense(Pricing),
		errorElement: createElement(RouteError),
	},
	{
		// Buyer-facing storefront: public like /pricing. The backend enforces
		// publication, tenant gating and checkout validation server-side.
		path: "/store/:slug",
		Component: withSuspense(StorefrontBuyer),
		errorElement: createElement(RouteError),
	},
	{
		path: "/",
		Component: withSuspense(LandingPage),
		loader: rootLoader,
		errorElement: createElement(RouteError),
	},
	{
		path: "/signup",
		Component: withSuspense(Signup),
		loader: signupLoader,
		errorElement: createElement(RouteError),
	},
	{
		// Standalone — must NOT be inside DashboardLayout so the popup loads only the
		// spinner + postMessage handler, not the full authenticated app shell.
		path: "/channels/oauth-callback",
		Component: withSuspense(OAuthCallbackPage),
	},
	{
		Component: withSuspense(DashboardLayout),
		loader: protectedLoader,
		errorElement: createElement(RouteError),
		children: [
			{ path: "/dashboard", Component: withSuspense(Dashboard) },
			{ path: "/inbox", Component: withSuspense(UnifiedInbox) },
			{ path: "/channels", loader: () => redirect("/manage-shop/chat-settings") },
			{
				path: "/manage-shop",
				Component: withSuspense(ManageShop),
				children: [
					{ index: true, Component: withSuspense(SettingsHub) },
					{ path: "business-info", Component: withSuspense(BusinessInfoSettings) },
					{ path: "chat-settings", Component: withSuspense(ChatSettings) },
					{ path: "delivery-settings", Component: withSuspense(DeliverySettings) },
					{ path: "payment-settings", Component: withSuspense(PaymentSettings) },
					{ path: "notifications", Component: withSuspense(NotificationSettings) },
					{ path: "faqs", Component: withSuspense(FaqSettings) },
				],
			},
			{ path: "/products", Component: withSuspense(Products) },
			{ path: "/products/add", Component: withSuspense(AddProduct) },
			{ path: "/products/:productId", Component: withSuspense(ProductDetails) },
			{ path: "/products/:productId/edit", Component: withSuspense(AddProduct) },
			{ path: "/categories", Component: withSuspense(Categories) },
			{ path: "/categories/create", Component: withSuspense(CategoryDetails) },
			{ path: "/categories/:categoryId", Component: withSuspense(CategoryDetails) },
			{ path: "/categories/:categoryId/edit", Component: withSuspense(CategoryDetails) },
			{ path: "/categories/:categoryId/:subcategoryId", Component: withSuspense(SubcategoryDetails) },
			{ path: "/orders", Component: withSuspense(Orders) },
			{ path: "/customers", Component: withSuspense(Customers) },
			{ path: "/customers/:customerId", Component: withSuspense(CustomerDetailPage) },
			{ path: "/knowledge", loader: () => redirect("/manage-shop/faqs") },
			{ path: "/reports", Component: withSuspense(Reports) },
			{ path: "/audit-logs", Component: withSuspense(AuditLogs) },
			{ path: "/subscription", Component: withSuspense(Subscription) },
			{ path: "/addons", Component: withSuspense(Addons) },
			{ path: "/addons/ads-studio", Component: withSuspense(AdsStudioPage) },
			{ path: "/addons/storefront", Component: withSuspense(StorefrontManager) },
			{ path: "/more", loader: () => redirect("/dashboard") },
			{
				path: "/team/users",
				Component: withSuspense((props: Record<string, never>) =>
					createElement(AdminRoute, null, createElement(UsersPage, props))
				),
			},
		],
	},
	{
		path: "/settings/channels",
		loader: () => redirect("/manage-shop/chat-settings"),
	},
	{
		path: "/app",
		loader: legacyAppPathLoader,
	},
	{
		path: "/app/*",
		loader: legacyAppPathLoader,
	},
	{
		// EasyModerator operations admin panel. Must be logged in (protectedLoader)
		// AND hold a platform_role (PlatformAdminRoute). Backend requirePlatformAdmin
		// is the real authority; this guard is UX only.
		path: "/admin",
		loader: protectedLoader,
		errorElement: createElement(RouteError),
		Component: withSuspense((props: Record<string, never>) =>
			createElement(PlatformAdminRoute, null, createElement(AdminLayout, props))
		),
		children: [
			{ index: true, Component: withSuspense(AdminDashboard) },
			{ path: "shops", Component: withSuspense(AdminShops) },
			{ path: "shops/:shopId", Component: withSuspense(AdminShopDetail) },
			{ path: "audit-logs", Component: withSuspense(AdminAuditLogs) },
		],
	},
	{
		path: "*",
		Component: withSuspense(NotFound),
	},
]);
