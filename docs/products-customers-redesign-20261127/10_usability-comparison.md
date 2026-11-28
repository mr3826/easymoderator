# Usability Comparison

| Measure | Before | Target after | Evidence |
|---|---|---|---|
| Product editor controls | About 20 controls, including unsupported fields. | Progressive disclosure around persisted essentials, inventory, variations, and additional settings. | Requires task-based observation. |
| Edit safety | Empty values were omitted; hidden values could be written. | Explicit null/empty-list clears; untouched values omitted. | Serializer and failure-path tests. |
| Product stock trust | Parent quantity could disagree with variant-aware filters. | List row and filter use the same effective-stock authority. | Stock parity tests. |
| Customer workflow continuity | Pilot mode removed legacy CRUD, channel/phone filters, and order lookup. | One shell preserves workflows in both flag modes. | Flag-path tests and merchant UAT. |
| Mobile discoverability | Not yet measured. | Cards and compact controls at 390px with no horizontal scroll at 360px. | Screenshot and device-width checks. |

No completion-time or discoverability measurements are claimed until observed with merchants.
