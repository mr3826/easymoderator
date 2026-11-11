# EasyModerator DNS cutover runbook - 2026-11-11

Operator: migration lead only. DNS is mutated by one script, run by hand.
Related plan: `C:\Users\ahmee\.claude\plans\synthetic-dazzling-starfish.md` (sections "DNS / email" and Gate 4).

## 1. Scope

Move production traffic from the DigitalOcean droplet `139.59.249.141` to the
Oracle Cloud public IP by changing **only these five A records** in Cloudflare
zone `249e02c98e660449093f4ef708bbbc91` (`easymod.tech`, active, type `full`):

| Name | Type | Current value | Record id |
|---|---|---|---|
| `easymod.tech` | A | 139.59.249.141 | `47a7080a87666e30cbba875b17b46f5b` |
| `www.easymod.tech` | A | 139.59.249.141 | `41f9a7d42a08bd210fc788cea43bdb16` |
| `app.easymod.tech` | A | 139.59.249.141 | `a871298429968a436f802e9df0f13100` |
| `api.easymod.tech` | A | 139.59.249.141 | `23de956f1a2239217f859229d29fd020` |
| `growth.easymod.tech` | A | 139.59.249.141 | `ed936347b777c9bdda6a2ef6e367317a` |

Every record in the zone stays **DNS only (`proxied=false`)** and **TTL 1 (Auto)**.
Caddy owns TLS/ACME on the host; proxying a record breaks certificate issuance.

Scripts:

- `scripts/cloudflare/dns-cutover.ps1 -NewIP <oci-ip> [-DryRun]`
- `scripts/cloudflare/dns-rollback.ps1 [-DryRun]` (hard target `139.59.249.141`)

Both read the API token and zone id from the **current user's environment**
(`EASYMOD_CLOUDFLARE_KEY`, `EASYMOD_CLOUDFLARE_ID`). Never pass them as
parameters, never print them, never put them in a command line or log.

## 2. Never-touch rule (hard)

The cutover scripts only match type `A`. They hard-abort if any A record exists
outside the five names above, if a target is missing or duplicated, or if
`proxied`/`ttl` deviate from `false`/`1`.

These rows are **NEVER** written, edited, deleted or re-created:

- MX: `mx1.privateemail.com`, `mx2.privateemail.com` (apex, priority 10)
- MX: `send` -> `feedback-smtp.ap-northeast-1.amazonses.com` (priority 10)
- TXT: apex SPF `v=spf1 include:spf.privateemail.com ~all`
- TXT: `_dmarc` `v=DMARC1; p=none;`
- TXT: `default._domainkey` (DKIM RSA public key)
- TXT: `send` SPF `v=spf1 include:amazonses.com ~all`
- TXT: `resend._domainkey` (`p=MIGf...`, no `v=DKIM1` prefix - intentional)

Breaking any of these breaks login mail, password resets, Resend transactional
mail or DMARC alignment. The cutover script takes a signature of all non-A
records before the run and re-checks it afterwards; a difference exits non-zero.
A dashboard edit during the window would be caught by that check and must be
treated as an incident, not a convenience.

## 3. Preconditions - Gate 4 must already be verified on OCI

Do not run a live cutover until all of the following are true:

1. **Immutable SHA deployed** through the protected release flow, and
   `https://<oci-ip>/version` (or the host after a hosts-file override) returns
   `gitSha` equal to the deployed `main` commit. No bare HTTP 200 is accepted.
2. **TLS is live on the new host** for `easymod.tech`, `www.easymod.tech`,
   `app.easymod.tech`, `api.easymod.tech`, `growth.easymod.tech` - valid chain,
   correct SANs. Verify with:
   `curl.exe -sS --resolve easymod.tech:443:<oci-ip> https://easymod.tech/ -o NUL -w "%{http_code}"`
   and repeat per host (www must answer 301 to the apex).
