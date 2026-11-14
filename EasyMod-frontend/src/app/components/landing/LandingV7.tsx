import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  COMMERCIAL_CONTRACT_VERSION,
  formatBdt,
  formatBdtBn,
  toBengaliNumerals,
} from "@/shared/contracts/commercial-contract";
import { useCommercialContract } from "@/api/domains/commercialContract";
import type { ClaimDecision } from "@/api/types/commercial";
import { trackFunnelEvent } from "@/app/lib/funnel";
import { Claim } from "../claims/Claim";
import { useClaimContext } from "../claims/ClaimProvider";
import "./landing-v7.css";

type Locale = "en" | "bn";

const CAPABILITY_STATUS: ReadonlyArray<{ id: string; titleKey: string }> = [
  { id: "courier.booking", titleKey: "landingV7.extras.orderTitle" },
  { id: "courier.payout", titleKey: "landingV7.extras.ledgerTitle" },
  { id: "rto.verify", titleKey: "landingV7.extras.rtoTitle" },
  { id: "voice.transcribe", titleKey: "landingV7.extras.handoffTitle" },
  { id: "order.fromchat", titleKey: "landingV7.extras.orderTitle" },
  { id: "customer.ledger", titleKey: "landingV7.extras.ledgerTitle" },
  { id: "knowledge.gaps", titleKey: "landingV7.extras.gapsTitle" },
  { id: "queue.priority", titleKey: "landingV7.extras.queueTitle" },
  { id: "handoff.human", titleKey: "landingV7.extras.handoffTitle" },
];

const EXTRA_CLAIMS: ReadonlyArray<{ id: string; titleKey: string }> = [
  { id: "order.fromchat", titleKey: "landingV7.extras.orderTitle" },
  { id: "customer.ledger", titleKey: "landingV7.extras.ledgerTitle" },
  { id: "knowledge.gaps", titleKey: "landingV7.extras.gapsTitle" },
  { id: "queue.priority", titleKey: "landingV7.extras.queueTitle" },
  { id: "handoff.human", titleKey: "landingV7.extras.handoffTitle" },
  { id: "rto.verify", titleKey: "landingV7.extras.rtoTitle" },
];

function useLocale(): Locale {
  const { i18n } = useTranslation();
  return i18n?.language?.toLowerCase().startsWith("en") ? "en" : "bn";
}

const money = (minor: number, locale: Locale) => (locale === "en" ? formatBdt(minor) : formatBdtBn(minor));
const bn = (value: number | string, locale: Locale) =>
  locale === "en" ? String(value) : toBengaliNumerals(String(value));

/** Split the contract zero amount into a small currency sign + a giant digit,
 * so the ZERO mark is derived from the formatter and never hardcoded. */
function zeroParts(locale: Locale) {
  const display = money(0, locale); // the contract zero amount, from the formatter
  const currency = display.slice(0, 1);
  const digits = display.slice(1).split(".")[0];
  return { currency, digits };
}

