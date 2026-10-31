import Seo from "./Seo";

const EFFECTIVE_DATE = "March 18, 2026";
const LAST_UPDATED = "October 31, 2026";
const CONTACT_EMAIL = "privacy@easymod.tech";
const APP_NAME = "EasyModerator";
const COMPANY_NAME = "Hexabyte Technologies";
const COMPANY_URL = "https://hexabyte.tech";

export default function PrivacyPolicy() {
  return (
    <div className="min-h-screen bg-gray-50">
      <Seo
        title="EasyModerator Privacy Policy"
        description="How EasyModerator collects, uses, secures, and deletes business and Messenger data."
        canonicalPath="/privacy-policy"
      />
      {/* Header */}
      <header className="bg-white border-b border-gray-200">
        <div className="mx-auto max-w-4xl px-6 py-4 flex items-center justify-between">
          <a href="/" className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-blue-600 to-purple-600" />
            <span className="text-lg font-bold text-gray-900">{APP_NAME}</span>
          </a>
          <span className="text-sm text-gray-500">Privacy Policy</span>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-12">
        {/* Title block */}
        <div className="mb-10">
          <h1 className="text-3xl font-bold text-gray-900">Privacy Policy</h1>
          <p className="mt-2 text-sm text-gray-500">Effective date: {EFFECTIVE_DATE} &nbsp;·&nbsp; Last updated: {LAST_UPDATED}</p>
          <p className="mt-4 text-gray-600 leading-relaxed">
            This Privacy Policy describes how <strong>{APP_NAME}</strong> ("we", "us", or "our"), a product
            of <strong>{COMPANY_NAME}</strong> (registered in Bangladesh — see{" "}
            <a href={COMPANY_URL} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
              hexabyte.tech
            </a>{" "}
            for more about the parent company), collects, uses, stores, and shares
            information when you use our e-commerce moderation platform, including our web application and
            integrations with Meta platforms (Facebook Messenger) and
            other third-party services.
          </p>
          <p className="mt-3 text-gray-600 leading-relaxed">
            By accessing or using {APP_NAME}, you agree to the practices described in this policy. If you are
            a business using {APP_NAME} to manage customer interactions, you are responsible for ensuring your
            customers are informed about how their data is handled through your use of our platform.
          </p>

          {/* Describe current availability without asserting unverified Meta or
              production integration configuration. */}
          <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-5">
            <h2 className="text-base font-semibold text-amber-950">Current service status</h2>
            <p className="mt-2 text-sm leading-relaxed text-amber-900">
              Facebook Messenger features are available only when the Facebook account and Page can be
              authorized in our connection flow. Available Pages and permissions may vary by account and Page.
              This policy describes the data handling <strong>active today</strong>. Integrations that are not
              configured and enabled for a shop do not process that shop's data; conditional integrations are
              identified below.
            </p>
            <ul className="mt-3 space-y-1.5 text-sm leading-relaxed text-amber-900">
              <li>
                <strong>Active:</strong> Facebook Messenger via connected Pages, reply generation, order
                capture, courier booking (Pathao, Steadfast, RedX), and merchant analytics.
              </li>
              <li>
                <strong>EasyModerator subscription payments:</strong> An optional platform-level bKash integration
                may process {APP_NAME} subscription invoices and conversation top-ups when the platform flag and
                required credentials are set. If used, payer and invoice details are sent to bKash. This is not a
                per-shop gateway for customer orders. Per-shop settings support cash-on-delivery and self-MFS
                transfer instructions. Direct bKash or Nagad transfers are verified by the merchant; {APP_NAME}{' '}
                may store submitted references and payment evidence for review.
              </li>
              <li>
                <strong>Retired:</strong> the legacy Make.com and n8n event-forwarding integrations. Separately,
                a configured operations-alert webhook may receive limited guardrail-escalation metadata, but not
                customer messages or AI responses; see section 6.
              </li>
            </ul>
            <p className="mt-3 text-sm leading-relaxed text-amber-900">
              We update this section when an integration is switched on or off, alongside the "Last updated"
              date above.
            </p>
          </div>
        </div>

        <div className="space-y-10 text-gray-700">

          {/* 1 — Legal Basis for Processing */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-4">1. Legal Basis for Processing</h2>
            <p className="mb-3 leading-relaxed">
              We process personal data only where we have a lawful basis to do so. Our primary bases are:
            </p>
            <ul className="list-disc list-inside space-y-2 text-sm leading-relaxed ml-2">
              <li>
                <strong>Contract performance:</strong> Processing necessary to provide the {APP_NAME} service
                you have subscribed to (account management, message handling, order processing).
              </li>
              <li>
                <strong>Legitimate interests:</strong> Security audit logging, fraud prevention, platform
                stability monitoring, and service improvement — where these interests are not overridden by
                your privacy rights.
              </li>
              <li>
                <strong>Consent:</strong> Processing based on your explicit consent, such as connecting your
                Meta accounts and enabling AI-assisted responses on your behalf.
              </li>
              <li>
                <strong>Legal obligation:</strong> Retaining records as required by applicable Bangladesh
                law, financial compliance requirements, and lawful requests from competent authorities.
              </li>
            </ul>
          </section>

          {/* 2 — Information We Collect */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-4">2. Information We Collect</h2>

            <h3 className="text-base font-semibold text-gray-800 mb-2">From Business Users (Shop Owners & Staff)</h3>
            <p className="mb-3 leading-relaxed">
              When you create an account or manage a shop on {APP_NAME}, we collect:
            </p>
            <ul className="list-disc list-inside space-y-1 text-sm leading-relaxed ml-2">
              <li>Full name, email address, and phone number</li>
              <li>Business name, timezone, and operating hours</li>
              <li>Hashed passwords (we never store plain-text passwords)</li>
              <li>Meta platform access tokens (encrypted at rest using AES-256-GCM)</li>
              <li>Payment gateway credentials, encrypted at rest if provided for a supported gateway enabled for your shop</li>
              <li>Delivery provider credentials (Pathao, Steadfast, RedX — encrypted at rest)</li>
              <li>IP address and browser/device information (for security audit logs)</li>
              <li>Session tokens stored as httpOnly, secure cookies</li>
            </ul>

            <h3 className="text-base font-semibold text-gray-800 mt-5 mb-2">From End-Customers (via Connected Channels)</h3>
            <p className="mb-3 leading-relaxed">
              When a business uses {APP_NAME} to manage customer interactions, we may process the following
              customer data on behalf of the business:
            </p>
            <ul className="list-disc list-inside space-y-1 text-sm leading-relaxed ml-2">
              <li>Name, phone number, and email address</li>
              <li>Messages sent and received through connected Facebook Messenger Pages</li>
              <li>Platform-specific user identifiers (e.g., Facebook Page-scoped user ID)</li>
              <li>Order details: items, quantities, prices, delivery address, and payment method</li>
              <li>Language preference and last active timestamp</li>
              <li>Delivery tracking information</li>
            </ul>
          </section>

          {/* 3 — How We Use Information */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-4">3. How We Use Information</h2>
            <div className="mb-4 rounded-lg border border-emerald-100 bg-emerald-50 p-4 text-sm leading-relaxed text-emerald-950">
              In plain language: {APP_NAME} uses shop and customer information to show Messenger conversations,
              prepare replies, capture orders, process payments, book deliveries, and keep the merchant account secure.
            </div>
            <p className="mb-3 leading-relaxed">We use the information we collect to:</p>
            <ul className="list-disc list-inside space-y-1 text-sm leading-relaxed ml-2">
              <li>Provide, operate, and improve the {APP_NAME} platform</li>
              <li>Prepare customer service replies on behalf of businesses</li>
              <li>Process and manage customer orders, payments, and deliveries</li>
              <li>Maintain shop answers and product facts for automated replies (technical retrieval systems may be used)</li>
              <li>Track subscription usage and enforce plan limits</li>
              <li>Send transactional emails (account verification, password reset, invoices)</li>
              <li>Maintain security audit logs for fraud prevention and compliance</li>
              <li>Provide analytics dashboards to business users (message counts, reply usage, costs)</li>
            </ul>
            <p className="mt-3 text-sm leading-relaxed">
              We do <strong>not</strong> use customer data for advertising, sell data to third parties, or use
              data from Meta platforms for any purpose other than operating the {APP_NAME} service as described.
              We do <strong>not</strong> use any user data — including Meta platform data or conversation content
              — to train or improve AI/machine learning models.
            </p>
          </section>

          {/* 4 — Meta Platform Data */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-4">4. Meta Platform Data</h2>
            <p className="mb-3 leading-relaxed">
              {APP_NAME} integrates with Meta platforms (Facebook Messenger)
              to allow businesses to manage customer conversations. This section
              describes how we handle data received from Meta in compliance with{" "}
              <strong>Meta's Platform Terms, Developer Policies, Business Tools Terms, and Data Processing
              Terms</strong>.
            </p>

            <h3 className="text-base font-semibold text-gray-800 mb-2">Data Controller / Data Processor</h3>
            <p className="mb-3 text-sm leading-relaxed">
              When a business connects their Meta account to {APP_NAME}, the business acts as the{" "}
              <strong>data controller</strong> for the end-customer data received through Meta channels.{" "}
              {APP_NAME} acts solely as a <strong>data processor</strong>, processing that data only on the
              business's documented instructions and only for the purposes described in this policy. Businesses
              are responsible for obtaining any consents required by applicable law before using {APP_NAME} to
              interact with their customers.
            </p>

            <h3 className="text-base font-semibold text-gray-800 mb-2">Data Received from Meta</h3>
            <p className="mb-2 text-sm leading-relaxed">Through Meta webhooks, we receive and store:</p>
            <ul className="list-disc list-inside space-y-1 text-sm leading-relaxed ml-2">
              <li>Inbound and outbound message content (text, media references)</li>
              <li>Platform user identifiers (Facebook page-scoped IDs)</li>
              <li>Message echo events (copies of messages sent by the Page itself, for conversation sync)</li>
            </ul>

            <h3 className="text-base font-semibold text-gray-800 mt-5 mb-2">How We Use Meta Data</h3>
            <ul className="list-disc list-inside space-y-1 text-sm leading-relaxed ml-2">
              <li>To display and manage conversations in the {APP_NAME} inbox</li>
              <li>To generate AI-assisted reply suggestions using our language model providers</li>
              <li>To match customer questions against the business's FAQs and shop answers</li>
              <li>To associate conversations with customer profiles and order history</li>
              <li>To provide analytics on message volume and reply usage to the business</li>
            </ul>

            <h3 className="text-base font-semibold text-gray-800 mt-5 mb-2">What We Do Not Do with Meta Data</h3>
            <ul className="list-disc list-inside space-y-1 text-sm leading-relaxed ml-2">
              <li>We do <strong>not</strong> use data from Meta platforms to target users with advertising</li>
              <li>We do <strong>not</strong> sell or share Meta platform data with data brokers or advertisers</li>
              <li>We do <strong>not</strong> use Meta data for any purpose beyond providing and improving the {APP_NAME} service</li>
              <li>We do <strong>not</strong> transfer Meta data to unauthorised third parties</li>
              <li>When a business disconnects a Page, we revoke and remove the stored Page access token and stop further processing. Previously received conversation and customer data may remain until the business requests deletion, closes its account, or a Meta/manual deletion request is completed, subject to legal and financial-retention requirements</li>
              <li>We do <strong>not</strong> use Meta platform data — including message content — to train or improve AI or machine learning models</li>
            </ul>

            <h3 className="text-base font-semibold text-gray-800 mt-5 mb-2">Meta Platform (Messenger)</h3>
            <p className="mb-2 text-sm leading-relaxed">
              {APP_NAME} connects exclusively to Facebook Messenger via the
              Meta Graph API. Message content is used solely to deliver and display conversations within your{' '}
              {APP_NAME} inbox. We comply with Meta's 24-hour messaging window, rate limits, and messaging
              policy requirements.
            </p>

            <h3 className="text-base font-semibold text-gray-800 mt-5 mb-2">Meta Permissions Used</h3>
            <div className="overflow-x-auto mt-2">
              <table className="w-full text-sm border border-gray-200 rounded-lg overflow-hidden">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-gray-700 border-b border-gray-200">Permission</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-700 border-b border-gray-200">Purpose</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  <tr><td colSpan={2} className="px-4 py-2 bg-blue-50 text-xs font-semibold text-blue-700">Facebook Messenger</td></tr>
                  <tr>
                    <td className="px-4 py-3 font-mono text-xs text-blue-700">pages_show_list</td>
                    <td className="px-4 py-3 text-gray-600">List the Facebook Pages the user manages so they can select which Page to connect</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 font-mono text-xs text-blue-700">pages_messaging</td>
                    <td className="px-4 py-3 text-gray-600">Send and receive Facebook Messenger messages on behalf of the connected Page</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 font-mono text-xs text-blue-700">pages_manage_metadata</td>
                    <td className="px-4 py-3 text-gray-600">Subscribe the connected Page to Messenger message webhooks so direct customer DMs are delivered in real time</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <h3 className="text-base font-semibold text-gray-800 mt-5 mb-2">Facebook Data Deletion</h3>
            <p className="mb-2 text-sm leading-relaxed">
              In compliance with Meta's Platform Terms, {APP_NAME} provides a{" "}
              <strong>Data Deletion Request Callback</strong>. When a user removes our app from their Facebook
              settings (Settings &rarr; Apps and Websites), Meta notifies us and we delete all data associated
              with that user's Facebook account within 30 days.
            </p>
            <p className="text-sm leading-relaxed">
              You can also submit a manual deletion request by emailing{" "}
              <a href={`mailto:${CONTACT_EMAIL}`} className="text-blue-600 hover:underline">{CONTACT_EMAIL}</a>{" "}
              with subject <em>"Facebook Data Deletion Request"</em>. We will confirm deletion and provide a
              confirmation code within 30 days.
            </p>
          </section>

          {/* 5 — Bangladesh Data Privacy Compliance */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-4">5. Bangladesh Data Privacy Compliance</h2>
            <p className="mb-3 leading-relaxed">
              {COMPANY_NAME} is incorporated and operating in Bangladesh. We handle personal data in
              compliance with applicable Bangladesh laws and regulations. Bangladesh's data, cyber,
              electronic communications, consumer protection, and financial rules continue to evolve, so
              this policy is reviewed before public launch and after material regulatory changes.
            </p>
            <ul className="list-disc list-inside space-y-2 text-sm leading-relaxed ml-2 mb-4">
              <li>
                <strong>Personal data and data management rules:</strong> We apply data minimisation,
                purpose limitation, access control, correction, deletion, and retention controls to business
                and end-customer data.
              </li>
              <li>
                <strong>Cyber security and electronic communications rules:</strong> We protect against
                unauthorised access, data misuse, and abusive messaging, and we preserve audit evidence
                where required for security review.
              </li>
              <li>
                <strong>Platform and sector rules:</strong> Where applicable, we follow Meta Platform rules,
                Bangladesh communications guidance, consumer-protection expectations, and payment or
                financial-record requirements.
              </li>
            </ul>

            <h3 className="text-base font-semibold text-gray-800 mb-2">RTO Shield and Shared Risk Signals</h3>
            <p className="mb-3 text-sm leading-relaxed">
              RTO Shield may use limited delivery-risk signals such as phone number, courier outcome,
              order value bands, delivery area, and return/cancellation history. It is used only to help
              merchants review COD fulfilment risk. Merchants remain responsible for giving their customers
              appropriate notice and for using any risk signal fairly before refusing or changing an order.
              Customers may request correction, review, or deletion of their related risk data by contacting
              the merchant or emailing {CONTACT_EMAIL}.
            </p>
            <p className="mb-4 text-sm leading-relaxed">
              RTO Shield does not use private message content as a shared risk signal and does not sell risk
              data to advertisers or brokers. Shared risk signals are retained only while needed for fraud
              prevention, dispute handling, and service integrity, then deleted or anonymised.
            </p>

            <h3 className="text-base font-semibold text-gray-800 mb-2">Cross-Border Data Transfers</h3>
            <p className="mb-3 text-sm leading-relaxed">
              Some {APP_NAME} data is processed outside Bangladesh, including on DigitalOcean cloud infrastructure.
              Depending on the feature used and runtime configuration, AI request content may also be sent to
              Google or OpenAI, and operational alert details may be sent to Slack or Sentry. Which providers
              receive data and the countries where it is processed depend on the configured integrations and
              request path. By creating an account and using {APP_NAME}, you acknowledge and consent to these
              transfers when the relevant feature or integration is used. We require third-party providers to
              maintain appropriate data protection standards under applicable Bangladesh law.
            </p>

            <h3 className="text-base font-semibold text-gray-800 mb-2">Data Breach Notification</h3>
            <p className="text-sm leading-relaxed">
              In the event of a data breach that is likely to result in significant harm to your rights and
              interests, we will notify affected business users as promptly as practicable, and will cooperate
              with relevant Bangladesh regulatory authorities where legally required.
            </p>
          </section>

          {/* 6 — Third-Party Service Providers */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-4">6. Third-Party Service Providers</h2>
            <div className="mb-4 rounded-lg border border-blue-100 bg-blue-50 p-4 text-sm leading-relaxed text-blue-950">
              Most merchants only need to know this: we use Meta for Messenger, secure cloud hosting for the app,
              courier providers when you enable them, AI providers to prepare replies, and operational alert sinks
              when configured. If payment-evidence OCR is used, the screenshot may be sent to Google Gemini when
              available and to OpenAI if the configured provider chain reaches it. Customer conversation data is
              not used to train provider models.
            </div>
            <p className="mb-4 leading-relaxed">
              To operate {APP_NAME}, we share data with the following categories of third-party service
              providers. Each provider has their own privacy policy and data processing terms.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm border border-gray-200 rounded-lg overflow-hidden">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-gray-700 border-b border-gray-200">Service</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-700 border-b border-gray-200">Category</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-700 border-b border-gray-200">Data Shared</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-700 border-b border-gray-200">Purpose</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-700 border-b border-gray-200">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  <tr>
                    <td className="px-4 py-3 font-medium text-gray-900">Meta (Facebook)</td>
                    <td className="px-4 py-3 text-gray-600">Communication Platform</td>
                    <td className="px-4 py-3 text-gray-600">Message content, user IDs</td>
                    <td className="px-4 py-3 text-gray-600">Webhook message delivery</td>
                    <td className="px-4 py-3 text-emerald-700">Active</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 font-medium text-gray-900">Google (Gemini)</td>
                    <td className="px-4 py-3 text-gray-600">AI provider</td>
                    <td className="px-4 py-3 text-gray-600">Conversation text for reply generation; submitted payment screenshots for OCR if Gemini is configured and reached (not used for training)</td>
                    <td className="px-4 py-3 text-gray-600">Reply generation and conditional payment-evidence OCR for merchant review</td>
                    <td className="px-4 py-3 text-gray-500">Only if configured and used</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 font-medium text-gray-900">OpenAI</td>
                    <td className="px-4 py-3 text-gray-600">Reply provider</td>
                    <td className="px-4 py-3 text-gray-600">Conversation text and private search signals; submitted payment screenshots if OCR fallback reaches OpenAI, including when Gemini is unavailable (not used for training)</td>
                    <td className="px-4 py-3 text-gray-600">Fallback reply generation, FAQ search, and conditional payment-evidence OCR</td>
                    <td className="px-4 py-3 text-gray-500">Only if configured and used</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 font-medium text-gray-900">Qdrant (self-hosted)</td>
                    <td className="px-4 py-3 text-gray-600">Private search index</td>
                    <td className="px-4 py-3 text-gray-600">Private search signals for FAQs and shop answers</td>
                    <td className="px-4 py-3 text-gray-600">FAQ and shop-answer search on our own infrastructure</td>
                    <td className="px-4 py-3 text-emerald-700">Active</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 font-medium text-gray-900">Pathao</td>
                    <td className="px-4 py-3 text-gray-600">Delivery Provider</td>
                    <td className="px-4 py-3 text-gray-600">Customer name, phone, delivery address</td>
                    <td className="px-4 py-3 text-gray-600">Courier delivery</td>
                    <td className="px-4 py-3 text-emerald-700">Active</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 font-medium text-gray-900">Steadfast</td>
                    <td className="px-4 py-3 text-gray-600">Delivery Provider</td>
                    <td className="px-4 py-3 text-gray-600">Customer name, phone, delivery address, COD amount</td>
                    <td className="px-4 py-3 text-gray-600">Courier delivery</td>
                    <td className="px-4 py-3 text-emerald-700">Active</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 font-medium text-gray-900">RedX</td>
                    <td className="px-4 py-3 text-gray-600">Delivery Provider</td>
                    <td className="px-4 py-3 text-gray-600">Customer name, phone, delivery address, COD amount</td>
                    <td className="px-4 py-3 text-gray-600">Courier delivery</td>
                    <td className="px-4 py-3 text-emerald-700">Active</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 font-medium text-gray-900">DigitalOcean</td>
                    <td className="px-4 py-3 text-gray-600">Cloud Infrastructure</td>
                    <td className="px-4 py-3 text-gray-600">All application data</td>
                    <td className="px-4 py-3 text-gray-600">Hosting and storage</td>
                    <td className="px-4 py-3 text-emerald-700">Active</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 font-medium text-gray-900">Resend</td>
                    <td className="px-4 py-3 text-gray-600">Transactional Email</td>
                    <td className="px-4 py-3 text-gray-600">Business user email address and message content</td>
                    <td className="px-4 py-3 text-gray-600">Account verification, password reset, invoices</td>
                    <td className="px-4 py-3 text-emerald-700">Active</td>
                  </tr>
                  <tr className="bg-gray-50/60">
                    <td className="px-4 py-3 font-medium text-gray-900">bKash subscription billing</td>
                    <td className="px-4 py-3 text-gray-600">Payment Gateway</td>
                    <td className="px-4 py-3 text-gray-600">Payer name and phone, shop ID, invoice number, and payment amount</td>
                    <td className="px-4 py-3 text-gray-600">EasyModerator subscription invoices and conversation top-ups</td>
                    <td className="px-4 py-3 text-gray-500">Only if platform billing is enabled</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 font-medium text-gray-900">Configured operations-alert webhook</td>
                    <td className="px-4 py-3 text-gray-600">Operations alerting</td>
                    <td className="px-4 py-3 text-gray-600">Escalation type, conversation and shop IDs, priority, and violation categories; no customer message or AI response content</td>
                    <td className="px-4 py-3 text-gray-600">Route guardrail escalations for human review</td>
                    <td className="px-4 py-3 text-gray-500">Only if configured</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 font-medium text-gray-900">Configured Slack webhook / Sentry</td>
                    <td className="px-4 py-3 text-gray-600">Operational alerting and error monitoring</td>
                    <td className="px-4 py-3 text-gray-600">Alert titles, diagnostic details, and context; may include shop, Page, conversation, order, message, job, or receipt IDs, status, administrator ID for test alerts, and error text</td>
                    <td className="px-4 py-3 text-gray-600">Reliability monitoring and incident response</td>
                    <td className="px-4 py-3 text-gray-500">Only where configured</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-sm text-gray-600 leading-relaxed">
              AI providers receive content needed for the requested task: conversation text for reply generation,
              and, if the payment-evidence OCR path is used, the screenshot may be sent to whichever configured
              provider the fallback chain reaches. Google Gemini may process it first; OpenAI may also receive it
              if that provider is configured and reached. Provider configuration and request outcomes determine
              which providers receive the screenshot. Extracted transaction details may be stored for merchant
              review.
              <strong> We do not permit any provider to use your data for training their models.</strong>
              We isolate each business's private search data so one business cannot retrieve another
              business's information. The legacy Make.com/n8n event-forwarding integrations are retired. A
              configured operations-alert webhook is separate and may receive only the guardrail-escalation
              metadata listed above, not customer messages or AI responses. Separately, general alert titles,
              diagnostic details, and context may be sent to configured Slack or Sentry sinks as described above.
            </p>
          </section>

          {/* 7 — Data Retention */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-4">7. Data Retention</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm border border-gray-200 rounded-lg overflow-hidden">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-gray-700 border-b border-gray-200">Data Type</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-700 border-b border-gray-200">Retention Period</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  <tr>
                    <td className="px-4 py-3 text-gray-800">Business user accounts</td>
                    <td className="px-4 py-3 text-gray-600">Until account deletion is requested</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 text-gray-800">Customer profiles and conversation history</td>
                    <td className="px-4 py-3 text-gray-600">Until the business deletes them or closes their account; PII is nullified on deletion</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 text-gray-800">Order records</td>
                    <td className="px-4 py-3 text-gray-600">Until the business deletes them or closes their account</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 text-gray-800">RTO Shield shared risk signals</td>
                    <td className="px-4 py-3 text-gray-600">Retained while needed for fraud prevention and dispute handling, then deleted or anonymised</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 text-gray-800">Authentication cookies</td>
                    <td className="px-4 py-3 text-gray-600">Access token: 24 hours; Refresh token: 7 days</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 text-gray-800">Security audit logs</td>
                    <td className="px-4 py-3 text-gray-600">Retained for compliance and security review purposes</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 text-gray-800">Subscription and billing records</td>
                    <td className="px-4 py-3 text-gray-600">Retained for financial compliance purposes</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 text-gray-800">FAQs and shop answers</td>
                    <td className="px-4 py-3 text-gray-600">Until deleted by the business; related private search data is deleted at the same time</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          {/* 8 — Data Security */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-4">8. Data Security</h2>
            <p className="mb-3 leading-relaxed">
              We implement industry-standard security measures to protect your data:
            </p>
            <ul className="list-disc list-inside space-y-1 text-sm leading-relaxed ml-2">
              <li>All data in transit is protected by TLS (HTTPS)</li>
              <li>Meta access tokens and payment credentials are encrypted at rest using AES-256-GCM</li>
              <li>Authentication uses short-lived JWT tokens stored as httpOnly cookies, inaccessible to JavaScript</li>
              <li>Passwords are hashed using bcrypt and never stored in plain text</li>
              <li>Tenant isolation ensures each business's data is logically separated from others</li>
              <li>Production secrets are stored in the server's protected environment configuration and the deployment CI secret store, and are never committed to source control</li>
              <li>Rate limiting and CSRF protection are enforced on all state-mutating endpoints</li>
              <li>Security audit logs record all significant actions with IP address and user agent</li>
            </ul>
            <p className="mt-3 text-sm leading-relaxed">
              While we take reasonable steps to protect your information, no system is completely secure. We
              encourage business users to use strong passwords and report any suspected security issues to{" "}
              <a href={`mailto:${CONTACT_EMAIL}`} className="text-blue-600 hover:underline">{CONTACT_EMAIL}</a>.
            </p>
          </section>

          {/* 9 — Cookies and Authentication */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-4">9. Cookies and Authentication</h2>
            <p className="mb-3 leading-relaxed">
              {APP_NAME} uses strictly necessary authentication cookies. We do not use advertising cookies
              or third-party profiling trackers. Our public website records limited first-party funnel events
              with a random session identifier stored in browser session storage so we can understand whether
              onboarding works; those events are not used for cross-site advertising.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm border border-gray-200 rounded-lg overflow-hidden">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-gray-700 border-b border-gray-200">Cookie</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-700 border-b border-gray-200">Purpose</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-700 border-b border-gray-200">Duration</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  <tr>
                    <td className="px-4 py-3 font-mono text-xs text-blue-700">access_token</td>
                    <td className="px-4 py-3 text-gray-600">Authenticates API requests (httpOnly, secure, sameSite=lax)</td>
                    <td className="px-4 py-3 text-gray-600">24 hours</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 font-mono text-xs text-blue-700">refresh_token</td>
                    <td className="px-4 py-3 text-gray-600">Renews the access token without re-login (httpOnly, secure, sameSite=lax)</td>
                    <td className="px-4 py-3 text-gray-600">7 days</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-sm leading-relaxed">
              These cookies are strictly necessary for the service to function. You can delete them by logging
              out, which blacklists the tokens on our server.
            </p>
          </section>

          {/* 10 — Your Rights */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-4">10. Your Rights</h2>
            <p className="mb-3 leading-relaxed">
              You have the following rights regarding your personal data:
            </p>
            <ul className="list-disc list-inside space-y-2 text-sm leading-relaxed ml-2">
              <li><strong>Access:</strong> Request a copy of the personal data we hold about you.</li>
              <li><strong>Correction:</strong> Request correction of inaccurate or incomplete data.</li>
              <li><strong>Deletion:</strong> Request deletion of your personal data. Business users may delete their account; end-customers may request deletion through the business that collected their data.</li>
              <li><strong>Portability:</strong> Request your data in a machine-readable format.</li>
              <li><strong>Objection:</strong> Object to certain types of processing.</li>
              <li><strong>Withdraw Consent:</strong> Where processing is based on consent, you may withdraw it at any time without affecting the lawfulness of prior processing.</li>
            </ul>
            <p className="mt-3 text-sm leading-relaxed">
              To exercise any of these rights, email us at{" "}
              <a href={`mailto:${CONTACT_EMAIL}`} className="text-blue-600 hover:underline">{CONTACT_EMAIL}</a>. We
              will respond within 30 days.
            </p>
          </section>

          {/* 11 — Data Deletion */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-4">11. Data Deletion Request</h2>
            <p className="mb-3 leading-relaxed">
              You may request deletion of your data at any time:
            </p>
            <ul className="list-disc list-inside space-y-2 text-sm leading-relaxed ml-2">
              <li>
                <strong>Business users:</strong> Email{" "}
                <a href={`mailto:${CONTACT_EMAIL}`} className="text-blue-600 hover:underline">{CONTACT_EMAIL}</a>{" "}
                with subject "Account Deletion Request". We will delete your account and associated shop data
                within 30 days.
              </li>
              <li>
                <strong>End-customers:</strong> Contact the business that collected your information directly.
                Businesses operating on {APP_NAME} are responsible for honoring their customers' deletion
                requests. If you cannot reach the business, email us and we will facilitate the deletion.
              </li>
              <li>
                <strong>Meta / Facebook data deletion:</strong> If you connected a Facebook Page
                to {APP_NAME} and later disconnect or remove the app from your Facebook settings:
                if Meta sends a valid data deletion callback for this app, we process it and delete
                associated data within 30 days, subject to legal and financial-retention requirements. You can
                request or verify deletion by emailing{" "}
                <a href={`mailto:${CONTACT_EMAIL}`} className="text-blue-600 hover:underline">{CONTACT_EMAIL}</a>{" "}
                with subject <em>"Facebook Data Deletion Request"</em>. We will reply with a deletion
                confirmation code.
              </li>
            </ul>
            <div className="mt-4 rounded-xl border border-blue-100 bg-blue-50 p-4 text-sm text-blue-800">
              <p className="font-semibold mb-1">Meta Data Deletion Callback URL</p>
              <p className="leading-relaxed">
                If Meta sends a valid callback, it is received at:<br />
                <span className="font-mono text-xs break-all">POST https://api.easymod.tech/webhooks/meta/data-deletion</span>
              </p>
              <p className="mt-2 leading-relaxed">
                Confirmation codes issued upon deletion are valid for 90 days. To check the status of a
                deletion, email{" "}
                <a href={`mailto:${CONTACT_EMAIL}`} className="text-blue-700 hover:underline font-medium">{CONTACT_EMAIL}</a>{" "}
                with your confirmation code.
              </p>
            </div>
          </section>

          {/* 12 — Children's Privacy */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-4">12. Children's Privacy</h2>
            <p className="leading-relaxed">
              {APP_NAME} is a business tool intended for adults operating commercial enterprises. We do not
              knowingly collect personal information from children under the age of 18. If you believe a child
              has provided us with personal information, please contact us at{" "}
              <a href={`mailto:${CONTACT_EMAIL}`} className="text-blue-600 hover:underline">{CONTACT_EMAIL}</a>{" "}
              and we will delete it promptly.
            </p>
          </section>

          {/* 13 — Governing Law */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-4">13. Governing Law and Jurisdiction</h2>
            <p className="leading-relaxed">
              This Privacy Policy and any disputes arising from it are governed by the laws of the{" "}
              <strong>People's Republic of Bangladesh</strong>. Any disputes shall be subject to the
              exclusive jurisdiction of the competent courts of Dhaka, Bangladesh.
            </p>
          </section>

          {/* 14 — Changes */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-4">14. Changes to This Policy</h2>
            <p className="leading-relaxed">
              We may update this Privacy Policy from time to time. When we make material changes, we will
              update the "Last updated" date at the top of this page and, where appropriate, notify business
              users by email. Your continued use of {APP_NAME} after changes become effective constitutes
              acceptance of the revised policy.
            </p>
          </section>

          {/* 15 — Contact */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-4">15. Contact Us</h2>
            <p className="mb-3 leading-relaxed">
              If you have questions about this Privacy Policy, wish to exercise your rights, or need to report
              a privacy concern, please contact us:
            </p>
            <div className="rounded-xl border border-gray-200 bg-white p-5 text-sm space-y-1">
              <p className="font-semibold text-gray-900">{COMPANY_NAME}</p>
              <p className="text-gray-600">
                Parent company:{" "}
                <a href={COMPANY_URL} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                  hexabyte.tech
                </a>
              </p>
              <p className="text-gray-600">
                Privacy &amp; Data:{" "}
                <a href={`mailto:${CONTACT_EMAIL}`} className="text-blue-600 hover:underline">
                  {CONTACT_EMAIL}
                </a>
              </p>
              <p className="text-gray-600">Subject line: <em>Privacy Inquiry</em></p>
            </div>
          </section>

        </div>

        {/* Back to top / footer */}
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