3. **Caddy is serving all five host blocks** in `Caddyfile` at the deployed SHA:
   - `www.easymod.tech` (301 redirect to apex, line ~23)
   - `api.easymod.tech` (backend, health/uploads/webhooks, line ~28)
   - `app.easymod.tech` (frontend, line ~87)
   - `easymod.tech` (marketing + legacy compatibility, line ~122)
   - `growth.easymod.tech` (Growth OS, line ~204)

   Gate 4 calls out "four hosts" (apex, app, api, growth); `www` is the fifth
   A record and must still redirect correctly.
4. **Data and queues are ready** on OCI: migrations at the deployed SHA,
   `/health/ready` shows database and redis connected, Redis still
   `noeviction` + AOF, BullMQ draining, Qdrant grounded.
5. **Single event consumer**: the DigitalOcean backend and worker are stopped
   before the DNS swap, so only the OCI stack consumes Meta webhooks. Confirm
   no second consumer is running.
6. **Snapshot is current**: re-read the zone (read-only) immediately before the
   cutover and diff against
   `docs/launch/cloudflare-zone-snapshot-2026-11-11.json`. Any difference must
   be explained before proceeding. The snapshot must still show 13 records,
   5 A values `139.59.249.141`, all `proxied=false`, `ttl=1`.

## 4. Dry run (mandatory, no mutations)

```powershell
cd D:\easymod\_wt-dns-cutover-prep-20261111
.\scripts\cloudflare\dns-cutover.ps1 -NewIP <oci-public-ipv4> -DryRun
```

Expected: `Mode: DRY RUN`, all 13 records read, BEFORE table with the five A
rows, five `UPDATE` plan lines, and `EXITCODE 0`. `-DryRun` exits before the
mutation loop; it issues no PUT/PATCH/POST/DELETE.

If the script warns that `EASYMOD_CLOUDFLARE_ID` does not resolve to
`easymod.tech`, it falls back to the canonical zone id. That warning means the
user env var is stale and should be corrected outside the cutover window; the
script still verifies the resolved zone name before touching anything.

Preflight abort conditions: non-IPv4 `-NewIP`, missing token, zone name not
`easymod.tech`, zone not active, missing/duplicate target A record, an extra A
record, `proxied=true`, or `ttl != 1`. All abort before any mutation.

## 5. Live cutover procedure

Run in this order:

1. Re-run the dry run from section 4 and keep its output.
2. Stop the DigitalOcean backend and worker containers (single-consumer rule).
   Leave the rest of the DO stack and the droplet intact as the rollback path.
3. Execute:

   ```powershell
   .\scripts\cloudflare\dns-cutover.ps1 -NewIP <oci-public-ipv4>
   ```

4. The script prints the BEFORE table, applies five PUTs sequentially, prints
   the AFTER table re-read from the API, asserts every non-A record is
   unchanged, and queries DNS-over-HTTPS for all five names.
5. Record the exact output and the UTC time of the first PUT.

If the script aborts mid-run, it prints the failing operation and a remediation
line. Re-running is safe and idempotent: records already at the new IP are
reported `NO-OP`. Do not start manual dashboard edits as a workaround.

Caddy on the new host will obtain/renew certificates once traffic arrives
(HTTP-01 or TLS-ALPN). All records are grey-cloud, so public reachability of
ports 80/443 on the OCI instance is required.

## 6. Post-cutover checks

Run immediately after the script exits 0, then again after the propagation
window:

1. **Authoritative data**: the script's AFTER table shows all five A records at
   the new IP, `proxied=false`, `ttl=1`.
2. **Non-A diff**: script prints `INVARIANT PASS: every non-A record is
   unchanged.` If not, stop and diff the full zone against the snapshot.
3. **DNS-over-HTTPS** (`https://dns.google/resolve?name=<host>&type=A`) for all
   five names. Stale answers are expected inside the TTL window; see section 8.
