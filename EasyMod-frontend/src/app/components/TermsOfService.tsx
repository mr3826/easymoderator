import Seo from "./Seo";

const EFFECTIVE_DATE = "April 24, 2026";
const LAST_UPDATED = "October 31, 2026";
const COMPANY_NAME = "Hexabyte Technologies";
const COMPANY_URL = "https://hexabyte.tech";
const APP_NAME = "EasyModerator";
const SUPPORT_EMAIL = "support@easymod.tech";
const PRIVACY_EMAIL = "privacy@easymod.tech";

export default function TermsOfService() {
  return (
    <div className="min-h-screen bg-gray-50">
      <Seo
        title="EasyModerator Terms of Service"
        description="Terms governing use of the EasyModerator merchant automation service."
        canonicalPath="/terms"
      />
      {/* Header */}
      <header className="bg-white border-b border-gray-200">
        <div className="mx-auto max-w-4xl px-6 py-4 flex items-center justify-between">
          <a href="/" className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-blue-600 to-purple-600" />
            <span className="text-lg font-bold text-gray-900">{APP_NAME}</span>
          </a>
          <span className="text-sm text-gray-500">Terms of Service</span>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-12">
        {/* Title block */}
        <div className="mb-10">
          <h1 className="text-3xl font-bold text-gray-900">Terms of Service</h1>
          <p className="mt-2 text-sm text-gray-500">Effective date: {EFFECTIVE_DATE} &nbsp;·&nbsp; Last updated: {LAST_UPDATED}</p>
          <p className="mt-4 text-gray-600 leading-relaxed">
            These Terms of Service ("Terms") govern your access to and use of <strong>{APP_NAME}</strong>, a
            product of <strong>{COMPANY_NAME}</strong> ("we", "us", or "our") — see{" "}
            <a href={COMPANY_URL} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
              hexabyte.tech
            </a>{" "}
            for more about the parent company. By creating an account or
            using the {APP_NAME} platform, you agree to be bound by these Terms and our{" "}
            <a href="/privacy-policy" className="text-blue-600 hover:underline">Privacy Policy</a>.
          </p>
          <p className="mt-3 text-gray-600 leading-relaxed">
            If you do not agree to these Terms, you may not access or use the {APP_NAME} service.
          </p>

          {/* Current service status — mirrors the Privacy Policy without asserting
              an unverified Meta App Review state. Keep both in step. */}
          <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-5">
            <h2 className="text-base font-semibold text-amber-950">Current service status</h2>
            <p className="mt-2 text-sm leading-relaxed text-amber-900">
              Facebook Messenger features are available only when the Facebook account and Page can be
              authorized in our connection flow. Available features and plan limits depend on the account,
              selected Page and published plan. We will give reasonable notice of changes that materially
              affect your use of the service.
            </p>
            <ul className="mt-3 space-y-1.5 text-sm leading-relaxed text-amber-900">
              <li>
                <strong>Available now:</strong> a shared Facebook Messenger inbox for connected Pages, with
                AI-assisted replies, order capture, courier booking, and merchant analytics.
              </li>
              <li>
                <strong>Payments:</strong> Optional platform-level bKash processing may be used for {APP_NAME}{' '}
                subscription invoices and conversation top-ups when the platform flag and required credentials
                are set. It is not a per-shop gateway for customer orders. Per-shop payment settings support
                cash-on-delivery and self-MFS transfer instructions. Direct bKash or Nagad transfers are
                merchant-verified; {APP_NAME} may store submitted references or payment evidence for review.
              </li>
              <li>
                <strong>Out of scope for this release:</strong> Facebook comment automation, comment-to-DM,
                and public comment replies. {APP_NAME} handles direct Messenger conversations only.
              </li>
            </ul>
          </div>
        </div>

        <div className="space-y-10 text-gray-700">

          {/* 1 — Acceptance */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-4">1. Acceptance of Terms</h2>
            <p className="leading-relaxed">
              By registering for or using {APP_NAME}, you represent that you are at least 18 years old, have
              the legal authority to enter into these Terms on behalf of yourself or your business, and agree
              to comply with all applicable laws and regulations in Bangladesh and any other jurisdiction from
              which you access the service.
            </p>
          </section>

          {/* 2 — Description of Service */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-4">2. Description of Service</h2>
            <p className="mb-3 leading-relaxed">
              {APP_NAME} is a SaaS e-commerce moderation platform that allows businesses to manage customer
              conversations, automate replies using AI, process orders, and connect with messaging channels.
              In this release the only connected channel is <strong>Facebook Messenger</strong>, through a
              Facebook Page you authorise. Customers must message your Page directly; {APP_NAME} does not
              read, reply to, or trigger workflows from Facebook post comments.
            </p>
            <p className="mb-3 leading-relaxed">
              Order fulfilment features include courier booking with Pathao, Steadfast, and RedX, and
              cash-on-delivery risk review. Per-shop payment settings support cash-on-delivery and self-MFS
              instructions, where enabled. Optional platform-level bKash processing is for {APP_NAME} subscription
              invoices and conversation top-ups, not merchant customer orders. Direct bKash and Nagad transfers
              are merchant-verified.
            </p>
            <p className="leading-relaxed">
              We reserve the right to modify, suspend, or discontinue any part of the service at any time
              with reasonable notice. We will not be liable to you or any third party for any such modification,
              suspension, or discontinuation.
            </p>
          </section>

          {/* 3 — Meta Platform Compliance */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-4">3. Meta Platform Compliance</h2>
            <p className="mb-3 leading-relaxed">
              {APP_NAME} integrates with Meta platforms (Facebook) via the Meta Graph
              API and Webhooks. By connecting your Facebook Page to {APP_NAME}, you agree to:
            </p>

            <h3 className="text-base font-semibold text-gray-800 mb-2">Your Obligations</h3>
            <ul className="list-disc list-inside space-y-1 text-sm leading-relaxed ml-2 mb-4">
              <li>Comply with <strong>Meta's Platform Terms</strong>, Developer Policies, and Business Tools Terms</li>
              <li>Comply with Meta's <strong>Community Standards</strong> and Messaging Policy</li>
              <li>Obtain all necessary consents from your customers before messaging them through Meta channels</li>
              <li>Use Meta integrations only for legitimate business communications — not for spam, harassment, or deceptive messaging</li>
              <li>Not use {APP_NAME} to send bulk unsolicited messages ("cold DMs") in violation of Meta's policies</li>
              <li>Maintain accurate and non-deceptive business information on your connected Pages and accounts</li>
            </ul>

            <h3 className="text-base font-semibold text-gray-800 mb-2">Our Role as Technology Provider</h3>
            <p className="mb-3 text-sm leading-relaxed">
              {APP_NAME} acts as a technology provider enabling your business to use Meta's messaging APIs.
              We are not responsible for content you send through Meta channels. You remain solely responsible
              for all messages sent from your connected accounts. We may suspend or terminate your access if
              Meta suspends your app permissions, your Facebook Page, or if your usage violates Meta's policies.
            </p>

            <h3 className="text-base font-semibold text-gray-800 mb-2">API Usage Restrictions</h3>
            <ul className="list-disc list-inside space-y-1 text-sm leading-relaxed ml-2">
              <li>You may not use {APP_NAME} to circumvent Meta's rate limits or API quotas</li>
              <li>You may not use {APP_NAME} to scrape or harvest user data from Meta platforms beyond what is delivered via webhooks for your authorised Page/account</li>
              <li>You may not use {APP_NAME} to send automated messages that violate the 24-hour messaging window rules for Messenger</li>
              <li>Meta webhook data received through {APP_NAME} may only be used to operate your business — not re-sold, transferred to third parties, or used for advertising targeting</li>
            </ul>
          </section>

          {/* 4 — Bangladesh Data Privacy */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-4">4. Bangladesh Data Privacy Compliance</h2>
            <p className="mb-3 leading-relaxed">
              {COMPANY_NAME} is incorporated in Bangladesh. We handle data in accordance with applicable
              Bangladesh data, cyber, communications, consumer-protection, and financial-record rules.
              Bangladesh regulation continues to evolve, and the public-launch legal copy must be reviewed
              by counsel before broad market release.
            </p>

            <h3 className="text-base font-semibold text-gray-800 mb-2">Data Collection and Processing</h3>
            <p className="mb-3 text-sm leading-relaxed">
              We collect and process personal data only as necessary to provide the {APP_NAME} service,
              as described in our{" "}
              <a href="/privacy-policy" className="text-blue-600 hover:underline">Privacy Policy</a>.
              We do not sell personal data to third parties.
            </p>

            <h3 className="text-base font-semibold text-gray-800 mb-2">Your Rights as a Data Subject</h3>
            <ul className="list-disc list-inside space-y-1 text-sm leading-relaxed ml-2 mb-4">
              <li><strong>Access:</strong> You may request a copy of the personal data we hold about you</li>
              <li><strong>Correction:</strong> You may request correction of inaccurate data</li>
              <li><strong>Deletion:</strong> You may request deletion of your account and associated data</li>
              <li><strong>Portability:</strong> You may request your data in a portable format</li>
            </ul>
            <p className="text-sm leading-relaxed mb-4">
              To exercise these rights, email{" "}
              <a href={`mailto:${PRIVACY_EMAIL}`} className="text-blue-600 hover:underline">{PRIVACY_EMAIL}</a>.
              We will respond within 30 days.
            </p>

            <h3 className="text-base font-semibold text-gray-800 mb-2">Data Breach Notification</h3>
            <p className="text-sm leading-relaxed mb-4">
              In the event of a data breach that is likely to result in significant harm to your rights and
              interests, we will notify affected business users within 72 hours of becoming aware of the breach,
              and will cooperate with relevant regulatory authorities as required by law.
            </p>

            <h3 className="text-base font-semibold text-gray-800 mb-2">Data Retention and Deletion</h3>
            <p className="text-sm leading-relaxed mb-3">
              We retain personal data only for as long as necessary to provide the service and comply with
              legal obligations. On account termination, we delete or anonymise your data within 30 days,
              except where retention is required by financial or regulatory obligations.
            </p>

            <h3 className="text-base font-semibold text-gray-800 mb-2">Cross-Border Data Transfers</h3>
            <p className="text-sm leading-relaxed">
              Some {APP_NAME} data may be processed outside Bangladesh, including on DigitalOcean cloud
              infrastructure. Depending on the feature used and runtime configuration, AI request content may be
              sent to Google or OpenAI only when the provider is configured and a request reaches it. Operational
              alert details may be sent to Slack or Sentry when those sinks are configured. Which providers
              receive data and the countries where it is processed depend on the configured integrations and
              request path. By using {APP_NAME}, you acknowledge and consent to these transfers when the relevant
              feature or integration is used. We require third-party providers to maintain appropriate data
              protection standards.
            </p>
          </section>

          {/* 5 — Acceptable Use */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-4">5. Acceptable Use Policy</h2>
            <p className="mb-3 leading-relaxed">You agree not to use {APP_NAME} to:</p>
            <ul className="list-disc list-inside space-y-1 text-sm leading-relaxed ml-2">
              <li>Send spam, unsolicited bulk messages, or phishing messages</li>
              <li>Distribute malware, viruses, or any harmful code</li>
              <li>Engage in fraudulent, deceptive, or misleading business practices</li>
              <li>Harass, abuse, or harm any individual or group</li>
              <li>Violate any applicable law or regulation in Bangladesh or elsewhere</li>
              <li>Infringe the intellectual property rights of any third party</li>
              <li>Attempt to gain unauthorised access to other users' accounts or our systems</li>
              <li>Reverse-engineer, decompile, or disassemble any part of the {APP_NAME} platform</li>
              <li>Resell or sublicense access to {APP_NAME} without our prior written consent</li>
              <li>Use automated scripts to interact with the platform outside of officially supported API integrations</li>
            </ul>
            <p className="mt-3 text-sm leading-relaxed">
              We reserve the right to investigate and, if appropriate, suspend or terminate your account for
              violations of this Acceptable Use Policy without prior notice.
            </p>
          </section>

          {/* 6 — Service Availability */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-4">6. Service Availability</h2>
            <p className="leading-relaxed">
              We strive to provide a reliable service, but we do not guarantee uninterrupted or error-free
              operation. {APP_NAME} is provided on an "as is" and "as available" basis. Scheduled maintenance,
              third-party outages (including Meta API disruptions), and unforeseen technical issues may cause
              temporary unavailability. We will endeavour to communicate planned maintenance in advance.
            </p>
          </section>

          {/* 7 — User Responsibilities */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-4">7. User Responsibilities</h2>
            <ul className="list-disc list-inside space-y-2 text-sm leading-relaxed ml-2">
              <li>You are responsible for maintaining the confidentiality of your account credentials</li>
              <li>You are responsible for all activity that occurs under your account</li>
              <li>You must notify us immediately at{" "}
                <a href={`mailto:${SUPPORT_EMAIL}`} className="text-blue-600 hover:underline">{SUPPORT_EMAIL}</a>{" "}
                if you suspect unauthorised access to your account</li>
              <li>You are responsible for ensuring that your use of {APP_NAME} complies with all laws applicable to your business</li>
              <li>You are responsible for obtaining any consents required from your customers before processing their data through {APP_NAME}</li>
              <li>You are responsible for the content of all messages sent through your connected channels</li>
            </ul>
          </section>

          {/* 8 — Intellectual Property */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-4">8. Intellectual Property</h2>
            <p className="mb-3 leading-relaxed">
              The {APP_NAME} platform, including its software, design, logos, and content created by us,
              is the intellectual property of {COMPANY_NAME} and is protected by applicable copyright,
              trademark, and other intellectual property laws.
            </p>
            <p className="mb-3 leading-relaxed">
              We grant you a limited, non-exclusive, non-transferable, revocable licence to access and use{' '}
              {APP_NAME} solely for your internal business operations during the term of your subscription.
            </p>
            <p className="leading-relaxed">
              You retain ownership of all data, content, and materials you upload or create within {APP_NAME}.
              By using the service, you grant us a limited licence to process your content solely as required
              to deliver the service to you.
            </p>
          </section>

          {/* 9 — Limitation of Liability */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-4">9. Limitation of Liability</h2>
            <p className="mb-3 leading-relaxed">
              To the fullest extent permitted by law, {COMPANY_NAME} shall not be liable for any indirect,
              incidental, special, consequential, or punitive damages, including loss of revenue, loss of
              profits, loss of business, or loss of data, arising from your use of or inability to use {APP_NAME}.
            </p>
            <p className="mb-3 leading-relaxed">
              Our total aggregate liability to you for any claims arising under or related to these Terms
              shall not exceed the total fees paid by you to {COMPANY_NAME} in the <strong>30 days immediately
              preceding the event</strong> giving rise to the claim.
            </p>
            <p className="text-sm leading-relaxed text-gray-600">
              Some jurisdictions do not allow the exclusion of certain warranties or the limitation of liability
              for incidental or consequential damages. In such jurisdictions, our liability is limited to the
              maximum extent permitted by law.
            </p>
          </section>

          {/* 10 — Termination */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-4">10. Termination and Suspension</h2>
            <h3 className="text-base font-semibold text-gray-800 mb-2">By You</h3>
            <p className="mb-4 text-sm leading-relaxed">
              You may terminate your account at any time by emailing{" "}
              <a href={`mailto:${SUPPORT_EMAIL}`} className="text-blue-600 hover:underline">{SUPPORT_EMAIL}</a>.
              Termination does not entitle you to a refund of any prepaid subscription fees.
            </p>

            <h3 className="text-base font-semibold text-gray-800 mb-2">By Us</h3>
            <p className="mb-3 text-sm leading-relaxed">
              We may suspend or terminate your access to {APP_NAME} immediately, without prior notice, if:
            </p>
            <ul className="list-disc list-inside space-y-1 text-sm leading-relaxed ml-2 mb-4">
              <li>You breach these Terms or our Acceptable Use Policy</li>
              <li>Your Meta permissions are revoked or your connected Facebook Page is disabled</li>
              <li>You fail to pay subscription fees when due</li>
              <li>We are required to do so by law or regulatory order</li>
              <li>We reasonably believe your usage poses a security risk to us or other users</li>
            </ul>

            <h3 className="text-base font-semibold text-gray-800 mb-2">Effect of Termination</h3>
            <p className="text-sm leading-relaxed">
              Upon termination, your right to access {APP_NAME} ceases immediately. We will retain your
              data for 30 days following termination to allow you to request an export, after which it will
              be permanently deleted in accordance with our Privacy Policy.
            </p>
          </section>

          {/* 11 — Dispute Resolution */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-4">11. Dispute Resolution</h2>
            <p className="mb-3 leading-relaxed">
              We encourage you to contact us first to resolve any disputes. Email{" "}
              <a href={`mailto:${SUPPORT_EMAIL}`} className="text-blue-600 hover:underline">{SUPPORT_EMAIL}</a>{" "}
              and we will attempt to resolve the matter within 30 days.
            </p>
            <p className="mb-3 leading-relaxed">
              These Terms are governed by the laws of the <strong>People's Republic of Bangladesh</strong>.
              Any disputes that cannot be resolved amicably shall be subject to the exclusive jurisdiction
              of the competent courts of Dhaka, Bangladesh.
            </p>
          </section>

          {/* 12 — Changes to Terms */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-4">12. Changes to These Terms</h2>
            <p className="leading-relaxed">
              We may update these Terms from time to time. When we make material changes, we will update
              the "Effective date" at the top of this page and notify business users by email where
              appropriate. Your continued use of {APP_NAME} after the updated Terms take effect constitutes
              your acceptance of the revised Terms.
            </p>
          </section>

          {/* 13 — Contact */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-4">13. Contact Us</h2>
            <p className="mb-4 leading-relaxed">
              For questions about these Terms, data deletion requests, or any other inquiries, please contact:
            </p>
            <div className="rounded-xl border border-gray-200 bg-white p-5 text-sm space-y-2">
              <p className="font-semibold text-gray-900">{COMPANY_NAME}</p>
              <p className="text-gray-600">
                Parent company:{" "}
                <a href={COMPANY_URL} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                  hexabyte.tech
                </a>
              </p>
              <p className="text-gray-600">
                General Support:{" "}
                <a href={`mailto:${SUPPORT_EMAIL}`} className="text-blue-600 hover:underline">{SUPPORT_EMAIL}</a>
              </p>
              <p className="text-gray-600">
                Privacy &amp; Data:{" "}
                <a href={`mailto:${PRIVACY_EMAIL}`} className="text-blue-600 hover:underline">{PRIVACY_EMAIL}</a>
              </p>
              <p className="text-gray-600 text-xs mt-2">
                For data deletion requests, include the subject line: <em>"Account Deletion Request"</em> or{" "}
                <em>"Facebook Data Deletion Request"</em>. We will confirm deletion with a confirmation code within 30 days.
              </p>
            </div>
          </section>

        </div>

        {/* Footer */}
        <div className="mt-16 pt-8 border-t border-gray-200 flex items-center justify-between text-sm text-gray-500">
          <span>
            © {new Date().getFullYear()}{" "}
            <a href={COMPANY_URL} target="_blank" rel="noopener noreferrer" className="hover:underline">
              {COMPANY_NAME}
            </a>
            . All rights reserved.
          </span>
          <button
            onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
            className="text-blue-600 hover:underline"
          >
            Back to top
          </button>
        </div>
      </main>
    </div>
  );
}