export function LandingV7Page() {
  const { t } = useTranslation();
  const locale = useLocale();
  const contract = useCommercialContract();
  const claimContext = useClaimContext();

  const payload = contract.data;

  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});
  const viewedSections = useRef<Set<string>>(new Set());
  const scrollMarks = useRef<Set<number>>(new Set());

  // page_view carries the contract version so conversion attributes to a price.
  useEffect(() => {
    if (!payload) return;
    trackFunnelEvent("page_view", {
      surface: "landing",
      contract_version: payload.contract_version,
    });
  }, [payload]);

  // section_view / mechanism_view: fire once each when a section enters view.
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const id = (entry.target as HTMLElement).dataset.section;
        if (!id || viewedSections.current.has(id)) continue;
        viewedSections.current.add(id);
        trackFunnelEvent("section_view", { section: id, surface: "landing" });
        if (id === "how") trackFunnelEvent("mechanism_view", { section: id });
      }
    }, { threshold: 0.35 });
    Object.values(sectionRefs.current).forEach((node) => node && observer.observe(node));
    return () => observer.disconnect();
  }, [payload]);

  // scroll_depth at 25/50/75/100.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onScroll = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      if (max <= 0) return;
      const pct = Math.min(100, Math.round((window.scrollY / max) * 100));
      for (const mark of [25, 50, 75, 100]) {
        if (pct >= mark && !scrollMarks.current.has(mark)) {
          scrollMarks.current.add(mark);
          trackFunnelEvent("scroll_depth", { depth: mark });
        }
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const registerSection = useCallback((id: string) => (node: HTMLElement | null) => {
    sectionRefs.current[id] = node;
  }, []);

  const signupHref = `/signup?lang=${locale}`;

  const onCta = useCallback((where: string) => {
    trackFunnelEvent("cta_click", { cta: where, surface: "landing" });
    trackFunnelEvent("signup_click", { cta: where, surface: "landing" });
  }, []);

  const claimRendered = (id: string): boolean => {
    const decision: ClaimDecision | undefined = claimContext?.decisions.get(id);
    return Boolean(decision && decision.render !== "none");
  };

  // Fail closed: no contract payload means no numbers at all.
  if (contract.error || (contract.isPending === false && !payload)) {
    return (
      <div className="landing-v7">
        <div className="lv7-container">
          <div role="alert" className="lv7-failclosed">
            {t("landingV7.meta.description")} — {t("landingV7.price.title")}: {" "}
            {locale === "en" ? "Current pricing is unavailable right now." : "বর্তমান মূল্য এখন পাওয়া যাচ্ছে না।"}
          </div>
        </div>
      </div>
    );
  }

  if (!payload || payload.unit_price_minor == null) return null;

  const zero = zeroParts(locale);
  const perOrder = money(payload.unit_price_minor, locale);

  return (
    <div className="landing-v7">
      {/* 1 — Hero */}
      <section className="lv7-hero" data-section="hero" ref={registerSection("hero")} aria-labelledby="lv7-hero-title">
        <div className="lv7-container lv7-hero-grid">
          <div>
            <p className="lv7-eyebrow">{t("landingV7.hero.eyebrow")}</p>
            <h1 id="lv7-hero-title">{t("landingV7.hero.title")}</h1>
            <p className="lv7-sub">{t("landingV7.hero.subtitle")}</p>
            <div className="lv7-hero-actions">
              <a className="lv7-btn lv7-btn--onDark" href={signupHref} onClick={() => onCta("hero")}>
                {t("landingV7.hero.ctaPrimary")}
              </a>
              <a className="lv7-btn lv7-btn--ghostOnDark" href="#workflow">
                {t("landingV7.hero.ctaSecondary")}
              </a>
            </div>
            <p className="lv7-ledger-note">{t("landingV7.hero.ledgerNote")}</p>
          </div>
          <div className="lv7-phone" role="img" aria-label={t("landingV7.hero.sampleLabel")}>
            <div className="lv7-phone-frame">
              <div className="lv7-phone-screen">
                <span className="lv7-sample-tag">{locale === "en" ? "Sample" : "নমুনা"}</span>
                <div className="lv7-thread" aria-label={t("landingV7.hero.threadLabel")}>
                  {(["messages", "orders", "courier", "delivery", "money"] as const).map((node, i) => (
                    <span key={node} className="lv7-thread-node">
                      {t(`landingV7.hero.nodes.${node}`)}{i < 4 ? <span className="lv7-thread-arrow"> {"→"} </span> : null}
                    </span>
                  ))}
                </div>
                <div className="lv7-bubble">{locale === "en" ? "Is this available in blue?" : "এটা কি নীল রঙে আছে?"}</div>
                <div className="lv7-bubble lv7-bubble--out">{locale === "en" ? "Yes — recorded on one ledger." : "হ্যাঁ — এক খাতায় লেখা হলো।"}</div>
                <div className="lv7-mini-row"><span>{t("landingV7.hero.nodes.orders")}</span><span>#1042</span></div>
                <div className="lv7-mini-row"><span>{t("landingV7.hero.nodes.delivery")}</span><span>{locale === "en" ? "confirmed" : "নিশ্চিত"}</span></div>
              </div>
            </div>
            <p className="lv7-ledger-note">{t("landingV7.hero.sampleLabel")}</p>
          </div>
        </div>
      </section>

      {/* 2 — Scatter */}
      <section data-section="scatter" ref={registerSection("scatter")} aria-labelledby="lv7-scatter-title">
        <div className="lv7-container">
          <div className="lv7-section-head">
            <h2 id="lv7-scatter-title">{t("landingV7.scatter.title")}</h2>
            <p className="lv7-sub">{t("landingV7.scatter.subtitle")}</p>
          </div>
          <div className="lv7-scatter-grid">
            {(["inbox", "orders", "parcel", "customer"] as const).map((key) => (
              <article className="lv7-card" key={key}>
                <h3>{t(`landingV7.scatter.${key}Title`)}</h3>
                <p>{t(`landingV7.scatter.${key}Body`)}</p>
              </article>
            ))}
          </div>
          <p className="lv7-resolve">{t("landingV7.scatter.resolve")}</p>
        </div>
      </section>

      {/* 3 — How (no competing count vs the four cards) */}
      <section id="workflow" data-section="how" ref={registerSection("how")} aria-labelledby="lv7-how-title">
        <div className="lv7-container">
          <div className="lv7-section-head">
            <h2 id="lv7-how-title">{t("landingV7.how.title")}</h2>
            <p className="lv7-sub">{t("landingV7.how.subtitle")}</p>
          </div>
          <div className="lv7-how-grid">
            <div className="lv7-mech">
              {(["one", "two", "three"] as const).map((key) => (
                <div className="lv7-mech-item" key={key}>
                  <h3>{t(`landingV7.how.${key}Title`)}</h3>
                  <p>{t(`landingV7.how.${key}Body`)}</p>
                </div>
              ))}
            </div>
            <div className="lv7-how-phone lv7-phone" role="img" aria-label={t("landingV7.hero.sampleLabel")}>
              <div className="lv7-phone-frame">
                <div className="lv7-phone-screen">
                  <span className="lv7-sample-tag">{locale === "en" ? "Sample" : "নমুনা"}</span>
                  <div className="lv7-mini-row"><span>{t("landingV7.hero.nodes.messages")}</span><span>3</span></div>
                  <div className="lv7-mini-row"><span>{t("landingV7.hero.nodes.orders")}</span><span>2</span></div>
                  <div className="lv7-mini-row"><span>{t("landingV7.hero.nodes.courier")}</span><span>1</span></div>
                  <div className="lv7-mini-row"><span>{t("landingV7.hero.nodes.delivery")}</span><span>{t("landingV7.status.verified")}</span></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 4 — Extras (six capabilities, each gated) */}
      <section id="capabilities" data-section="extras" ref={registerSection("extras")} aria-labelledby="lv7-extras-title">
        <div className="lv7-container">
          <div className="lv7-section-head">
            <h2 id="lv7-extras-title">{t("landingV7.extras.title")}</h2>
            <p className="lv7-sub">{t("landingV7.extras.subtitle")}</p>
          </div>
          <div className="lv7-extras-grid">
            {EXTRA_CLAIMS.map(({ id, titleKey }) => (
              <article className="lv7-card" key={id}>
                <h3>{t(titleKey)}</h3>
                <Claim id={id} surface="landing" className="lv7-claim" />
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* 5 — Price ZERO */}
      <section id="plans" className="lv7-price" data-section="price" ref={registerSection("price")} aria-labelledby="lv7-price-title">
        <div className="lv7-container">
          <div className="lv7-section-head">
            <h2 id="lv7-price-title">{t("landingV7.price.title")}</h2>
            <p className="lv7-sub">{t("landingV7.price.subtitle")}</p>
          </div>
          {claimRendered("price.zero") ? (
            <div data-testid="lv7-zero-mark">
              <p className="lv7-zero" aria-label={money(0, locale)}>
                <span className="lv7-zero-currency">{zero.currency}</span>
                <span className="lv7-zero-digit">{zero.digits}</span>
              </p>
              <p className="lv7-zero-caption">{t("landingV7.price.zeroCaption")}</p>
            </div>
          ) : null}
          <div className="lv7-price-grid">
            <div className="lv7-price-card">
              <p className="lv7-price-amount" data-testid="lv7-unit-price">{perOrder}</p>
              <p className="lv7-sub">{t("landingV7.price.perOrderLabel")}</p>
              <Claim id="price.unit" surface="landing" className="lv7-claim" />
              <p className="lv7-arithmetic-note">{t("landingV7.price.perOrderCaption")}</p>
            </div>
            <div className="lv7-price-card">
              <Claim id="price.zero" surface="landing" className="lv7-claim" />
              <p className="lv7-arithmetic-note">{t("landingV7.price.zeroOnReturnNote")}</p>
              <Claim id="price.nosub" surface="landing" className="lv7-claim" />
              <p className="lv7-arithmetic-note">{t("landingV7.price.noSubNote")}</p>
            </div>
          </div>
        </div>
      </section>

      {/* 6 — Calculator */}
      <Calculator unitPriceMinor={payload.unit_price_minor} locale={locale} />

      {/* 7 — Trust */}
      <section data-section="trust" ref={registerSection("trust")} aria-labelledby="lv7-trust-title">
        <div className="lv7-container">
          <div className="lv7-section-head">
            <h2 id="lv7-trust-title">{t("landingV7.trust.title")}</h2>
            <p className="lv7-sub">{t("landingV7.trust.subtitle")}</p>
          </div>
          <div className="lv7-trust-grid">
            <ul className="lv7-wont">
              {(["wont1", "wont2", "wont3"] as const).map((key) => (
                <li key={key}>{t(`landingV7.trust.${key}`)}</li>
              ))}
            </ul>
            <div>
              <h3>{t("landingV7.trust.permissionsTitle")}</h3>
              <ul className="lv7-perms">
                {(["perm1", "perm2", "perm3"] as const).map((key) => (
                  <li key={key}>{t(`landingV7.trust.${key}`)}</li>
                ))}
              </ul>
              <p className="lv7-neutral">{t("landingV7.trust.neutralRecord")}</p>
              <p className="lv7-neutral"><Claim id="ai.notrain" surface="landing" className="lv7-claim" /></p>
            </div>
          </div>
        </div>
      </section>

      {/* 8 — Start */}
      <section data-section="start" ref={registerSection("start")} aria-labelledby="lv7-start-title">
        <div className="lv7-container">
          <div className="lv7-section-head">
            <h2 id="lv7-start-title">{t("landingV7.start.title")}</h2>
            <p className="lv7-sub">{t("landingV7.start.subtitle")}</p>
          </div>
          <div className="lv7-start-steps">
            {(["step1", "step2", "step3"] as const).map((key, i) => (
              <article className="lv7-card" key={key}>
                <span className="lv7-step-num">{bn(i + 1, locale)}</span>
                <h3>{t(`landingV7.start.${key}`)}</h3>
              </article>
            ))}
          </div>
          <p className="lv7-no-time">{t("landingV7.start.noTime")}</p>
          <a className="lv7-btn lv7-btn--primary" href={signupHref} onClick={() => onCta("start")}>
            {t("landingV7.start.cta")}
          </a>
        </div>
      </section>

      {/* 9 — FAQ */}
      <Faq locale={locale} />

      {/* 10 — Close */}
      <section className="lv7-close" data-section="close" ref={registerSection("close")} aria-labelledby="lv7-close-title">
        <div className="lv7-container">
          <p className="lv7-zero" aria-hidden="true">
            <span className="lv7-zero-currency">{zero.currency}</span>
            <span className="lv7-zero-digit">{zero.digits}</span>
          </p>
          <h2 id="lv7-close-title">{t("landingV7.close.title")}</h2>
          <p className="lv7-sub">{t("landingV7.close.subtitle")}</p>
          <div style={{ marginTop: "1.5rem" }}>
            <a className="lv7-btn lv7-btn--onDark" href={signupHref} onClick={() => onCta("close")}>
              {t("landingV7.close.cta")}
            </a>
          </div>
        </div>
      </section>

      {/* 11 — Footer with registry-derived capability status */}
      <StatusFooter locale={locale} />

      {/* 12 — Sticky mobile CTA */}
      <StickyCta locale={locale} onCta={onCta} />
    </div>
  );
}

function Calculator({ unitPriceMinor, locale }: { unitPriceMinor: number; locale: Locale }) {
  const { t } = useTranslation();
  const DEFAULTS = { orders: 500, delivered: 85, returned: 8, cancelled: 4, failed: 3, months: 1, avgValue: 800 };
  const [v, setV] = useState(DEFAULTS);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const set = (key: keyof typeof DEFAULTS, value: number) => {
    setV((prev) => {
      const next = { ...prev, [key]: value };
      if (debounce.current) clearTimeout(debounce.current);
      debounce.current = setTimeout(() => {
        trackFunnelEvent("calc_state", {
          orders: next.orders, delivered: next.delivered, returned: next.returned,
          cancelled: next.cancelled, failed: next.failed, months: next.months, avg_value: next.avgValue,
        });
      }, 600);
      return next;
    });
  };

  const deliveredOrders = Math.round((v.orders * v.delivered) / 100) * v.months;
  const zeroOrders = Math.round((v.orders * (v.returned + v.cancelled + v.failed)) / 100) * v.months;
  const feeMinor = deliveredOrders * unitPriceMinor;
  const codTurnover = deliveredOrders * v.avgValue;

  const reset = () => {
    setV(DEFAULTS);
    trackFunnelEvent("calc_reset", {});
  };

  const controls: ReadonlyArray<{ key: keyof typeof DEFAULTS; label: string; min: number; max: number; step: number; fmt: (n: number) => string }> = [
    { key: "orders", label: t("landingV7.calc.ordersLabel"), min: 10, max: 5000, step: 10, fmt: (n) => bn(n, locale) },
    { key: "delivered", label: t("landingV7.calc.deliveredLabel"), min: 0, max: 100, step: 1, fmt: (n) => `${bn(n, locale)}%` },
    { key: "returned", label: t("landingV7.calc.returnedLabel"), min: 0, max: 100, step: 1, fmt: (n) => `${bn(n, locale)}%` },
    { key: "cancelled", label: t("landingV7.calc.cancelledLabel"), min: 0, max: 100, step: 1, fmt: (n) => `${bn(n, locale)}%` },
    { key: "failed", label: t("landingV7.calc.failedLabel"), min: 0, max: 100, step: 1, fmt: (n) => `${bn(n, locale)}%` },
    { key: "months", label: t("landingV7.calc.monthsLabel"), min: 1, max: 12, step: 1, fmt: (n) => bn(n, locale) },
    { key: "avgValue", label: t("landingV7.calc.avgValueLabel"), min: 100, max: 5000, step: 50, fmt: (n) => money(n * 100, locale) },
  ];

  return (
    <section data-section="calculator" aria-labelledby="lv7-calc-title">
      <div className="lv7-container">
        <div className="lv7-section-head">
          <h2 id="lv7-calc-title">{t("landingV7.calc.title")}</h2>
          <p className="lv7-sub">{t("landingV7.calc.subtitle")}</p>
        </div>
        <div className="lv7-calc-grid">
          <div>
            {controls.map((control, index) => (
              <div className="lv7-control" key={control.key}>
                <div className="lv7-control-head">
                  <label htmlFor={`lv7-ctrl-${control.key}`}>{control.label}</label>
                  <output htmlFor={`lv7-ctrl-${control.key}`}>{control.fmt(v[control.key])}</output>
                </div>
                <input
                  id={`lv7-ctrl-${control.key}`}
                  className="lv7-slider"
                  type="range"
                  min={control.min}
                  max={control.max}
                  step={control.step}
                  value={v[control.key]}
                  aria-valuetext={control.fmt(v[control.key])}
                  data-control-index={index}
                  onChange={(e) => set(control.key, Number(e.target.value))}
                />
              </div>
            ))}
            <button type="button" className="lv7-btn lv7-btn--ghost lv7-reset" onClick={reset}>
              {t("landingV7.calc.resetLabel")}
            </button>
          </div>
          <div className="lv7-calc-out" aria-live="polite">
            <h3>{t("landingV7.calc.feeHeading")}</h3>
            <div className="lv7-out-row">
              <span>{t("landingV7.calc.deliveredLine")}</span>
              <strong>{bn(deliveredOrders, locale)}</strong>
            </div>
            <div className="lv7-out-row lv7-out-row--zero">
              <span>{t("landingV7.calc.zeroLine")}</span>
              <strong>{money(0, locale)} · {bn(zeroOrders, locale)}</strong>
            </div>
            <div className="lv7-out-row lv7-out-row--fee">
              <span>{t("landingV7.calc.feeLine")}</span>
              <strong data-testid="lv7-calc-fee">{money(feeMinor, locale)}</strong>
            </div>
            <div className="lv7-out-row">
              <span>{t("landingV7.calc.turnoverLine")}</span>
              <strong>{money(codTurnover * 100, locale)}</strong>
            </div>
            <p className="lv7-arithmetic-note">{t("landingV7.calc.arithmeticNote")}</p>
          </div>
        </div>
      </div>
    </section>
  );
}

function Faq({ locale }: { locale: Locale }) {
  const { t } = useTranslation();
  const items = [1, 2, 3, 4, 5] as const;
  return (
    <section data-section="faq" aria-labelledby="lv7-faq-title">
      <div className="lv7-container lv7-faq">
        <div className="lv7-section-head">
          <h2 id="lv7-faq-title">{t("landingV7.faq.title")}</h2>
        </div>
        {items.map((n) => (
          <details key={n} onToggle={(e) => { if ((e.target as HTMLDetailsElement).open) trackFunnelEvent("faq_open", { question: n }); }}>
            <summary>{t(`landingV7.faq.q${n}`)}</summary>
            <p>{t(`landingV7.faq.a${n}`)}</p>
          </details>
        ))}
        <span hidden>{locale}</span>
      </div>
    </section>
  );
}

function StatusFooter({ locale }: { locale: Locale }) {
  const { t } = useTranslation();
  const context = useClaimContext();

  const statusOf = (id: string): "verified" | "partial" | "notLaunched" => {
    const decision = context?.decisions.get(id);
    if (!decision) return "notLaunched";
    if (decision.available && decision.predicate.production_verified && decision.scope.match) return "verified";
    if (decision.predicate.code_present) return "partial";
    return "notLaunched";
  };

  return (
    <section className="lv7-status" data-section="status" aria-labelledby="lv7-status-title">
      <div className="lv7-container">
        <div className="lv7-section-head">
          <h2 id="lv7-status-title">{t("landingV7.status.title")}</h2>
          <p className="lv7-sub">{t("landingV7.status.subtitle")}</p>
        </div>
        <ul className="lv7-status-list">
          {CAPABILITY_STATUS.map(({ id, titleKey }) => {
            const status = statusOf(id);
            return (
              <li className="lv7-status-item" key={id} data-claim-status={id} data-status={status}>
                <span>{t(titleKey)}</span>
                <span className={`lv7-badge lv7-badge--${status}`}>{t(`landingV7.status.${status}`)}</span>
              </li>
            );
          })}
        </ul>
        <p className="lv7-footer-meta">
          {t("landingV7.footer.versionLabel")}: {COMMERCIAL_CONTRACT_VERSION} · {locale === "en" ? "source: claim registry" : "সূত্র: ক্লেইম রেজিস্ট্রি"}
        </p>
      </div>
    </section>
  );
}

function StickyCta({ locale, onCta }: { locale: Locale; onCta: (where: string) => void }) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof IntersectionObserver === "undefined") return;
    const hero = document.querySelector('[data-section="hero"]');
    const close = document.querySelector('[data-section="close"]');
    let heroSeen = false;
    let atClose = false;
    const sync = () => setVisible(heroSeen && !atClose);
    const heroObs = new IntersectionObserver((entries) => { heroSeen = !entries[0].isIntersecting; sync(); }, { threshold: 0 });
    const closeObs = new IntersectionObserver((entries) => { atClose = entries[0].isIntersecting; sync(); }, { threshold: 0.2 });
    if (hero) heroObs.observe(hero);
    if (close) closeObs.observe(close);
    return () => { heroObs.disconnect(); closeObs.disconnect(); };
  }, []);

  return (
    <div className="lv7-sticky" hidden={!visible} aria-hidden={!visible}>
      <a className="lv7-btn lv7-btn--onDark" href={`/signup?lang=${locale}`} onClick={() => onCta("sticky")}>
        {t("landingV7.sticky.cta")}
      </a>
    </div>
  );
}