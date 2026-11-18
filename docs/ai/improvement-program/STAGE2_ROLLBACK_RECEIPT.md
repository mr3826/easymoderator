# Stage 2 Rollback Receipt

**Partial.** `node EasyMod-backend/scripts/validate-rollback-contract.js` passes on main and on `fix/stage2-rollback-activation`; the workflow guard passed 58 assertions. The old `MODULE_NOT_FOUND` used the wrong path. The main validator did not establish safe activation order.

The prerequisite stages uploads outside live paths, captures verified configuration and actual running image digests, arms rollback before recording a marker under lock, and checks routed health before clearing the marker. The adapted fixture harness includes a worker and verifies fixed-name checksums. `bash scripts/rollback-rehearsal.sh --exit-handler-only` passed in a network-disabled Linux container with a read-only checkout and no Docker socket. Its synthetic interruption cases cover failure before activation, successful recovery retaining the original failure, and failed recovery returning 70 and retaining the marker. It does not restore application images.

The final prerequisite [PR 272](https://github.com/mr3826/easymoderator/pull/272), head `3800f195178e42862416fc930d7da8efa9de87b4`, passed 59 local workflow guards and the network-disabled interruption harness. Its CI cutover drill is not an exact-image rehearsal. The registry denied anonymous lookup of the observed incumbent with HTTP 401. The Stage 2 PR did not publish images.

An exact-image rehearsal has not been run. The required receipt is still missing candidate/previous digests, forward and rollback checks on synthetic persisted data, fault cases, and API/worker mixed-version results. Run only on an isolated Linux runner or VM, never against the production database or a shared Docker host. The release must not depend on a schema down-migration.
