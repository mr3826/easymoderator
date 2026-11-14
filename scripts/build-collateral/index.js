#!/usr/bin/env node
'use strict';

/**
 * build:collateral — renders the commercial one-pager from the frozen contract.
 *
 * No price or term is typed here: every number comes from
 * `EasyMod-backend/src/modules/commercial/commercial.contract.js`, and the
 * footer carries the contract version, contract hash and registry hash so a
 * reader can detect drift. The scanner's collateral check compares the
 * committed file with this renderer's output.
 *
 * Usage:
 *   node scripts/build-collateral/index.js           # write the file
 *   node scripts/build-collateral/index.js --stdout  # print, do not write
 */

const fs = require('fs');
const path = require('path');

const contract = require('../../EasyMod-backend/src/modules/commercial/commercial.contract');
const { registryHash } = require('../../EasyMod-backend/src/modules/commercial/claim.registry');
const { SUPPORTED_PROVIDERS } = require('../../EasyMod-backend/src/modules/commercial/evidence-authorities');
const { PROVIDER_CAPABILITIES } = require('../../EasyMod-backend/src/modules/delivery/provider-capabilities');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ONE_PAGER_REL_PATH = 'docs/collateral/easymoderator-one-pager.md';
const onePagerAbsolutePath = (root = REPO_ROOT) => path.join(root, ONE_PAGER_REL_PATH);

const liveProviders = () => SUPPORTED_PROVIDERS.filter(
    (provider) => PROVIDER_CAPABILITIES[provider] && PROVIDER_CAPABILITIES[provider].last_verified_at !== null,
);

function renderOnePager() {
    const c = contract.COMMERCIAL_CONTRACT;
    const priceEn = contract.formatBdt(c.unitPriceMinor);
    const priceBn = contract.formatBdtBn(c.unitPriceMinor);
    const zeroEn = c.zeroRatedOutcomes.join(', ');
    const zeroBn = c.zeroRatedOutcomes.join(', ');
    const live = liveProviders();
    const total = SUPPORTED_PROVIDERS.length;
    const scope = `${live.length} of ${total}`;
    const overdue = c.onOverdue;

    return [
        '<!-- GENERATED FILE — do not edit by hand. Regenerate with `npm run build:collateral` (scripts/build-collateral/index.js). -->',
        '',
        '# EasyModerator — Commercial One-Pager',
        '',
        `Contract version **${contract.COMMERCIAL_CONTRACT_VERSION}** · currency **${c.currency}** · model **${c.model}**`,
        '',
        '## English',
        '',
        `**Model:** Delivered-order billing (\`${c.model}\`), monthly postpaid.`,
        '',
        `**Price:** ${priceEn} per provider-confirmed delivered order, from the first order, for every shop.`,
        '',
        `**Zero-rated outcomes (no charge):** ${zeroEn}.`,
        '',
        `**Payment:** Monthly postpaid. Invoice due within ${c.dueDays} days.`,
        '',
        '**If an invoice is overdue:**',
        '',
        `- New courier bookings: ${overdue.blockCourierBooking ? 'blocked' : 'allowed'}.`,
        `- Automated AI replies: ${overdue.pauseAutomatedAi ? 'paused' : 'running'}.`,
        `- Manual inbox: ${overdue.keepInboxReadable ? 'stays readable' : 'unavailable'}.`,
        `- History: ${overdue.keepHistoryReadable ? 'stays readable' : 'unavailable'}.`,
        `- Merchant data: ${overdue.deleteData ? 'may be deleted' : 'never deleted'}.`,
        '',
        `**Courier scope:** Pathao, Steadfast and RedX integration code is present.`,
        `Live-verified for booking: ${scope} providers.`,
        '',
        '## বাংলা',
        '',
        `**মডেল:** ডেলিভারি-ভিত্তিক বিলিং (\`${c.model}\`), মাসিক পোস্টপেইড।`,
        '',
        `**মূল্য:** প্রতিটি প্রোভাইডার-নিশ্চিত ডেলিভারি করা অর্ডারে ${priceBn}, প্রথম অর্ডার থেকেই, সব দোকানের জন্য।`,
        '',
        `**যেসব ফলাফলে কোনো চার্জ নেই:** ${zeroBn}।`,
        '',
        `**পেমেন্ট:** মাসিক পোস্টপেইড। ইনভয়েস ${contract.toBengaliNumerals(String(c.dueDays))} দিনের মধ্যে পরিশোধযোগ্য।`,
        '',
        '**ইনভয়েস বিলম্বিত হলে:**',
        '',
        `- নতুন কুরিয়ার বুকিং: ${overdue.blockCourierBooking ? 'বন্ধ' : 'চালু'}।`,
        `- স্বয়ংক্রিয় AI উত্তর: ${overdue.pauseAutomatedAi ? 'বিরত' : 'চালু'}।`,
        `- ম্যানুয়াল ইনবক্স: ${overdue.keepInboxReadable ? 'পড়া যায়' : 'পড়া যায় না'}।`,
        `- ইতিহাস: ${overdue.keepHistoryReadable ? 'পড়া যায়' : 'পড়া যায় না'}।`,
        `- দোকানের ডেটা: ${overdue.deleteData ? 'মুছে ফেলা হতে পারে' : 'কখনোই মুছে ফেলা হয় না'}।`,
        '',
        `**কুরিয়ার পরিধি:** Pathao, Steadfast ও RedX এর কোড আছে।`,
        `বুকিংয়ের জন্য লাইভ যাচাই: ${contract.toBengaliNumerals(String(total))} টির মধ্যে ${contract.toBengaliNumerals(String(live.length))} টি।`,
        '',
        '---',
        '',
        `EasyModerator commercial contract v${contract.COMMERCIAL_CONTRACT_VERSION} · contract \`${contract.contractHash}\` · registry \`${registryHash}\``,
        '',
    ].join('\n');
}

function writeOnePager(root = REPO_ROOT) {
    const target = onePagerAbsolutePath(root);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, renderOnePager(), 'utf8');
    return target;
}

function main() {
    const stdout = process.argv.includes('--stdout');
    if (stdout) {
        process.stdout.write(renderOnePager());
        return;
    }
    const target = writeOnePager();
    process.stdout.write(`build-collateral: wrote ${path.relative(REPO_ROOT, target).split(path.sep).join('/')}\n`);
}

if (require.main === module) main();

module.exports = {
    renderOnePager,
    writeOnePager,
    ONE_PAGER_REL_PATH,
    onePagerAbsolutePath,
    REPO_ROOT,
};