4. **Canonical routing over public DNS**:
   - `https://easymod.tech/` -> marketing, 200
   - `https://www.easymod.tech/` -> 301 to apex
   - `https://app.easymod.tech/signin` -> merchant UI
   - `https://api.easymod.tech/health/ready` -> 200 with database/redis connected
   - `https://api.easymod.tech/version` -> `gitSha` equals the deployed SHA
   - `https://growth.easymod.tech/` -> Growth OS
5. **TLS**: each host serves a valid certificate issued to that name; no
   Cloudflare edge certificate is expected because the records are grey-cloud.
6. **Application flows**: signin/signup, one order read, one AI reply cycle, one
   courier quote contract call, Growth OS login.
7. **Meta webhook**: a test event is acknowledged with the expected status and
   only the OCI backend consumes it. `api.easymod.tech/webhooks/meta` reachable.
8. **Email**: send one Resend-backed password reset and confirm delivery
   (proves the untouched MX/SPF/DKIM/Resend rows still work).
9. **Queues/logs**: BullMQ shows no dropped jobs, no duplicate side effects;
   container health and error rates on OCI are clean.

Keep the DO droplet stopped but intact until the next gate. Do not delete it.

## 7. Rollback

Trigger rollback if Gate 4 post-checks fail and cannot be fixed quickly, or if
TLS/application traffic on OCI is broken after propagation.

1. Stop the OCI backend and worker (single-consumer rule).
2. Start the DigitalOcean stack (`docker compose` at `/opt/easymod/`) and verify
   it on the old IP before changing DNS:
   `curl.exe -sS --resolve api.easymod.tech:443:139.59.249.141 https://api.easymod.tech/health/ready`
3. Dry run the rollback and keep the output:

   ```powershell
   .\scripts\cloudflare\dns-rollback.ps1 -DryRun
   ```

4. Execute:

   ```powershell
   .\scripts\cloudflare\dns-rollback.ps1
   ```

5. The script hard-targets all five A records back to `139.59.249.141`,
   preserves `proxied=false`, `ttl=1` and record metadata, prints before/after
   tables, asserts non-A records are unchanged, and checks DoH.
6. Re-run the post-cutover checks against the DO stack. Certificates may need a
   moment if Caddy restarted; TTL Auto means clients converge within ~300 s.

Rollback does not touch MX/TXT/DKIM/DMARC/Resend rows. If those differ from the
snapshot, treat it as a separate incident.

## 8. Propagation expectations

- TTL is `1` (Auto); Cloudflare serves Auto TTL as **~300 seconds**.
- Cloudflare's authoritative answers change as soon as the PUT succeeds.
- Recursive resolvers and browsers may keep the old address until the previous
  TTL expires - up to about 5 minutes, occasionally longer with a resolver that
  ignores TTL. Negative answers (NXDOMAIN) can be cached for the zone's SOA
  minimum.
- `dns.google` may show `Status=3` (NXDOMAIN) or the old IP briefly. This is
  **not** a failure and must not trigger rollback inside the first 5-10 minutes.
- Do not "fix" propagation by editing records manually, lowering TTLs, or
  enabling the Cloudflare proxy. Re-check with DoH and direct `curl` instead.
- Verify user-facing behavior after at least one Auto-TTL window (~5 minutes),
  and once more after 15 minutes.

## 9. Evidence to retain

- Dry-run output and live-run output (token never appears in either).
- Snapshot file used for the diff and the UTC timestamp of the first PUT.
- DoH output for all five names, at T+0 and T+10 minutes.
- `https://api.easymod.tech/version` response showing the deployed SHA.
- Post-check results for TLS, routing, webhook, email and queues.
- Rollback output if rollback was invoked.

## 10. Abort criteria summary

Abort before mutation on: invalid IPv4, missing credentials, wrong/inactive
zone, missing or duplicate target A record, an A record outside the five
targets, `proxied=true`, `ttl != 1`.

Abort/rollback after mutation on: non-A records changed, any target not at the
new IP with correct flags, TLS failure on the new host after propagation,
`/version` mismatch, or two live webhook consumers.