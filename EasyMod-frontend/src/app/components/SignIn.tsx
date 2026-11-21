import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Eye, EyeOff } from "lucide-react";
import { Input } from "@/app/components/ui/input";
import { Button } from "@/app/components/ui/button";
import { useAuth } from "@/features/auth/AuthProvider";
import { createSigninSchema, type SigninFormData, type SigninFormInput } from "@/features/auth/validation/schemas";
import { getErrorMessage } from "@shared/lib/http/errors";
import { PublicFunnelAuthLayout } from "./PublicFunnelAuthLayout";
import Seo from "./Seo";
import "./public-funnel.css";
import "./landing-v6.css";

export default function SignIn() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { signin } = useAuth();
  const [showPassword, setShowPassword] = useState(false);
  const schema = useMemo(() => createSigninSchema({
    emailRequired: t("publicFunnel.validation.emailRequired"),
    emailInvalid: t("publicFunnel.validation.emailInvalid"),
    passwordRequired: t("publicFunnel.validation.passwordRequired"),
  }), [t]);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<SigninFormInput, unknown, SigninFormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      email: "",
      password: "",
    },
  });

  const onSubmit = async (data: SigninFormData) => {
    try {
      await signin({ email: data.email.trim().toLowerCase(), password: data.password });
      navigate("/dashboard");
    } catch (err: any) {
      // Preserve the auth provider's pending-token path for required 2FA.
      if (err?.code === "REQUIRES_2FA") {
        navigate("/2fa-verify");
        return;
      }
      setError("root", {
        message: getErrorMessage(err, t("auth.signin.errors.invalidCredentials")),
      });
    }
  };

  return (
    <>
      <Seo
        title={t("publicFunnel.meta.authTitle")}
        description={t("publicFunnel.meta.authDescription")}
        canonicalPath="/signin"
        canonicalBase="app"
        noIndex
      />
      <PublicFunnelAuthLayout
        mode="signin"
        title={t("publicFunnel.auth.signInTitle")}
        description={t("publicFunnel.auth.signInSubtitle")}
        panelTitle={t("publicFunnel.auth.signInPanelTitle")}
        panelBody={t("publicFunnel.auth.signInPanelBody")}
      >
        <div className="auth-v6-form-card">
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
            {errors.root && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{errors.root.message}</div>}

            <div>
              <label htmlFor="email" className="mb-1.5 block text-sm font-semibold text-[#17223B]">{t("publicFunnel.auth.email")}</label>
              <Input
                {...register("email")}
                id="email"
                type="email"
                autoComplete="email"
                disabled={isSubmitting}
                aria-required="true"
                aria-invalid={errors.email ? true : undefined}
                aria-describedby={errors.email ? "signin-email-error" : undefined}
                placeholder={t("publicFunnel.auth.emailPlaceholder")}
                className="h-12 rounded-xl border-[#17223B]/20 focus-visible:ring-[#7460D9]"
              />
              {errors.email && <p id="signin-email-error" role="alert" className="mt-1.5 text-xs text-red-700">{errors.email.message}</p>}
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <label htmlFor="password" className="block text-sm font-semibold text-[#17223B]">{t("publicFunnel.auth.password")}</label>
                <Link to="/forgot-password" className="text-sm font-semibold text-[#5D49BB] hover:underline">{t("publicFunnel.auth.forgotPassword")}</Link>
              </div>
              <div className="relative">
                <Input
                  {...register("password")}
                  id="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  disabled={isSubmitting}
                  aria-required="true"
                  aria-invalid={errors.password ? true : undefined}
                  aria-describedby={errors.password ? "signin-password-error" : undefined}
                  placeholder={t("publicFunnel.auth.passwordPlaceholder")}
                  className="h-12 rounded-xl border-[#17223B]/20 pr-12 focus-visible:ring-[#7460D9]"
                />
                <button
                  type="button"
                  className="absolute right-2 top-1/2 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-[#39445F] hover:bg-[#E8E4FF]"
                  onClick={() => setShowPassword((visible) => !visible)}
                  aria-label={t(showPassword ? "publicFunnel.auth.hidePassword" : "publicFunnel.auth.showPassword")}
                  aria-pressed={showPassword}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
                </button>
              </div>
              {errors.password && <p id="signin-password-error" role="alert" className="mt-1.5 text-xs text-red-700">{errors.password.message}</p>}
            </div>

            <Button type="submit" disabled={isSubmitting} className="funnel-button funnel-button-primary h-12 w-full justify-center text-base">
              {isSubmitting ? t("publicFunnel.auth.signingIn") : t("publicFunnel.auth.signInButton")}
            </Button>
          </form>

          <p className="auth-v6-switch-inline">
            {t("publicFunnel.auth.noAccount")} {" "}
            <Link to="/signup">{t("publicFunnel.auth.createAccount")}</Link>
          </p>
        </div>
      </PublicFunnelAuthLayout>
    </>
  );
}
