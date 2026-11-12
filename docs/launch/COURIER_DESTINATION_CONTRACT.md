# Courier destination contract

A parcel can only be booked when the courier receives a destination it can
route. That destination belongs to the **order**, not to the merchant's pickup
location, and this document is the single description of how it is recorded,
confirmed and used.

## Where a destination lives

| Field | Column | Shape |
|---|---|---|
| Address the customer gave | `orders.delivery_address` | structured JSON or free text (unchanged) |
| Canonical destination carrier | `orders.delivery_location` (TEXT, JSON) | `{ full_address, area_name?, provider_destination: { <provider>: {...} } }` |
| Legacy single area name | `orders.delivery_area` (TEXT) | the human-readable area, e.g. `Mirpur` |

No migration is required: `delivery_location` already exists and holds JSON.
Confirmed courier ids are namespaced **per provider** under
`provider_destination`:

```json
{
  "full_address": "House 4, Road 12, Mirpur 10, Dhaka",
  "provider_destination": {
    "redx": { "area_id": 77, "area_name": "Mirpur", "district": "Dhaka",
              "confirmed_at": "2026-11-04T10:00:00.000Z", "confirmed_by": "<user id>",
              "source": "merchant_confirmed" },
     "pathao": { "city_id": 1, "zone_id": 2, "area_id": 3,
                 "confirmed_at": "...", "confirmed_by": "<user id>",
                 "source": "merchant_confirmed" }
  }
}
```

A RedX area id is never read as a Pathao area id: every read names a provider
first. The address text is never overwritten by a confirmation, and the audit
trail (`metadata.audit_log`) records every change of a confirmed destination.

## How it is resolved at booking time

1. If the order has a confirmed selection for **that** provider, its ids win.
2. Otherwise the address text is used (`area`, `area_name`, `upazila`, then the
   legacy `delivery_area`), and the provider's own directory is asked to match
   it. Legacy unnamespaced ids may help a live lookup, but are never forwarded
   unless that lookup verifies them. Dhaka thanas are listed as *upazila* by
   the BD administrative data and as *area* by the couriers; the same place,
   two vocabularies.
3. The directory answer decides: `SERVICEABLE`, `NOT_SERVICEABLE` (the
   directory was readable and does not contain the destination),
   `UNCERTAIN` (not enough information to ask), `CHECK_UNAVAILABLE` (the
   directory could not be read).

Two independent questions are kept apart:

- **Serviceability policy** — `COURIER_SERVICEABILITY_ENFORCE`. When off, a
  `NOT_SERVICEABLE` answer is advisory.
- **Payload validity** — never shadowed. A booking without provider routing ids
  is refused before the provider call, whatever the policy says. In advisory
  mode a previously confirmed id may still be sent; a raw, unconfirmed id is
  never sufficient.

`COURIER_DESTINATION_RESOLUTION_ENABLED=false` disables automatic booking-time
resolution and new confirmation requests (which return 503). It does **not**
discard ids the server recorded after a merchant confirmed that courier's
directory selection. Unnamespaced or otherwise unconfirmed ids are refused
when no live directory check can verify them.

## Confirming a destination (the correction path)

```
PUT /api/order/:orderId/courier/destination
{ "provider": "redx" | "pathao", "area_id": ..., "area_name": ...,
  "city_id": ..., "zone_id": ..., ... }
```

Server behaviour, in order:

1. the caller must belong to the order's shop;
2. the order is read under a row lock; active/committed dispatch claims and
   legacy tracking state refuse the change (the parcel already carries its
   destination);
3. the courier must be connected and ready for the shop;
4. the selection is **re-read from the courier's own directory** — the client
   supplies ids to look up, never ids to trust;
5. a selection the directory does not serve is refused
   (`COURIER_DESTINATION_INVALID_SELECTION`), an unreachable directory is
   reported as `COURIER_DIRECTORY_UNAVAILABLE` (503) instead of blaming the
   selection;
6. only then are the ids stored, merged under the provider, with an audit
   entry.

Generic order updates cannot write `delivery_location`
(`400 COURIER_DESTINATION_CONFIRM_REQUIRED`): an unvalidated id would be trusted
by the next booking, which is the defect this contract removes. Order creation
may preserve address text but cannot inject `provider_destination`; only the
confirmation endpoint writes a trusted provider selection. An authorized edit
to `delivery_address` or `delivery_area` clears every prior provider selection
and unnamespaced legacy route id/name, updates the canonical full address and
area text, and requires a fresh directory resolution before booking.

Directory browsing reuses the existing read-only endpoints:

```
GET /api/shop/delivery/:provider/areas
GET /api/shop/delivery/pathao/cities
GET /api/shop/delivery/pathao/cities/:cityId/zones
GET /api/shop/delivery/pathao/zones/:zoneId/areas
```

These reads require authentication and active shop membership, not owner-only
access; booking-capable staff need to use the same directories.

## Failure vocabulary shown to merchants

| Code | Status | What it means, and the next step |
|---|---|---|
| `COURIER_DESTINATION_CONTRADICTED` | 409 | An area **is** recorded and the courier's directory does not serve it. Pick a different area, or another courier. |
| `COURIER_DESTINATION_PAYLOAD_INVALID` | 409 | No usable area is recorded. Record one from the courier's list. |
| `COURIER_DESTINATION_NOT_SERVICEABLE` | 409 | Enforcement is on and the directory does not serve the destination. |
| `COURIER_DESTINATION_INVALID_SELECTION` | 409 | The chosen area is not in that courier's list. Choose another. |
| `COURIER_DESTINATION_SELECTION_INCOMPLETE` | 400 | The selection is missing keys that courier needs. |
| `COURIER_DIRECTORY_UNAVAILABLE` | 503 | The courier's list could not be read. Retry; this is not a verdict. |
| `COURIER_DISPATCH_ACTIVE` | 409 | A parcel is already with the courier. Reconcile it before changing the destination. |

## Provider specifics

- **RedX** — one required key, `area_id`, validated against `GET /areas`.
- **Pathao** — `city_id`, `zone_id`, `area_id`, each validated against its
  parent list.
- **Steadfast** — books by text address and publishes no destination
  directory. It is never given a manufactured coverage verdict, and
  confirmation for it returns `COURIER_DESTINATION_NOT_REQUIRED`.
  AI-path courier booking is denied at production defaults
  (`AI_COURIER_BOOKING_ENABLED` is fail-closed outside development, pinned by
  `production-defaults-matrix.test.js`), and the address it books from is the
  customer-confirmed order address (`CREATE_ORDER` requires confirmation) —
  never a solely AI-inferred destination.

## Intake

- Manual order form and storefront checkout record district + delivery
  area/thana (`delivery_address.area`, also sent as `delivery_area`). Storefront
  checkout requires an area or upazila; its first-party form sends the selected
  area as both values when they are the same.
- Chatbot orders keep the buyer's own words verbatim in
  `delivery_location.full_address`. A conversation cannot pick a courier area
  without guessing, so the merchant confirms one from the order once — which is
  exactly what the confirmation endpoint exists for.
