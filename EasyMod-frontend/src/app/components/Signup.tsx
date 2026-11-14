import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Checkbox } from "./ui/checkbox";
import { useAuth } from "@/features/auth/AuthProvider";
import { BDPhoneInput } from "@/shared/components/BDPhoneInput";
import { PublicFunnelAuthLayout } from "./PublicFunnelAuthLayout";
import { createSignupSchema, type SignupFormData } from "@/features/auth/validation/schemas";
import { PasswordStrengthMeter } from "@/features/auth/components/PasswordStrengthMeter";
import { trackFunnelEvent } from "@/app/lib/funnel";
import { getErrorMessage } from "@shared/lib/http/errors";
import { buildMarketingUrlWithLocale } from "@/app/lib/config";
import { getSignupSuccessPath } from "@/app/lib/signupIntent";
import { useCommercialContract } from "@/api/domains/commercialContract";
import { formatBdt, formatBdtBn } from "@/shared/contracts/commercial-contract";
import Seo from "./Seo";
import "./public-funnel.css";
import "./landing-v6.css";

export default function Signup() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { t, i18n } = useTranslation();
  const { signup } = useAuth();
  const locale = i18n.resolvedLanguage || i18n.language;
  const isBangla = locale.toLowerCase().startsWith("bn");
  const contractQuery = useCommercialContract();
  const contract = contractQuery.data;
  const unitPrice = contract
    ? (isBangla ? formatBdtBn(contract.unit_price_minor) : formatBdt(contract.unit_price_minor))
    : null;
  const [showPassword, setShowPassword] = useState(false);
  const signupInFlight = useRef(false);
  const schema = useMemo(() => createSignupSchema({
    nameMin: t("publicFunnel.validation.nameMin"),
    nameMax: t("publicFunnel.validation.nameMax"),
    emailRequired: t("publicFunnel.validation.emailRequired"),
    emailInvalid: t("publicFunnel.validation.emailInvalid"),
    phoneRequired: t("publicFunnel.validation.phoneRequired"),
    phoneInvalid: t("publicFunnel.validation.phoneInvalid"),
    passwordRequired: t("publicFunnel.validation.passwordRequired"),
    passwordMin: t("publicFunnel.validation.passwordMin"),
    passwordUppercase: t("publicFunnel.validation.passwordUppercase"),
    passwordLowercase: t("publicFunnel.validation.passwordLowercase"),
    passwordDigit: t("publicFunnel.validation.passwordDigit"),
    passwordSpecial: t("publicFunnel.validation.passwordSpecial"),
    termsRequired: t("publicFunnel.validation.termsRequired"),
  }), [t]);

  const form = useForm<SignupFormData>({
    resolver: zodResolver(schema),
    defaultValues: { fullName: "", email: "", phone: "", password: "", acceptedTerms: false },
  });
  const { register, handleSubmit, setError, clearErrors, watch, control, formState: { errors, isSubmitting } } = form;
  const passwordValue = watch("password");
  const acceptedTerms = watch("acceptedTerms");

  useEffect(() => {
    trackFunnelEvent("signup_started", { surface: "signup" }, { onceKey: "signup_started" });
  }, []);

  const onSubmit = async (data: SignupFormData) => {
    if (!data.acceptedTerms) {
      setError("acceptedTerms", { type: "validate", message: t("publicFunnel.validation.termsRequired") });
      return;
    }
    signupInFlight.current = true;
    try {
      await signup({
        email: data.email,
        password: data.password,
        full_name: data.fullName,
        phone: data.phone.trim(),
        accepted_terms: true,
      });
      navigate(getSignupSuccessPath(searchParams, locale));
    } catch (error: unknown) {
      setError("root", { message: getErrorMessage(error, t("publicFunnel.auth.signUpError")) });
    } finally {
      signupInFlight.current = false;
    }
  };

  const onInvalid = () => {
    signupInFlight.current = false;
    if (!form.getValues("acceptedTerms")) {
      setError("acceptedTerms", { type: "validate", message: t("publicFunnel.validation.termsRequired") });
    }
  };

  const onFormSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (signupInFlight.current) return;
    signupInFlight.current = true;
    void handleSubmit(onSubmit, onInvalid)(event).catch(() => { signupInFlight.current = false; });
  };

  return (
    <>
      <Seo
        title={t("publicFunnel.meta.authTitle")}
        description={t("publicFunnel.meta.authDescription")}
        canonicalPath="/signup"
        canonicalBase="app"
        noIndex
      />
      <PublicFunnelAuthLayout
        mode="signup"
        title={t("publicFunnel.auth.signUpTitle")}
        description={t("publicFunnel.auth.signUpSubtitle")}
        panelTitle={t("publicFunnel.auth.signUpPanelTitle")}
        panelBody={t("publicFunnel.auth.signUpPanelBody")}
      >
        <section className="auth-v6-form-card" aria-labelledby="signup-form-title">
          <h2 id="signup-form-title">{t("publicFunnel.auth.createAccountHeading")}</h2>
          <div className="auth-v6-shuru-summary">
            <strong>{t("publicFunnel.auth.shuruPlanLabel")}</strong>
            <span>{t("publicFunnel.auth.newAccountsStartOnShuru")}</span>
            {unitPrice && (
              <span data-contract-version={contract?.contract_version}>
                {t("publicFunnel.auth.startingPrice", { unitPrice })}
              </span>
            )}
            <span>{t("publicFunnel.auth.noPaidSubscriptionOnSignup")}</span>
            <span>{t("publicFunnel.auth.signupNextStep")}</span>
            <a href={buildMarketingUrlWithLocale("/pricing", locale)} className="mt-1 inline-flex w-fit text-sm font-bold text-[#4C3DA8] underline underline-offset-4">
              {t("publicFunnel.landing.viewPricing")}
            </a>
          </div>

          {errors.root && <div role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{errors.root.message}</div>}

          <form onSubmit={onFormSubmit} className="space-y-4">
            <div>
              <label htmlFor="fullName" className="mb-1.5 block text-sm font-semibold text-[#17223B]">{t("publicFunnel.auth.yourName")}</label>
              <Input
                {...register("fullName")}
                id="fullName"
                autoComplete="name"
                disabled={isSubmitting}
                aria-required="true"
                aria-invalid={errors.fullName ? true : undefined}
                aria-describedby={errors.fullName ? "name-error" : "name-guidance"}
                placeholder={t("publicFunnel.auth.yourNamePlaceholder")}
                className="h-12 rounded-xl border-[#17223B]/20 focus-visible:ring-[#7460D9]"
              />
              <p id="name-guidance" className="auth-v6-helper-note">{t("publicFunnel.auth.nameHelper")}</p>
              {errors.fullName && <p id="name-error" role="alert" className="mt-1.5 text-xs text-red-700">{errors.fullName.message}</p>}
            </div>

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
                aria-describedby={errors.email ? "email-error" : undefined}
                placeholder={t("publicFunnel.auth.emailPlaceholder")}
                className="h-12 rounded-xl border-[#17223B]/20 focus-visible:ring-[#7460D9]"
              />
              {errors.email && <p id="email-error" role="alert" className="mt-1.5 text-xs text-red-700">{errors.email.message}</p>}
            </div>

            <div>
              <Controller
                name="phone"
                control={control}
                render={({ field }) => (
                  <BDPhoneInput
                    id="phone"
                    label={t("publicFunnel.auth.phone")}
                    required
                    value={field.value ?? ""}
                    onChange={field.onChange}
                    disabled={isSubmitting}
                    error={errors.phone?.message}
                    placeholder={t("publicFunnel.auth.phonePlaceholder")}
                    className="[&_div]:h-12 [&_div]:rounded-xl [&_label]:mb-1.5 [&_label]:block [&_label]:text-sm [&_label]:font-semibold [&_label]:text-[#17223B]"
                  />
                )}
              />
            </div>

            <div>
              <label htmlFor="password" className="mb-1.5 block text-sm font-semibold text-[#17223B]">{t("publicFunnel.auth.password")}</label>
              <div className="relative">
                <Input
                  {...register("password")}
                  id="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  disabled={isSubmitting}
                  aria-required="true"
                  aria-invalid={errors.password ? true : undefined}
                  aria-describedby={errors.password ? "password-rules password-error" : "password-rules"}
                  placeholder={t("publicFunnel.auth.passwordPlaceholder")}
                  className="h-12 rounded-xl border-[#17223B]/20 pr-12 focus-visible:ring-[#7460D9]"
                />
                <button type="button" className="absolute right-2 top-1/2 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-[#39445F] hover:bg-[#E8E4FF]" onClick={() => setShowPassword((visible) => !visible)} aria-label={t(showPassword ? "publicFunnel.auth.hidePassword" : "publicFunnel.auth.showPassword")} aria-pressed={showPassword}>
                  {showPassword ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
                </button>
              </div>
              <p id="password-rules" className="auth-v6-helper-note"><strong>{t("publicFunnel.auth.passwordRulesTitle")}:</strong> {t("publicFunnel.auth.passwordRules")}</p>
              {errors.password && <p id="password-error" role="alert" className="mt-1.5 text-xs text-red-700">{errors.password.message}</p>}
              <PasswordStrengthMeter password={passwordValue || ""} />
            </div>

            <div>
              <div className="flex items-start gap-3">
                <Controller
                  control={control}
                  name="acceptedTerms"
                  render={({ field }) => (
                    <Checkbox
                      id="acceptedTerms"
                      checked={field.value}
                      onCheckedChange={(value) => {
                        const accepted = value === true;
                        field.onChange(accepted);
                        if (accepted) clearErrors("acceptedTerms");
                      }}
                      disabled={isSubmitting}
                      aria-required="true"
                      aria-invalid={errors.acceptedTerms ? true : undefined}
                      aria-describedby={errors.acceptedTerms ? "terms-guidance terms-error" : "terms-guidance"}
                      className="mt-0.5"
                    />
                  )}
                />
                <label htmlFor="acceptedTerms" className="text-xs leading-5 text-[#17223B]/75">
                  {t("publicFunnel.auth.termsPrefix")} {" "}
                  <a href={buildMarketingUrlWithLocale("/privacy-policy", locale)} target="_blank" rel="noopener noreferrer" className="font-semibold text-[#4C3DA8] underline">{t("publicFunnel.auth.privacyPolicy")}</a> {" "}
                  {t("publicFunnel.auth.termsJoin")} {" "}
                  <a href={buildMarketingUrlWithLocale("/terms", locale)} target="_blank" rel="noopener noreferrer" className="font-semibold text-[#4C3DA8] underline">{t("publicFunnel.auth.termsOfService")}</a>
                  {t("publicFunnel.auth.termsSuffix") && <> {t("publicFunnel.auth.termsSuffix")}</>}{t("publicFunnel.auth.termsSentenceEnd")}
                </label>
              </div>
              <p id="terms-guidance" className="ml-8 mt-1.5 text-xs leading-5 text-[#17223B]/70">{t("publicFunnel.auth.termsRequired")}</p>
              {errors.acceptedTerms && <p id="terms-error" role="alert" className="ml-8 mt-1 text-xs text-red-700">{errors.acceptedTerms.message}</p>}
            </div>

            <Button type="submit" disabled={isSubmitting || !acceptedTerms} aria-busy={isSubmitting} className="funnel-button funnel-button-primary h-12 w-full justify-center text-base">
              {isSubmitting ? t("publicFunnel.auth.creatingAccount") : t("publicFunnel.auth.createShuruButton")}
            </Button>
          </form>
          <p className="auth-v6-switch-inline">{t("publicFunnel.auth.haveAccount")} <Link to="/signin">{t("publicFunnel.nav.signIn")}</Link></p>
        </section>
      </PublicFunnelAuthLayout>
    </>
  );
}
