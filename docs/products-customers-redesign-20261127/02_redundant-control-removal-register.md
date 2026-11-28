# Redundant Control Removal Register

| Removed or constrained control | Reason | Replacement or preservation |
|---|---|---|
| Condition, warranty, expiry, dimensions, shipping class, handling time, and free-shipping fields | No product database column or runtime consumer. | Removed from product draft and write payload. |
| `allow_discounts`, `charge_tax`, and `send_low_stock_alert` toggles | Stored with no reader or active engine. | No longer rendered or written; update requests omit these values. |
| AI-generated source filter/column and persisted confidence | Product rows have no authoritative AI provenance columns. | Keep only the transient extraction label and display confidence as parse completeness in AI review. |
| Hidden-field product modal | It saved controls that the modal did not expose. | One full-page create/edit editor with dirty-only PATCH behavior. |
| Broken category image picker | It produced blob URLs without a server upload contract. | Remove until category image upload exists. |
| Non-persisting nested child editor | The editor mutated local React state only — no add/edit/delete child call fired any API, and `handleUpdate`'s `updateCategory` payload omitted children entirely (baseline `SubcategoryDetails.tsx:86-98,114-126`), so edits vanished on reload. | Keep hierarchy management to supported root/subcategory CRUD. |
| Unsupported prototype actions: trust score, COD block/unblock, identity merge, bulk publish/archive, saved views, drag reorder, QR preview, per-page AI pause, and unbacked exports | No authoritative service/API contract and/or outside mission scope. | Do not implement; retain evidence-backed customer/product actions only. |

Removal is limited to controls with no working backend contract; working create/edit, imports, stock management, customer records, and category associations remain in scope.
