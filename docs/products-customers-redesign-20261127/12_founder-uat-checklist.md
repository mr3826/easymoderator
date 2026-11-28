# Founder UAT Checklist

## Products and Editor

- [ ] Create a simple product with only name and price.
- [ ] Edit a product without changing values; confirm stored values remain unchanged.
- [ ] Clear description, SKU, brand, category, threshold, tags, variants, and all images.
- [ ] Verify `image_url` matches the selected primary image after reorder and save.
- [ ] **DECISION (explicit change-acceptance — the OLD web editor created TRACKED products, `track_quantity:true`; this redesign switches web creates to the untracked model default, see `14_…md` §1.1):** Accept the new untracked-inventory default (new products: `track_quantity=false`, quantity 0 on the editor path, availability carried only by `in_stock`; consequences FU-PC-01 mobile label included) — or choose the tracked-by-default flip. Full demonstrated consequences for the chatbot, order eligibility, overview tiles, and the mobile app, plus the exact lines a flip would touch, are in `14_untracked-inventory-uat-decision.md` (§3 options A/B/C, §6 pilot verification steps; §4 lists pre-existing cross-surface findings deliberately out of this PR's scope). Enabling tracking starts quantity at zero.
- [ ] Verify tracked and untracked inventory copy and stock badge parity.
- [ ] Confirm option-group names validate, SKU/price adjustment stay under the optional catalog metadata disclosure, relational variants are read-only, and legacy string variants do not fail unrelated edits.
- [ ] Simulate upload and save failures; verify input and successful uploads are retained.
- [ ] Import CSV/TSV/TXT, edit rows, approve one row twice, and exercise partial bulk failure.
- [ ] Cancel extraction while it is in flight and verify no later review dialog opens.
- [ ] Import a Bangla-digit price and a duplicate/unmatched category; verify price parsing and visible category mapping guidance.

## Categories

- [ ] Search roots and children; create, edit, and associate categories by ID.
- [ ] Verify active product counts, inactive category visibility/reactivation, and child counts.
- [ ] Attempt deletion with active and inactive product associations/children and verify the complete impact warning before confirmation.

## Customers

- [ ] With the pilot off, create/edit/delete an authorized customer and open the legacy drawer and phone order lookup.
- [ ] With the pilot on, search by name and phone, filter by channel, and paginate.
- [ ] Clear a customer's email and confirm the stored value is removed; omit email from an edit and confirm it is unchanged.
- [ ] Delete the last row on the last page and confirm pagination returns to a valid page in both modes.
- [ ] Enter Bangla-script phone digits in phone search and confirm the same Bangladesh number is found.
- [ ] Verify visible overview definitions/coverage, that new buyers are unavailable when delivery dates/scan coverage are incomplete, and customer detail conversations, notes/tags, opportunities, and advisory RTO.
- [ ] Confirm call and inbox actions remain available without a conversation, the inbox opens with that customer filtered, and no message is sent directly.

## Accessibility and Localization

- [ ] At 360px and 390px, confirm no horizontal page scroll and usable touch targets.
- [ ] Complete list, editor, delete, and customer flows using keyboard only.
- [ ] Check Bengali and English labels/numbers and reduced-motion behavior.
