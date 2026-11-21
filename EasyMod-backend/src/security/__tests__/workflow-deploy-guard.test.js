'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const workflowPath = path.resolve(
    __dirname,
    '../../../../.github/workflows/ci-cd.yml',
);
const workflow = fs.readFileSync(workflowPath, 'utf8');
const workflowDirectory = path.resolve(__dirname, '../../../../.github/workflows');
const releaseWorkflowPath = path.resolve(
    __dirname,
    '../../../../.github/workflows/release.yml',
);
const releaseWorkflow = fs.readFileSync(releaseWorkflowPath, 'utf8');
const backupWorkflow = fs.readFileSync(
    path.resolve(__dirname, '../../../../.github/workflows/backup.yml'),
    'utf8',
);
const composePath = path.resolve(__dirname, '../../../../docker-compose.prod.yml');
const compose = fs.readFileSync(composePath, 'utf8');
const growthNginxPath = path.resolve(__dirname, '../../../../EasyMod-growth/nginx.conf');
const growthNginx = fs.readFileSync(growthNginxPath, 'utf8');
const backendDockerfilePath = path.resolve(__dirname, '../../../Dockerfile');
const backendDockerfile = fs.readFileSync(backendDockerfilePath, 'utf8');
const backendDockerignorePath = path.resolve(__dirname, '../../../.dockerignore');
const backendDockerignore = fs.readFileSync(backendDockerignorePath, 'utf8');
const frontendDockerfilePath = path.resolve(__dirname, '../../../../EasyMod-frontend/Dockerfile');
const frontendDockerfile = fs.readFileSync(frontendDockerfilePath, 'utf8');
const workerPath = path.resolve(__dirname, '../../jobs/worker.js');
const workerSource = fs.readFileSync(workerPath, 'utf8');
const databaseSyncPath = path.resolve(__dirname, '../../utils/database/sync.js');
const databaseSyncSource = fs.readFileSync(databaseSyncPath, 'utf8');
const securityWorkflowPath = path.resolve(
    __dirname,
    '../../../../.github/workflows/security-scan.yml',
);
const securityWorkflow = fs.readFileSync(securityWorkflowPath, 'utf8');
const growthWorkflowPath = path.resolve(
    __dirname,
    '../../../../.github/workflows/growth-os.yml',
);
const growthWorkflow = fs.readFileSync(growthWorkflowPath, 'utf8');
const grantGrowthRoleWorkflowPath = path.resolve(
    __dirname,
    '../../../../.github/workflows/grant-growth-role.yml',
);
const grantGrowthRoleWorkflow = fs.readFileSync(grantGrowthRoleWorkflowPath, 'utf8');
const seedInitialGrowthAdminWorkflowPath = path.resolve(
    __dirname,
    '../../../../.github/workflows/seed-initial-growth-admin.yml',
);
const seedInitialGrowthAdminWorkflow = fs.readFileSync(seedInitialGrowthAdminWorkflowPath, 'utf8');
const growthImporterWorkflowPath = path.resolve(
    __dirname,
    '../../../../.github/workflows/run-growth-importer.yml',
);
const growthImporterWorkflow = fs.readFileSync(growthImporterWorkflowPath, 'utf8');

describe('production workflow branch safety', () => {
    test('keeps the production backend non-root with targeted writable ownership', () => {
        expect(backendDockerfile).toContain('USER node');
        expect(backendDockerfile).toContain('chown node:node /app/uploads');
        expect(backendDockerfile).not.toContain('chown -R node:node /app');
        expect(backendDockerfile).toContain('apk upgrade --no-cache');
        expect(backendDockerfile).toContain('/usr/local/lib/node_modules/npm');
        expect(frontendDockerfile).toContain('FROM nginx:1.29-alpine AS production');
        expect(frontendDockerfile).toContain('apk upgrade --no-cache');
        expect(frontendDockerfile).toContain('ARG VITE_META_APP_ID');
        expect(frontendDockerfile).toContain('VITE_META_APP_ID=$VITE_META_APP_ID');
        expect(backendDockerignore).toContain('coverage');
        expect(backendDockerignore).toContain('.test-uploads');
    });

    test('keeps post-merge release entry separate from pull-request validation', () => {
        expect(workflow).toContain('workflow_call:');
        expect(workflow).not.toMatch(/^ {2}push:/m);
        expect(releaseWorkflow).toContain('branches: [main]');
        expect(releaseWorkflow).not.toMatch(/^ {2}pull_request:/m);
        expect(releaseWorkflow).toContain('uses: ./.github/workflows/ci-cd.yml');
        expect(releaseWorkflow).toContain('secrets: inherit');
    });

    test('paired promotion validates both immutable images and the rollback floor', () => {
        expect(releaseWorkflow).toContain('existing_frontend_digest: ${{ inputs.existing_frontend_digest }}');
        expect(workflow).toContain('frontend_digest: ${{ steps.frontend_image.outputs.digest || inputs.existing_frontend_digest }}');
        expect(workflow).toContain('test "$RELEASE_TARGET" = all');
        expect(workflow).toContain('test "$EXISTING_CANDIDATE_SHA" = "$SHA"');
        expect(workflow).toContain('for digest in "$EXISTING_BACKEND_DIGEST" "$EXISTING_FRONTEND_DIGEST" "$EXPECTED_ROLLBACK_BACKEND_DIGEST" "$EXPECTED_ROLLBACK_FRONTEND_DIGEST"');
        expect(workflow).toContain('test -z "$WIPE_REQUEST$SEED_REQUEST"');
        expect(workflow).toContain('docker pull --quiet --platform linux/arm64 "$platform_ref" >/dev/null');
        expect(workflow).toContain('test "$revision" = "$SHA"');
        expect(workflow).toContain("needs.changes.outputs.frontend == 'true' && env.EXISTING_FRONTEND_DIGEST == ''");
        expect(workflow.match(/labels: org\.opencontainers\.image\.revision=/g)).toHaveLength(2);
        const floor = workflow.indexOf('[ "$previous_backend_image" != "$GHCR_BACKEND@$EXPECTED_ROLLBACK_BACKEND_DIGEST" ]');
        const activation = workflow.indexOf('activation_started=true');
        expect(floor).toBeGreaterThan(-1);
        expect(activation).toBeGreaterThan(floor);
        const frontendFloor = workflow.indexOf('[ "$previous_frontend_image" != "$GHCR_FRONTEND@$EXPECTED_ROLLBACK_FRONTEND_DIGEST" ]');
        expect(frontendFloor).toBeGreaterThan(-1);
        expect(activation).toBeGreaterThan(frontendFloor);
        expect(workflow).toContain('chmod 600 "$ROLLBACK_STATE_DIR/.env.prod"');
    });

    test('every supplied backend digest is source-verified before migration', () => {
        expect(workflow).toContain('if [ -n "$EXISTING_BACKEND_DIGEST$EXISTING_FRONTEND_DIGEST$EXPECTED_ROLLBACK_BACKEND_DIGEST$EXPECTED_ROLLBACK_FRONTEND_DIGEST" ]; then');
        expect(workflow).toContain('[ -z "$digest" ] && continue');

        const backendRevisionCheck = workflow.indexOf('candidate_revision=$(arm64_image_revision');
        const productionMigration = workflow.indexOf('Running database migrations before service replacement');
        expect(backendRevisionCheck).toBeGreaterThan(-1);
        expect(productionMigration).toBeGreaterThan(backendRevisionCheck);
        expect(workflow).toContain('test "$candidate_revision" = "$SHA"');
    });

    test('reader-only exact promotion retains the incumbent frontend digest', () => {
        expect(workflow).toContain('if [ "$RELEASE_TARGET" = backend ]; then');
        expect(workflow).toContain('test "$EXISTING_FRONTEND_DIGEST" = "$EXPECTED_ROLLBACK_FRONTEND_DIGEST"');
        expect(workflow).toContain('candidate_revision=$(arm64_image_revision "$GHCR_BACKEND@$EXISTING_BACKEND_DIGEST")');
        expect(workflow).toContain('pull_arm64_image "$GHCR_FRONTEND@$EXISTING_FRONTEND_DIGEST" >/dev/null');
        expect(releaseWorkflow).toContain('Exact frontend digest: retained rollback frontend for target=backend');
        expect(releaseWorkflow).toContain('expected_rollback_backend_digest: ${{ inputs.expected_rollback_backend_digest }}');
        expect(releaseWorkflow).toContain('expected_rollback_frontend_digest: ${{ inputs.expected_rollback_frontend_digest }}');
    });

    test('meta revision guards resolve the single arm64 platform image before inspecting labels', () => {
        // Regression guard for reader-rollout dispatches 44871253024 and
        // 44872606364, which died silently at 'Set image tags': docker image
        // inspect on a multi-arch manifest-list digest returns the index object
        // (no .Config), so the revision label came back empty and the equality
        // test exited 1 under bash -e. The fix ports the provenance workflow's
        // resolution: imagetools inspect --raw -> jq-select the single
        // linux/arm64 runtime platform digest -> pull/inspect THAT image.
        const metaStep = workflow.match(
            /- name: Set image tags\n([\s\S]*?)\n      - name: Build & push backend image/,
        )?.[1];
        expect(metaStep).toBeDefined();

        // Both helpers exist, are defined before first use, and the revision
        // helper inspects only the platform ref the pull helper resolved.
        const pullHelper = metaStep.indexOf('pull_arm64_image() {');
        const revisionHelper = metaStep.indexOf('arm64_image_revision() {');
        expect(pullHelper).toBeGreaterThan(-1);
        expect(revisionHelper).toBeGreaterThan(pullHelper);
        expect(metaStep.indexOf('$(arm64_image_revision')).toBeGreaterThan(revisionHelper);
        expect(metaStep).toContain('platform_ref=$(pull_arm64_image "$1") || return 1');

        // Platform resolution mirrors stage2-image-provenance.yml: raw index
        // read, single-runtime-platform selection (attestation descriptors are
        // excluded by the os/arch match), digest-format validation, then the
        // pull of the resolved platform ref — never of the raw index digest.
        expect(metaStep).toContain('manifest=$(docker buildx imagetools inspect --raw "$image_ref") || return 1');
        expect(metaStep).toContain('if jq -e \'has("manifests")\' <<< "$manifest" >/dev/null; then');
        expect(metaStep).toContain('platform_digest=$(jq -er --arg os linux --arg arch arm64 \'');
        expect(metaStep).toContain('[.manifests[] | select(.platform.os == $os and .platform.architecture == $arch)]');
        expect(metaStep).toContain('| if length == 1 then .[0].digest else error("Expected a single linux/arm64 runtime platform") end');
        expect(metaStep).toContain('[[ "$platform_digest" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1');
        expect(metaStep).toContain('platform_digest="${image_ref#*@}"');
        expect(metaStep).toContain('platform_ref="$package@$platform_digest"');

        // Exactly one pull and one revision inspect remain in the meta step's
        // code (comments stripped), and both target the resolved platform ref.
        // A future edit that pulls or inspects an unresolved (possibly
        // multi-arch) digest reference reintroduces the manifest-list failure
        // mode and must fail here.
        const metaCode = metaStep
            .split('\n')
            .filter((line) => !line.trim().startsWith('#'))
            .join('\n');
        const pullSites = metaCode.match(/docker pull[^\n]*/g) || [];
        expect(pullSites).toHaveLength(1);
        expect(pullSites[0]).toBe('docker pull --quiet --platform linux/arm64 "$platform_ref" >/dev/null || return 1');
        const inspectSites = metaCode.match(/docker image inspect[^\n]*/g) || [];
        expect(inspectSites).toHaveLength(1);
        expect(inspectSites[0]).toBe('docker image inspect --format \'{{ index .Config.Labels "org.opencontainers.image.revision" }}\' "$platform_ref"');

        // The supplied-digest format validation still runs before any branch.
        const formatValidation = metaStep.indexOf('[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]');
        expect(formatValidation).toBeGreaterThan(-1);
        expect(formatValidation).toBeLessThan(metaStep.indexOf('candidate_revision=$(arm64_image_revision'));

        // Site 1 (target=backend): candidate SHA and frontend==rollback-floor
        // equality first, then the resolved backend revision assertion, then
        // the retained-frontend platform pull — original order intact.
        const backendBranch = metaStep.slice(
            metaStep.indexOf('if [ "$RELEASE_TARGET" = backend ]; then'),
            metaStep.indexOf('elif [ "$RELEASE_TARGET" = all ]; then'),
        );
        const backendCandidateSha = backendBranch.indexOf('test "$EXISTING_CANDIDATE_SHA" = "$SHA"');
        const frontendEquality = backendBranch.indexOf('test "$EXISTING_FRONTEND_DIGEST" = "$EXPECTED_ROLLBACK_FRONTEND_DIGEST"');
        const backendFetch = backendBranch.indexOf('candidate_revision=$(arm64_image_revision "$GHCR_BACKEND@$EXISTING_BACKEND_DIGEST")');
        const backendAssert = backendBranch.indexOf('test "$candidate_revision" = "$SHA"');
        const frontendPull = backendBranch.indexOf('pull_arm64_image "$GHCR_FRONTEND@$EXISTING_FRONTEND_DIGEST" >/dev/null');
        expect(backendCandidateSha).toBeGreaterThan(-1);
        expect(frontendEquality).toBeGreaterThan(backendCandidateSha);
        expect(backendFetch).toBeGreaterThan(frontendEquality);
        expect(backendAssert).toBeGreaterThan(backendFetch);
        expect(frontendPull).toBeGreaterThan(backendAssert);

        // Site 2 (target=all): both images go through the resolver inside the
        // loop, each revision asserted against SHA before the next image.
        const allBranch = metaStep.slice(
            metaStep.indexOf('elif [ "$RELEASE_TARGET" = all ]; then'),
            metaStep.indexOf("echo 'ERROR: exact paired promotion requires target=backend"),
        );
        const allLoop = allBranch.indexOf('for image in "$GHCR_BACKEND@$EXISTING_BACKEND_DIGEST" "$GHCR_FRONTEND@$EXISTING_FRONTEND_DIGEST"; do');
        const allFetch = allBranch.indexOf('revision=$(arm64_image_revision "$image")');
        const allAssert = allBranch.indexOf('test "$revision" = "$SHA"');
        expect(allLoop).toBeGreaterThan(-1);
        expect(allFetch).toBeGreaterThan(allLoop);
        expect(allAssert).toBeGreaterThan(allFetch);

        // Site 3 (stage2 rollback floor): the resolved rollback revision feeds
        // the unchanged format + ancestor tests and the reader-source check.
        const stage2Block = metaStep.slice(metaStep.indexOf('if [ "$stage2_promotion" = true ]; then'));
        const rollbackFetch = stage2Block.indexOf('rollback_revision=$(arm64_image_revision "$rollback_backend_image")');
        const ancestorTest = stage2Block.indexOf('git merge-base --is-ancestor "$rollback_revision" "$SHA"');
        const readerCheck = stage2Block.indexOf('verify_reader_projection_source "$rollback_revision" \'Stage 2 rollback floor\' reader');
        expect(rollbackFetch).toBeGreaterThan(-1);
        expect(ancestorTest).toBeGreaterThan(rollbackFetch);
        expect(readerCheck).toBeGreaterThan(ancestorTest);
    });

    test('provenance verification binds the pulled image to the resolved platform RepoDigests', () => {
        // Run 44876328333 (backend floor d3694867..., linux/arm64): platform
        // and revision label matched, but the pulled image .Id
        // (sha256:76f11b2d...) != the registry platform manifest's
        // config.digest (sha256:11d2d2ab...) — docker-daemon OCI -> docker
        // media-type normalization re-serializes the config on pull, so
        // .Id == config.digest is not a sound binding for OCI images in the
        // classic docker store. The binding is RepoDigests instead: the
        // pulled image must list the exact resolved package@platform_digest.
        // Platform equality, revision-label equality, the single-runtime-
        // platform selection and the digest format checks all stay strict.
        const provenance = fs.readFileSync(
            path.resolve(__dirname, '../../../../.github/workflows/stage2-image-provenance.yml'),
            'utf8',
        );
        expect(provenance).toContain('identity=$(docker image inspect --format \'{{.Os}}/{{.Architecture}} {{index .Config.Labels "org.opencontainers.image.revision"}}\' "$platform_ref")');
        expect(provenance).toContain('repo_digests=$(docker image inspect --format \'{{json .RepoDigests}}\' "$platform_ref")');
        expect(provenance).toContain('if [[ "$identity" != "$PLATFORM $SOURCE_SHA" ]] \\');
        expect(provenance).toContain('|| ! jq -e --arg ref "$platform_ref" \'type == "array" and any(.[]; . == $ref)\' <<< "$repo_digests" >/dev/null; then');
        // The pull still targets the resolved platform ref, never the raw
        // index digest, and config.digest survives only as an informational
        // field — no .Id/config.digest equality assertion may come back.
        expect(provenance).toContain('docker pull --quiet --platform "$PLATFORM" "$platform_ref" >/dev/null');
        expect(provenance).not.toContain('"$PLATFORM $config_digest $SOURCE_SHA"');
        expect(provenance).not.toContain('{{.Os}}/{{.Architecture}} {{.Id}}');
        expect(provenance).toContain('- RepoDigests binding: %s\\n- Image config (informational): %s\\n\' "$PLATFORM" "$platform_digest" "$platform_ref" "$config_digest"');
    });

    test('provenance identity mismatch prints every component before failing', () => {
        // Runs 44874186785 (backend floor) and 44874189551 (frontend floor)
        // failed with only the generic error, so the mismatched component
        // (platform, RepoDigests binding, revision label) was unattributable
        // without registry read access. The failure branch must stay
        // diagnosable, and the comparison itself must not be weakened.
        const provenance = fs.readFileSync(
            path.resolve(__dirname, '../../../../.github/workflows/stage2-image-provenance.yml'),
            'utf8',
        );
        const mismatchStart = provenance.indexOf('if [[ "$identity" != "$PLATFORM $SOURCE_SHA" ]] \\');
        expect(mismatchStart).toBeGreaterThan(-1);
        const mismatchBranch = provenance.slice(mismatchStart, provenance.indexOf('exit 1', mismatchStart));
        expect(mismatchBranch).toContain('::error::Pulled image platform, OCI revision or registry RepoDigests binding did not match.');
        expect(mismatchBranch).toContain('actual_platform=$(docker image inspect --format \'{{.Os}}/{{.Architecture}}\' "$platform_ref")');
        expect(mismatchBranch).toContain('actual_id=$(docker image inspect --format \'{{.Id}}\' "$platform_ref")');
        expect(mismatchBranch).toContain('actual_revision=$(docker image inspect --format \'{{index .Config.Labels "org.opencontainers.image.revision"}}\' "$platform_ref")');
        expect(mismatchBranch).toContain('actual_labels=$(docker image inspect --format \'{{json .Config.Labels}}\' "$platform_ref")');
        expect(mismatchBranch).toContain('printf -- \'- actual identity:   %s\\n\' "$identity"');
        expect(mismatchBranch).toContain('printf -- \'- expected identity: %s\\n\' "$PLATFORM $SOURCE_SHA"');
        expect(mismatchBranch).toContain('printf -- \'- platform: actual=%s expected=%s\\n\' "$actual_platform" "$PLATFORM"');
        expect(mismatchBranch).toContain('printf -- \'- RepoDigests: actual=%s\\n\' "$repo_digests"');
        expect(mismatchBranch).toContain('printf -- \'- RepoDigests binding: expected exact element %s\\n\' "$platform_ref"');
        expect(mismatchBranch).toContain('printf -- \'- revision label: actual=%s expected=%s\\n\' "${actual_revision:-<empty>}" "$SOURCE_SHA"');
        expect(mismatchBranch).toContain('printf -- \'- image .Id (informational): %s\\n\' "$actual_id"');
        expect(mismatchBranch).toContain('printf -- \'- manifest config.digest (informational): %s\\n\' "$config_digest"');
        expect(mismatchBranch).toContain('printf -- \'- all config labels: %s\\n\' "$actual_labels"');
    });

    test('always-run cleanup removes only the run-scoped staged candidate environment', () => {
        const deployBlock = workflow.match(/\n  deploy:\n([\s\S]*?)\n  # ── 4\./)?.[1];
        expect(deployBlock).toBeDefined();

        const stageIndex = deployBlock.indexOf('name: Stage candidate config on droplet');
        const deployIndex = deployBlock.indexOf('name: Deploy via SSH');
        const cleanupIndex = deployBlock.indexOf('name: Remove staged candidate credentials');
        expect(stageIndex).toBeGreaterThan(-1);
        expect(deployIndex).toBeGreaterThan(stageIndex);
        expect(cleanupIndex).toBeGreaterThan(deployIndex);
        expect(deployBlock.slice(cleanupIndex)).toContain('if: always()');
        expect(deployBlock.slice(cleanupIndex)).toContain('candidate/.env.prod');
        expect(deployBlock.slice(cleanupIndex)).toContain('refusing to clean a candidate environment outside this workflow attempt');
    });

    test('Stage 2 promotion requires an exact pair and a patched reader rollback floor', () => {
        expect(workflow).toContain('reply-confidence.service.js');
        expect(workflow).toContain('reply-confidence-rollup.service.js');
        expect(workflow).toContain('test -f EasyMod-backend/src/modules/ai/reply-confidence.service.js');
        expect(workflow).toContain('test -f EasyMod-backend/src/modules/ai/reply-confidence-rollup.service.js');
        expect(workflow).toContain('[ "$DEPLOY_CONFIRMATION" = "DEPLOY-$SHA" ]');
        expect(workflow).toContain('test "$RELEASE_TARGET" = all');
        // WP-06 amendment: a growth_image_override is permitted on a paired
        // promotion ONLY because every override still traverses the complete
        // downstream chain pinned below — fail-closed digest resolution with
        // assert_immutable_ref, deploy-time commit binding against the release
        // SHA, public growth identity, and growth carry-restore in
        // verify_rollback. WIPE/SEED/DRIFT stay forbidden at this gate.
        expect(workflow).toContain('test -z "$WIPE_REQUEST$SEED_REQUEST$SCHEMA_DRIFT_REQUEST"');
        expect(workflow).not.toContain('$WIPE_REQUEST$SEED_REQUEST$GROWTH_OVERRIDE$SCHEMA_DRIFT_REQUEST');
        expect(workflow).toContain('GROWTH_IMAGE_OVERRIDE: ${{ inputs.growth_image_override }}');
        expect(workflow).toContain('candidate_growth_image="${GHCR_GROWTH}@${GROWTH_IMAGE_OVERRIDE}"');
        expect(workflow).toContain('growth_image_source=override');
        expect(workflow).toContain('assert_immutable_ref "$candidate_growth_image"');
        expect(workflow).toContain('export GHCR_IMAGE_GROWTH="$candidate_growth_image"');
        expect(workflow).toContain('if [ "$growth_build_commit" != "$DEPLOYED_COMMIT" ]; then');
        expect(workflow).toContain(
            "Growth image build-info commit '$growth_build_commit' does not match deployed commit '$DEPLOYED_COMMIT'",
        );
        expect(workflow).toContain('verify_public_stack "$candidate_backend_commit" "$candidate_growth_commit" || exit 1');
        expect(workflow).toContain(
            'Public Growth identity mismatch: expected ${process.env.EXPECTED_GROWTH_COMMIT}, got ${payload.commit || "(missing)"}',
        );
        expect(workflow).toContain('restored_growth=$(resolve_container_digest easymod-growth-frontend-1 || true)');
        expect(workflow).toContain('rollback Growth image reference was not restored');
        expect(workflow).toContain('export GHCR_IMAGE_GROWTH="${previous_growth_image:-$candidate_growth_image}"');
        expect(workflow).toContain('verify_public_stack "$previous_backend_commit" "$previous_growth_commit" || return 1');
        expect(workflow).toContain('git merge-base --is-ancestor "$rollback_revision" "$SHA"');
        expect(workflow).toContain('message-evidence-projection.js');
        expect(workflow).toContain("git grep -Fq -e 'projectMessageEvidence('");
        expect(workflow).toContain("git grep -Fq -e 'projectMessageEvent('");
        expect(workflow).toContain('fetch-depth: 0');

        const readerVerifierStart = workflow.indexOf('verify_reader_projection_source()');
        const readerVerifierEnd = workflow.indexOf("echo \"$label reader source verified: $revision\"", readerVerifierStart);
        const readerVerifier = workflow.slice(readerVerifierStart, readerVerifierEnd);
        expect(readerVerifier).toContain('for (const field of PUBLIC_MESSAGE_FIELDS)');
        expect(readerVerifier).toContain('[ "$reader_kind" = writer ]');
        expect(readerVerifier).toContain("git grep -Fq -e 'projectPublicMessageMetadata('");
        expect(readerVerifier).toContain("git grep -Fq -e 'projectPublicMessageEvent('");
        expect(readerVerifier).toContain('is not a reader-only recovery revision');
        expect(workflow).toContain('verify_reader_projection_source "$SHA" \'Stage 2 candidate\' writer');
        expect(workflow).toContain('verify_reader_projection_source "$rollback_revision" \'Stage 2 rollback floor\' reader');
    });

    test('forward cutover verifies backend, worker, routed health, and synthetic queue consumption', () => {
        const exactImages = workflow.indexOf('candidate_worker_running=$(resolve_container_digest easymod-worker-1)');
        const workerHealth = workflow.indexOf('candidate_worker_healthy=false');
        const caddyStart = workflow.indexOf('Starting Caddy after candidate backend and worker health passed');
        const routedHealth = workflow.indexOf('frontend_route_status=$(curl');
        const versionCheck = workflow.indexOf('Version check passed: ${payload.gitSha}');
        const workerCanary = workflow.indexOf("messageQueue.add('canary'");

        expect(exactImages).toBeGreaterThan(-1);
        expect(workerHealth).toBeGreaterThan(exactImages);
        expect(caddyStart).toBeGreaterThan(workerHealth);
        expect(routedHealth).toBeGreaterThan(caddyStart);
        expect(workflow).toContain("api_route_status=$(curl --silent --max-time 5 --noproxy '*'");
        expect(workflow).toContain('Candidate backend, worker, and routed health checks passed');
        expect(workerCanary).toBeGreaterThan(versionCheck);
        expect(workflow).toContain('Candidate worker synthetic queue canary passed');
        expect(workflow).toContain('WORKFLOW_RUN_ATTEMPT,DEPLOYED_AT');
    });

    test('build and deploy jobs are restricted to main', () => {
        const buildBlock = workflow.match(/\n  build:\n([\s\S]*?)\n  # ── 4\./)?.[1];
        const deployBlock = workflow.match(/\n  deploy:\n([\s\S]*)$/)?.[1];

        expect(buildBlock).toContain("github.ref == 'refs/heads/main'");
        expect(deployBlock).toContain("github.event_name == 'workflow_dispatch' || github.event_name == 'workflow_call'");
        expect(deployBlock).toContain("github.ref == 'refs/heads/main'");
    });

    test('routes privileged Growth workflows through the semantic backend and Growth gates', () => {
        expect(workflow).toContain('.github/workflows/grant-growth-role.yml');
        expect(workflow).toContain('.github/workflows/seed-initial-growth-admin.yml');
        const growthCase = workflow.slice(workflow.indexOf('EasyMod-growth/*'), workflow.indexOf('EasyMod-growth/*') + 600);
        expect(growthCase).toContain('.github/workflows/seed-initial-growth-admin.yml');
    });

    test('deploy passes the Action Gate secret to production rendering', () => {
        const deployBlock = workflow.match(/\n  deploy:\n([\s\S]*)$/)?.[1];

        expect(deployBlock).toContain('AI_ACTION_GATE_SECRET: ${{ secrets.AI_ACTION_GATE_SECRET }}');
    });

    test('renders the mobile API switch from the operator variable, off by default, at both production render sites', () => {
        const deployBlock = workflow.match(/\n  deploy:\n([\s\S]*)$/)?.[1];
        const dryRunBlock = workflow.match(/\n  deployment-config:\n([\s\S]*?)\n  docker-build-validation:/)?.[1];
        const line = "MOBILE_API_ENABLED: ${{ vars.MOBILE_API_ENABLED || 'false' }}";

        expect(deployBlock).toContain(line);
        expect(dryRunBlock).toContain(line);
        // It is a public switch, never a secret, and nothing else in the
        // workflow may set or override it.
        expect(workflow.match(/MOBILE_API_ENABLED:/g)).toHaveLength(2);
        expect(workflow).not.toMatch(/secrets\.MOBILE_/);
        expect(workflow).not.toMatch(/MOBILE_(PUSH|ORDER_MUTATIONS|COURIER_ACTIONS|AI_DRAFTS)_ENABLED|MOBILE_E2E_FIXTURES/);
    });

    test('keeps Meta discovery canary disabled unless the protected activation variable is explicit', () => {
        const deployBlock = workflow.match(/\n  deploy:\n([\s\S]*)$/)?.[1];
        const dryRunBlock = workflow.match(/\n  deployment-config:\n([\s\S]*?)\n  docker-build-validation:/)?.[1];
        const enabledLine = "META_DISCOVERY_CANARY_ENABLED: ${{ vars.META_DISCOVERY_CANARY_CONFIRMATION == 'ENABLE-META-DISCOVERY-CANARY' && vars.META_DISCOVERY_CANARY_ENABLED == 'true' && 'true' || 'false' }}";

        expect(workflow).not.toContain('meta_discovery_canary_confirmation:');
        expect(releaseWorkflow).not.toContain('meta_discovery_canary_confirmation:');
        expect(deployBlock).toContain(enabledLine);
        expect(dryRunBlock).toContain(enabledLine);
        expect(workflow.match(/META_DISCOVERY_CANARY_ENABLED:/g)).toHaveLength(2);
        expect(workflow).not.toContain('META_DISCOVERY_CANARY_ENABLED: ${{ vars.META_DISCOVERY_CANARY_ENABLED }}');
    });

    test('validates selected Growth metadata without requiring Node.js on the SSH host', () => {
        const deployBlock = workflow.match(/\n  deploy:\n([\s\S]*)$/)?.[1];
        const growthStart = deployBlock.indexOf('growth_image_source=running');
        const growthValidationStart = deployBlock.indexOf('if [ "$growth_image_source" != "running" ]; then', growthStart);
        const backendValidationStart = deployBlock.indexOf('# Validate the rendered environment with the candidate backend image', growthValidationStart);
        const growthBlock = deployBlock.slice(growthValidationStart, backendValidationStart);

        expect(growthStart).toBeGreaterThan(-1);
        expect(growthValidationStart).toBeGreaterThan(growthStart);
        expect(backendValidationStart).toBeGreaterThan(growthValidationStart);
        expect(deployBlock.slice(growthStart, growthValidationStart)).toContain('growth_image_source=override');
        expect(deployBlock.slice(growthStart, growthValidationStart)).toContain('growth_image_source=bootstrap');
        expect(growthBlock).toContain('if [ "$growth_image_source" != "running" ]; then');
        expect(growthBlock).toContain('command -v jq');
        expect(growthBlock).toContain('jq --version');
        expect(growthBlock).toContain("jq -er '.commit | select(type == \"string\" and length > 0)'");
        expect(growthBlock).toContain('Growth image build-info.json is missing or empty');
        expect(growthBlock).toContain('Growth image build-info.json is malformed or has no non-empty commit');
        expect(growthBlock).not.toContain('node -e');
        expect(growthBlock).not.toContain('| node');

        // Simulate the SSH host's available command set for this parser. The
        // Linux CI runner supplies jq, while the restricted PATH deliberately
        // omits Node.js; container-side Node commands are outside this block.
        if (process.platform === 'win32') return;
        const jqLookup = spawnSync('/bin/sh', ['-c', 'command -v jq'], { encoding: 'utf8' });
        const jqPath = jqLookup.stdout.trim();
        expect(jqLookup.status).toBe(0);
        expect(jqPath).not.toBe('');

        const parserBin = fs.mkdtempSync(path.join(os.tmpdir(), 'easymod-jq-'));
        try {
            fs.symlinkSync(jqPath, path.join(parserBin, 'jq'));
            const probe = spawnSync('/bin/sh', ['-c', [
                'set -eu',
                'if command -v node >/dev/null 2>&1; then exit 10; fi',
                'command -v jq >/dev/null 2>&1',
                'jq --version >/dev/null 2>&1',
                'growth_build_info=\'{"commit":"expected"}\'',
                'growth_build_commit=$(printf \'%s\' "$growth_build_info" | jq -er \'.commit | select(type == "string" and length > 0)\')',
                '[ "$growth_build_commit" = expected ]',
            ].join('\n')], {
                encoding: 'utf8',
                env: { ...process.env, PATH: parserBin },
            });
            expect(probe.status).toBe(0);
        } finally {
            fs.rmSync(parserBin, { recursive: true, force: true });
        }
    });

    test('pull requests can run tests but cannot build deployable images', () => {
        const buildBlock = workflow.match(/\n  build:\n([\s\S]*?)\n  # ── 4\./)?.[1];
        expect(buildBlock).toContain("github.event_name != 'pull_request'");
    });

    test('cancels only stale PR validation and scopes package write access to publishing', () => {
        const buildBlock = workflow.match(/\n  build:\n([\s\S]*?)\n  # ── 4\./)?.[1];
        const topLevelPermissions = workflow.match(/\npermissions:\n([\s\S]*?)\n\nenv:/)?.[1];

        expect(workflow).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
        expect(topLevelPermissions).not.toContain('packages:');
        expect(workflow).toContain('permissions:\n      contents: read\n      packages: read');
        expect(topLevelPermissions).not.toContain('packages: write');
        expect(buildBlock).toContain('permissions:\n      contents: read\n      packages: write');
    });

    test('cancels stale security scans only for PRs', () => {
        expect(securityWorkflow).toContain(
            'group: security-scan-${{ github.event.pull_request.number || github.ref }}',
        );
        expect(securityWorkflow).toContain(
            "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
        );
    });

    test('Growth OS reusable workflow keeps publish permissions inside the caller ceiling', () => {
        // This test file is deliberately under `EasyMod-backend/`: the `changes`
        // path filter treats it as a backend change, so a push here guarantees
        // the real GitHub planner + Jest both re-execute. The `startup_failure`
        // regression I shipped at 911e351 and the ceiling fix at 57cbdd9 both
        // passed locally but differed on real run `35560390196` — that class of
        // silent divergence is exactly what this test is here to prevent from
        // repeating against a future reviewer who only trusts actionlint.
        // Final receipt: Actions run `35561961284` at SHA `3e5077d` — 16/16
        // checks pass or correctly skip; this Jest assertion is included in the
        // `Quality fast` job's execution.
        //
        // Regression guard for the reusable-workflow permission-mismatch I
        // actually shipped at a56045e: `growth-os.yml` requests packages.write
        // at its top level (for its `build-and-push` job), so the caller in
        // ci-cd.yml MUST grant that scope. GitHub validates reusable
        // permissions at PLAN time — the `if:` and event filter are irrelevant
        // to the ceiling check. Before my fix the whole CI/CD workflow failed
        // startup and every PR lost its aggregate context.
        //
        // The check intentionally uses a simple substring assertion for the
        // ci-cd.yml caller block: if we can find the caller's permissions
        // granting packages.write (paired with contents.read) after the
        // `uses: ./.github/workflows/growth-os.yml` line, we're consistent.
        const usesLine = workflow.indexOf('uses: ./.github/workflows/growth-os.yml');
        expect(usesLine).toBeGreaterThan(-1);
        const afterUses = workflow.slice(usesLine, usesLine + 500);
        expect(afterUses).toContain('permissions:');
        expect(afterUses).toContain('contents: read');
        expect(afterUses).toContain('packages: write');

        // The reusable workflow keeps its publish capability — that's exactly
        // the top-level permission we mirror from the caller.
        const growthPermissions = growthWorkflow.match(/\npermissions:\n  contents: read\n  packages: write/);
        expect(growthPermissions).not.toBeNull();

        // The `build-and-push` job (the ONLY job that pushes) must be restricted
        // to the default branch even for manual dispatches. Otherwise a maintainer
        // could publish an arbitrary branch's image with package-write authority.
        expect(growthWorkflow).toContain(
            "if: github.ref == 'refs/heads/main' && (github.event_name == 'workflow_dispatch' || github.event_name == 'push')",
        );

        // Two PR-reachable jobs must narrow their scope below the ceiling so a
        // leaked token from a PR-controlled process cannot write to packages.
        const verifyBlock = growthWorkflow.match(/\n  verify:\n([\s\S]*?)\n  browser-e2e:/)?.[1];
        expect(verifyBlock).toContain('permissions:\n      contents: read');
        expect(verifyBlock).not.toContain('packages: write');
        const browserBlock = growthWorkflow.match(/\n  browser-e2e:\n([\s\S]*?)\n  build-and-push:/)?.[1];
        expect(browserBlock).toContain('permissions:\n      contents: read');
        expect(browserBlock).not.toContain('packages: write');
    });

    test('keeps Growth role bootstrap on the configured production environment', () => {
        expect(grantGrowthRoleWorkflow).toContain(
            "if: github.ref == 'refs/heads/main' && github.actor == 'mr3826'",
        );
        expect(grantGrowthRoleWorkflow).toContain('environment: production');
        expect(grantGrowthRoleWorkflow).not.toContain('environment: growth-bootstrap');
    });

    test('caps privileged remote commands with explicit command timeouts, not transport defaults', () => {
        // appleboy `timeout:` is connection-only; the remote command must have
        // its own cap so a committed privileged mutation is never reaped by a
        // hidden default (grant hang) and a long deploy is never cut off.
        expect(grantGrowthRoleWorkflow).toContain('command_timeout: 15m');
        expect(workflow).toContain('command_timeout: 30m');
    });

    test('runs the bootstrap script in the running backend without Compose interpolation', () => {
        expect(grantGrowthRoleWorkflow).toContain("--filter 'label=com.docker.compose.service=backend'");
        expect(grantGrowthRoleWorkflow).toContain('docker exec \\');
        expect(grantGrowthRoleWorkflow).toContain('node src/scripts/grant-growth-role.js');
        expect(grantGrowthRoleWorkflow).not.toContain('docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T');
    });

    test('protects the one-time initial-admin seed behind main, production, concurrency, and a masked secret', () => {
        expect(seedInitialGrowthAdminWorkflow).toContain(
            "if: github.ref == 'refs/heads/main' && github.actor == 'mr3826'",
        );
        expect(seedInitialGrowthAdminWorkflow).toContain('environment: production');
        expect(seedInitialGrowthAdminWorkflow).toContain('group: seed-initial-growth-admin');
        expect(seedInitialGrowthAdminWorkflow).toContain('INITIAL_GROWTH_ADMIN_PASSWORD: ${{ secrets.INITIAL_GROWTH_ADMIN_PASSWORD }}');
        expect(seedInitialGrowthAdminWorkflow).toContain('node src/scripts/seed-initial-growth-admin.js');
        expect(seedInitialGrowthAdminWorkflow).toContain('docker exec -i \\');
        expect(seedInitialGrowthAdminWorkflow).toContain("| ssh -i \"$key_file\"");
        expect(seedInitialGrowthAdminWorkflow).not.toContain('envs: TARGET_EMAIL,INITIAL_GROWTH_ADMIN_PASSWORD,GITHUB_ACTOR');
        expect(seedInitialGrowthAdminWorkflow).not.toContain('-e INITIAL_GROWTH_ADMIN_PASSWORD=');
        expect(seedInitialGrowthAdminWorkflow).not.toMatch(/INITIAL_GROWTH_ADMIN_PASSWORD\s*:\s*['"]/);
        expect(seedInitialGrowthAdminWorkflow).not.toContain('echo "${INITIAL_GROWTH_ADMIN_PASSWORD}"');
    });

    test('keeps the canonical grant workflow dependent on the seeded identity and protected actor', () => {
        expect(grantGrowthRoleWorkflow).toContain('GROWTH_BOOTSTRAP_ACTOR_EMAIL');
        expect(grantGrowthRoleWorkflow).toContain('environment: production');
        expect(grantGrowthRoleWorkflow).toContain('node src/scripts/grant-growth-role.js');
        expect(grantGrowthRoleWorkflow).not.toContain('INITIAL_GROWTH_ADMIN_PASSWORD');
    });

    test('runs the platform-admin grant on the running backend without Compose interpolation', () => {
        const platformAdminWorkflow = fs.readFileSync(
            path.resolve(__dirname, '../../../../.github/workflows/grant-platform-admin.yml'),
            'utf8',
        );
        expect(platformAdminWorkflow).toContain(
            "if: github.ref == 'refs/heads/main' && github.actor == 'mr3826'",
        );
        expect(platformAdminWorkflow).toContain('environment: production');
        expect(platformAdminWorkflow).toContain('group: grant-platform-admin');
        expect(platformAdminWorkflow).toContain('command_timeout: 15m');
        expect(platformAdminWorkflow).toContain('envs: TARGET_EMAIL,TARGET_ROLE,GITHUB_ACTOR');
        expect(platformAdminWorkflow).toContain("--filter 'label=com.docker.compose.service=backend'");
        expect(platformAdminWorkflow).toContain('docker exec \\');
        expect(platformAdminWorkflow).toContain('node src/scripts/grant-platform-admin.js');
        expect(platformAdminWorkflow).not.toContain('docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T');
        expect(workflow).toContain('.github/workflows/grant-platform-admin.yml');
    });

    test('keeps browser and server Sentry configuration boundaries separate', () => {
        expect(workflow).toContain('VITE_SENTRY_DSN: ${{ vars.VITE_SENTRY_DSN }}');
        expect(workflow.match(/VITE_SENTRY_DSN=\$\{\{ vars\.VITE_SENTRY_DSN \}\}/g)).toHaveLength(2);
        expect(workflow).toContain('SENTRY_DSN: ${{ secrets.SENTRY_DSN }}');
        expect(workflow).not.toContain('SENTRY_DSN: ${{ secrets.SENTRY_DSN || secrets.VITE_SENTRY_DSN }}');
    });

    test('fails closed instead of deleting Redis persistence during deployment recovery', () => {
        expect(workflow).toContain('refusing automatic volume deletion');
        expect(workflow).not.toContain('reset_redis_volume');
        expect(workflow).not.toContain('RVOL=$(docker volume');
    });

    test('manual deployment probes cannot execute branch-controlled code with production secrets', () => {
        const deploymentConfigBlock = workflow.match(/\n  deployment-config:\n([\s\S]*?)\n  # ── 2d\./)?.[1];

        expect(deploymentConfigBlock).toContain(
            "github.event_name != 'workflow_dispatch' || github.ref == 'refs/heads/main'",
        );
        expect(deploymentConfigBlock).toContain(
            "if: github.event_name != 'pull_request' && github.ref == 'refs/heads/main'",
        );
    });

    test('every branch validates both production Docker build contexts without publishing', () => {
        const validationBlock = workflow.match(
            /\n  docker-build-validation:\n([\s\S]*?)\n  # ── 3\./,
        )?.[1];

        expect(validationBlock).toContain('Docker build validation (no push)');
        expect(validationBlock).toContain('context: ./EasyMod-backend');
        expect(validationBlock).toContain('context: ./EasyMod-frontend');
        expect(validationBlock.match(/push: false/g)).toHaveLength(2);
        expect(validationBlock.match(/load: true/g)).toHaveLength(2);
        expect(validationBlock).toContain('push: false');
    });

    test('main production path builds each publishable image once', () => {
        const validationBlock = workflow.match(
            /\n  docker-build-validation:\n([\s\S]*?)\n  # ── 3\./,
        )?.[1];
        const buildBlock = workflow.match(/\n  build:\n([\s\S]*?)\n  # ── 4\./)?.[1];

        expect(validationBlock).toContain("github.event_name == 'pull_request'");
        expect(buildBlock).not.toContain('docker-build-validation');
        expect(buildBlock.match(/uses: docker\/build-push-action@/g)).toHaveLength(2);
    });

    test('production Compose pins every image by digest', () => {
        expect(compose).not.toMatch(/(^|\n)\s*image:\s*[^\n]*:(latest|dev)(\s|$)/m);
        expect(compose).toContain('image: caddy@sha256:');
        expect(compose).toContain('image: postgres@sha256:');
        expect(compose).toContain('image: redis@sha256:');
        expect(compose).toContain('image: qdrant/qdrant@sha256:');
        expect(workflow).toContain('docker image inspect -f');
        expect(workflow).toContain('config --images');
    });

    test('production Compose keeps the canary API-only and workers do not load OAuth canary code', () => {
        const backendBlock = compose.match(/\r?\n  backend:\r?\n([\s\S]*?)\r?\n  # ── Worker:/)?.[1];
        const workerBlock = compose.match(/\r?\n  worker:\r?\n([\s\S]*?)\r?\n  # ── Frontend:/)?.[1];

        expect(backendBlock).toContain('env_file:');
        expect(workerBlock).toContain('command: ["node", "src/jobs/worker.js"]');
        expect(workerSource).not.toContain('meta-discovery-canary');
    });

    // BUILD_TIME lands in the image as ENV and is read back by /health, /version
    // and Sentry's `dist`. It was github.event.repository.updated_at — the repo's
    // last-metadata-change time, which ran behind the commit it labelled and could
    // repeat across two pushes, collapsing two releases onto one dist marker.
    test('stamps BUILD_TIME from the build itself, not repository metadata', () => {
        expect(workflow).not.toContain('repository.updated_at');
        expect(workflow).toContain('BUILD_TIME=${{ steps.meta.outputs.build_time }}');
        expect(workflow).toMatch(/echo "build_time=\$\(date -u \+%Y-%m-%dT%H:%M:%SZ\)" >> \$GITHUB_OUTPUT/);
    });

    test('migrates the candidate backend image before replacing running services', () => {
        const deployBlock = workflow.match(/\n  deploy:\n([\s\S]*)$/)?.[1];
        const candidateMigration =
            'run --rm --no-deps -T \\\n                -e RUN_MIGRATIONS_ON_STARTUP=false backend node src/database/migrate.js up';
        const migrationIndex = deployBlock.indexOf(candidateMigration);
        const schemaAuditIndex = deployBlock.indexOf('node scripts/schema-drift-audit.js');
        const replacementIndex = deployBlock.indexOf(
            'up -d --no-build --remove-orphans',
        );

        expect(migrationIndex).toBeGreaterThan(-1);
        expect(schemaAuditIndex).toBeGreaterThan(migrationIndex);
        expect(replacementIndex).toBeGreaterThan(-1);
        expect(schemaAuditIndex).toBeLessThan(replacementIndex);
    });

    test('stamps MIGRATION_START before the candidate migration runs, and proves exactly one repair ledger row before the schema audit', () => {
        const deployBlock = workflow.match(/\n  deploy:\n([\s\S]*)$/)?.[1];
        const candidateMigration =
            'run --rm --no-deps -T \\\n                -e RUN_MIGRATIONS_ON_STARTUP=false backend node src/database/migrate.js up';

        const migrationStartIndex = deployBlock.indexOf('echo "MIGRATION_START=$migration_started_at"');
        const migrationIndex = deployBlock.indexOf(candidateMigration);
        const ledgerCheckIndex = deployBlock.indexOf('REPAIR_LEDGER_ENTRY_COUNT=1');
        const schemaAuditIndex = deployBlock.indexOf('node scripts/schema-drift-audit.js');

        expect(migrationStartIndex).toBeGreaterThan(-1);
        expect(migrationIndex).toBeGreaterThan(-1);
        expect(migrationStartIndex).toBeLessThan(migrationIndex);

        expect(deployBlock).toContain(
            "SELECT COUNT(*) FROM public.migrations WHERE name LIKE '\\''20260901_001_reconcile_commercial_entity_drift%'\\''",
        );
        expect(deployBlock).toContain('test "$repair_ledger_rows" = 1');
        expect(ledgerCheckIndex).toBeGreaterThan(migrationIndex);
        expect(ledgerCheckIndex).toBeLessThan(schemaAuditIndex);

        // MIGRATION_START must be stamped even when the migration block is
        // skipped (WIPE path), since Step 17's log bound cannot be conditional.
        expect(deployBlock.match(/echo "MIGRATION_START=\$migration_started_at"/g)).toHaveLength(2);
    });

    test('production image database commands do not depend on removed npm binaries', () => {
        const deployBlock = workflow.match(/\n  deploy:\n([\s\S]*)$/)?.[1];

        expect(deployBlock).toContain('backend node src/database/migrate.js up');
        expect(deployBlock).toContain('backend node scripts/schema-drift-audit.js');
        expect(deployBlock).toContain('backend node src/utils/database/sync.js');
        expect(deployBlock).toContain('backend node src/database/migrate.js seed-as-executed');
        expect(deployBlock).toContain('backend node src/scripts/seed-admin.js');
        expect(deployBlock).toContain('Candidate backend startup preflight failed:');
        expect(deployBlock).toContain('Candidate backend database connection passed');
        expect(deployBlock).toContain('Candidate backend Redis connection passed');
        expect(deployBlock).toContain('preflight_container_name="easymod-backend-preflight-${WORKFLOW_RUN_ID:-unknown}"');
        expect(deployBlock).toContain('timeout --signal=TERM --kill-after=10s 120s');
        expect(deployBlock).toContain('process.exit(exitCode);');
        expect(deployBlock).toContain("closeWithTimeout('database'");
        expect(deployBlock).toContain("closeWithTimeout('Redis'");
        expect(deployBlock).toContain('docker rm -f "$preflight_container_name"');
        expect(deployBlock).not.toMatch(/backend\s+(?:npm|npx)\b/);
        expect(deployBlock).toContain('Rollback Growth health details: {{json .State.Health}}');
        expect(deployBlock).toContain('docker logs --tail 50 easymod-growth-frontend-1');

        // The backup restore drill uses the same lean production image and must
        // keep its isolated forward-migration proof on the direct Node entrypoint.
        expect(backupWorkflow).toContain('&& node src/database/migrate.js up');
        expect(backupWorkflow).not.toContain('&& npm run migrate');
    });

    test('wipe bootstrap applies founder-pilot schema migrations before marking history executed', () => {
        const deployBlock = workflow.match(/\n  deploy:\n([\s\S]*)$/)?.[1];
        const syncIndex = deployBlock.indexOf('backend node src/utils/database/sync.js');
        const seedIndex = deployBlock.indexOf('backend node src/database/migrate.js seed-as-executed');

        expect(syncIndex).toBeGreaterThan(-1);
        expect(seedIndex).toBeGreaterThan(syncIndex);
        expect(databaseSyncSource).toContain('if (sequelize.getDialect() === \'postgres\')');
        expect(databaseSyncSource).toContain('for (const migration of founderPilotSchemaMigrations)');
        for (const migration of [
            '20261101_001_founder_pilot_addons',
            '20261101_002_ai_reply_shadow_ledger',
            '20261101_003_ads_studio_manual_reports',
            '20261101_004_storefront_cod',
        ]) {
            expect(databaseSyncSource).toContain(migration);
        }
    });

    test('starts candidate services before Caddy and diagnoses backend health failures', () => {
        const deployBlock = workflow.match(/\n  deploy:\n([\s\S]*)$/)?.[1];
        const appStartIndex = deployBlock.indexOf('up -d --no-build --remove-orphans backend worker frontend growth-frontend');
        const backendHealthIndex = deployBlock.indexOf('candidate_backend_healthy=false');
        const caddyStartIndex = deployBlock.indexOf('up -d --no-build --remove-orphans caddy');
        const caddyReloadIndex = deployBlock.indexOf('caddy reload --config /etc/caddy/Caddyfile');

        expect(appStartIndex).toBeGreaterThan(-1);
        expect(backendHealthIndex).toBeGreaterThan(appStartIndex);
        expect(caddyStartIndex).toBeGreaterThan(backendHealthIndex);
        expect(caddyReloadIndex).toBeGreaterThan(caddyStartIndex);
        expect(deployBlock).toContain('Candidate backend health details: {{json .State.Health}}');
        expect(deployBlock).toContain('Candidate backend state: status={{.State.Status}} exit={{.State.ExitCode}} restart={{.RestartCount}} oom={{.State.OOMKilled}} error={{.State.Error}}');
        expect(deployBlock).toContain('docker ps -a --filter name=easymod-backend-1 --no-trunc');
        expect(deployBlock).toContain('docker logs --tail 100 easymod-backend-1');
        expect(deployBlock).toContain('docker logs --tail 100 easymod-caddy-1');
    });

    test('the pre-migration schema-drift probe is opt-in per dispatch, not hardcoded', () => {
        expect(workflow).toContain(
            "description: 'One-shot: require the 3 repair columns ABSENT before migrating. Type DRIFT to confirm.'",
        );
        expect(workflow).toMatch(/expect_schema_drift:\n\s+description:/);

        // The literal used to be baked into every dispatch, including ordinary
        // future deploys where the repair columns are already present — that
        // throws PRE_MIGRATION_SCHEMA=FAIL on every deploy after this repair
        // ships. It must only ever be reached through the resolved shell var.
        expect(workflow).not.toMatch(/PROBE_SCHEMA_MODE=pre-migration(?!['"])/);
        expect(workflow.match(/PROBE_SCHEMA_MODE=\$schema_probe_mode/g)).toHaveLength(2);
        expect(workflow.match(/schema_probe_mode='basic'/g)).toHaveLength(2);
        expect(workflow.match(/schema_probe_mode='pre-migration'/g)).toHaveLength(2);
        // Once for each of: the dry-run probe, the candidate probe, and the
        // deploy-via-SSH step that also gates the zero-debt assertion.
        expect(workflow.match(/SCHEMA_DRIFT_MODE: \$\{\{ inputs\.expect_schema_drift == 'DRIFT' \}\}/g)).toHaveLength(3);
    });

    test('the zero-debt initialization assertion is scoped to the one-shot drift repair, not every deploy', () => {
        const deployBlock = workflow.match(/\n  deploy:\n([\s\S]*)$/)?.[1];

        // threshold_debt is a legacy field the migration deliberately preserves
        // on rerun rather than resetting — so it is legitimately allowed to be
        // nonzero outside the one-shot repair transition. Asserting it is zero
        // unconditionally would hard-fail every future deploy the day any row
        // carries a real value.
        const gateIndex = deployBlock.indexOf('if [ "$SCHEMA_DRIFT_MODE" = "true" ]; then');
        const debtCheckIndex = deployBlock.indexOf('SELECT COUNT(*) FROM public.subscriptions WHERE threshold_debt <> 0');
        const skippedIndex = deployBlock.indexOf("THRESHOLD_DEBT_INITIALIZATION=SKIPPED");

        expect(gateIndex).toBeGreaterThan(-1);
        expect(debtCheckIndex).toBeGreaterThan(gateIndex);
        expect(skippedIndex).toBeGreaterThan(-1);
        expect(deployBlock).toContain(
            // Union of both deploy-hardening efforts: main's RELEASE_TARGET and
            // public-smoke URLs plus Stage 2's run-attempt and rehearsed rollback
            // digest pair. Every env from either side must stay wired through.
            'envs: GHCR_BACKEND,GHCR_FRONTEND,GHCR_GROWTH,GROWTH_BOOTSTRAP_DIGEST,GROWTH_IMAGE_OVERRIDE,BACKEND_TAG,FRONTEND_TAG,BACKEND_DIGEST,FRONTEND_DIGEST,DEPLOYED_COMMIT,WORKFLOW_RUN_ID,WORKFLOW_RUN_ATTEMPT,DEPLOYED_AT,GH_ACTOR,GH_TOKEN,WIPE_DB,SEED_ADMIN,ROLLBACK_STATE_DIR,SCHEMA_DRIFT_MODE,RELEASE_TARGET,APP_URL,API_URL,GROWTH_URL,EXPECTED_ROLLBACK_BACKEND_DIGEST,EXPECTED_ROLLBACK_FRONTEND_DIGEST',
        );
    });

    test('the candidate-probe digest-pin check uses a real regex, not a shell glob', () => {
        // `case … in *@sha256:[0-9a-fA-F]{64})` is a shell glob, where `{64}` has
        // no repetition meaning (bash only expands `{a,b}`/`{x..y}`) — it can
        // never match a real digest, so the probe fails closed on every run.
        // This job's `if:` only runs on a real deploy_confirmation dispatch, so
        // no prior green CI run ever exercised it. Must use grep -E (or an
        // equivalent real-regex engine) like the other two digest-pin checks in
        // this file do.
        const deployBlock = workflow.match(/\n  deploy:\n([\s\S]*)$/)?.[1];

        expect(deployBlock).not.toMatch(/case\s+"\$image_ref"\s+in\s+\*@sha256:\[0-9a-fA-F\]\{64\}\)/);
        expect(deployBlock).toContain("grep -Eq '@sha256:[0-9a-fA-F]{64}");
        // Four real-regex digest-pin checks total: EXISTING_BACKEND_DIGEST
        // format validation, this probe, assert_immutable_ref() in the deploy
        // script, and the restore-floor job's verbatim assert_immutable_ref
        // copy. Each is in a different quoting context (one needs \$ since it
        // is nested inside a local double-quoted ssh argument), so match on
        // the pattern core only.
        const digestSites = [...workflow.matchAll(/grep -Eq '[^']*\\?\[0-9a-fA-F\]\\?\{64\\?\}[^']*'/g)];
        expect(digestSites).toHaveLength(4);
        const restoreFloorSectionStart = workflow.indexOf('# ── 6. Restore-floor recovery');
        expect(restoreFloorSectionStart).toBeGreaterThan(-1);
        expect(digestSites[3].index).toBeGreaterThan(restoreFloorSectionStart);
        expect(digestSites[3][0]).toContain('@sha256:[0-9a-fA-F]{64}');
    });

    test('rejects the destructive production wipe path', () => {
        const deployBlock = workflow.match(/\n  deploy:\n([\s\S]*)$/)?.[1];

        expect(deployBlock).toContain('WIPE_DB=WIPE is disabled for production cutover');
        expect(deployBlock.indexOf('WIPE_DB=WIPE is disabled')).toBeLessThan(
            deployBlock.indexOf('if [ "$WIPE_DB" = "WIPE" ]; then', deployBlock.indexOf('WIPE_DB=WIPE is disabled') + 1),
        );
    });

    test('keeps repository-variable mutation outside contributor-controlled jobs', () => {
        expect(workflow).not.toContain('actions: write');
        expect(workflow).toContain('operator-owned repository control');
        expect(workflow).toContain("inputs.deploy_confirmation == format('DEPLOY-{0}', github.sha)");
        expect(workflow).toContain("description: 'One-shot production confirmation. Type DEPLOY-<full main SHA>.'");
    });

    test('derives and fails closed on a pinned fingerprint at every SSH action site', () => {
        const sshWorkflows = fs
            .readdirSync(workflowDirectory)
            .filter((name) => name.endsWith('.yml'))
            .map((name) => ({
                source: fs.readFileSync(path.join(workflowDirectory, name), 'utf8'),
            }))
            .filter(({ source }) => source.includes('uses: appleboy/ssh-action@'));

        let sshActionSites = 0;
        for (const { source } of sshWorkflows) {
            sshActionSites += (source.match(/uses: appleboy\/ssh-action@/g) || []).length;
            expect(source).toContain('fingerprint: ${{ steps.ssh_host.outputs.fingerprint }}');
            expect(source).toContain('id: ssh_host');
            expect(source).toContain('DO_SSH_KNOWN_HOSTS');
            expect(source).toContain("if [ -z \"$key_type\" ] || [ -z \"$key_blob\" ]; then");
            expect(source).toContain("echo '::error::pinned host key is missing for DEPLOY_HOST'");
            expect(source).toContain('exit 1');
            expect(source).not.toContain('DO_SSH_FINGERPRINT');
            expect(source).not.toContain('ssh-keyscan');
        }

        // The restore-floor job adds the tenth appleboy site. Every per-site
        // pin above (pinned fingerprint derivation, known-hosts fail-closed,
        // no DO_SSH_FINGERPRINT, no ssh-keyscan) applies to the whole file,
        // and the dedicated restore-floor test below additionally pins the
        // restore site's own id: ssh_host, command_timeout, and envs literal.
        expect(sshActionSites).toBe(10);
    });

    test('requires an immutable image for restore-drill forward migration', () => {
        const backupWorkflow = fs.readFileSync(
            path.resolve(__dirname, '../../../../.github/workflows/backup.yml'),
            'utf8',
        );
        expect(backupWorkflow).toContain('forward migration image must be the immutable backend digest reference');
        expect(backupWorkflow).toContain('docker pull "$MIGRATION_IMAGE"');
        expect(backupWorkflow).toContain('DEST_PREFIX" = "uploads"');
        expect(backupWorkflow).toContain('tar -tzf "/backup/$(basename "$DECRYPTED")"');
        // Both backup and restore-drill open SSH into production; both must sit
        // behind the production environment gate. A future edit that adds a
        // concurrency block but forgets one env gate must fail closed here.
        const backup = backupWorkflow.replace(/\r\n/g, '\n');
        expect(backup).toMatch(/^ {4}environment: production$/m);
        // Assert that BOTH jobs have their own environment: production line,
        // not just one. The backup job appears before restore-drill in the
        // file; the count must be at least 2 to close the previous gap where
        // only backup had it.
        const environmentMatches = backup.match(/^ {4}environment: production$/gm) || [];
        expect(environmentMatches.length).toBeGreaterThanOrEqual(2);
    });

    test('pins the PostgreSQL helper image inside the isolated restore job', () => {
        const backupWorkflow = fs.readFileSync(
            path.resolve(__dirname, '../../../../.github/workflows/backup.yml'),
            'utf8',
        );
        const normalizedWorkflow = backupWorkflow.replace(/\r\n/g, '\n');
        const restoreJob = normalizedWorkflow.split('\n  restore-drill:\n')[1] || '';
        const scriptMarker = 'script: |\n';
        const scriptStart = restoreJob.indexOf(scriptMarker);
        expect(scriptStart).toBeGreaterThanOrEqual(0);

        const restoreScript = restoreJob.slice(scriptStart + scriptMarker.length);
        const helperImageDeclaration = restoreScript.indexOf(
            "POSTGRES_HELPER_IMAGE='postgres@sha256:df7bca0066e6f60cc3dd32faa70caddec20e2c22b58932f79498e5704b23854a'",
        );
        const helperImageUse = restoreScript.indexOf('"$POSTGRES_HELPER_IMAGE" sh -c');

        expect(helperImageDeclaration).toBeGreaterThanOrEqual(0);
        expect(helperImageUse).toBeGreaterThan(helperImageDeclaration);
    });

    test('backup validates the configured off-site retention policy', () => {
        const backupWorkflow = fs.readFileSync(
            path.resolve(__dirname, '../../../../.github/workflows/backup.yml'),
            'utf8',
        );

        expect(backupWorkflow).toContain(
            'OFFSITE_RETENTION_DAYS must be a positive integer',
        );
        // Retention + privacy are proven OCI-natively with the restricted
        // read-only audit identity: the S3-compat API cannot read OCI
        // lifecycle policies, so the DO-era S3 query must never come back.
        expect(backupWorkflow).toContain('get_object_lifecycle_policy');
        expect(backupWorkflow).toContain('public_access_type != "NoPublicAccess"');
        expect(backupWorkflow).toContain('OFFSITE_PRIVACY_CHECK=NoPublicAccess:PASS');
        expect(backupWorkflow).toContain('OFFSITE_LIFECYCLE_RETENTION=');
        expect(backupWorkflow).not.toContain('get-bucket-lifecycle-configuration');
        // The retired DigitalOcean token probe must not be reintroduced; the
        // fail-closed contract now hangs on the off-site credentials themselves.
        expect(backupWorkflow).not.toContain('DO_TOKEN');
        expect(backupWorkflow).toContain('RECOVERY_EXECUTION_PAUSED_FOR_CREDENTIAL');
        expect(backupWorkflow).toContain(
            'Off-site lifecycle retention policy verified',
        );
    });

    test('rollback verifies restored images, worker, public stack, and health before returning', () => {
        const deployBlock = workflow.match(/\n  deploy:\n([\s\S]*)$/)?.[1];

        expect(deployBlock).toContain('verify_rollback() {');
        // Stage 2's combined backend+worker+routed probe replaced main's
        // backend-only 100s loop, so the failure literal is the probe-limit
        // message; main's worker-health and identity-bound public-stack gates
        // are unioned into the same verify_rollback below.
        expect(deployBlock).toContain('rollback health check failed within the probe limit');
        expect(deployBlock).toContain("--resolve 'easymod.tech:443:127.0.0.1'");
        expect(deployBlock).toContain("--resolve 'api.easymod.tech:443:127.0.0.1'");
        expect(deployBlock).toContain('verify_worker_health || return 1');
        expect(deployBlock).toContain('previous_backend_commit=$(docker run');
        expect(deployBlock).toContain('previous_growth_commit=$(extract_growth_commit');
        expect(deployBlock).toContain('verify_public_stack "$previous_backend_commit" "$previous_growth_commit" || return 1');
        // finish_deploy supersedes main's inline EXIT trap: rollback failure
        // still exits 70, and the transaction marker must survive a failed
        // recovery for operator reconciliation.
        expect(deployBlock).toContain('rollback || exit 70');
        const marker = deployBlock.indexOf('ln -- "$ROLLBACK_STATE_DIR/transaction" "$active_transaction"');
        const trap = deployBlock.indexOf('trap finish_deploy EXIT');
        expect(trap).toBeGreaterThan(-1);
        expect(marker).toBeGreaterThan(trap);
        for (const file of ['.env.prod', 'docker-compose.prod.yml', 'Caddyfile']) {
            expect(deployBlock.indexOf(`cp -p "$candidate_dir/${file}" /opt/easymod/${file}`)).toBeGreaterThan(marker);
        }
        expect(deployBlock).toMatch(/rollback \|\| exit 70\s+fi\s+rm -- "\$active_transaction" \|\| exit 70/);
    });

    test('successful cutover proves the running image reports its own bound commit', () => {
        const deployBlock = workflow.match(/\n  deploy:\n([\s\S]*)$/)?.[1];
        const commitIndex = deployBlock.indexOf('candidate_backend_commit=$(docker run');
        // Stage 2 installs verify_rollback (which probes /health/ready itself)
        // before activation, so the first /health/ready literal in the block is
        // the rollback probe. Anchor the forward-gate search after the candidate
        // commit binding: the forward health gate must still run after it.
        const healthIndex = deployBlock.indexOf("http://127.0.0.1:3000/health/ready", commitIndex);
        const versionIndex = deployBlock.indexOf("http://127.0.0.1:3000/api/version");

        expect(commitIndex).toBeGreaterThan(-1);
        expect(healthIndex).toBeGreaterThan(commitIndex);
        expect(versionIndex).toBeGreaterThan(healthIndex);
        expect(deployBlock).toContain('docker exec -i -e EXPECTED_BACKEND_COMMIT="$candidate_backend_commit"');
        expect(deployBlock).toContain('payload.gitSha !== process.env.EXPECTED_BACKEND_COMMIT');
        expect(deployBlock).toContain('"BACKEND_COMMIT": "${candidate_backend_commit}"');
    });

    test('frontend-only cutovers bind the release SHA without replacing or relabeling the backend', () => {
        const deployBlock = workflow.match(/\n  deploy:\n([\s\S]*)$/)?.[1];
        const guardStep = deployBlock.match(
            /- name: Reject backend substitutions in frontend-only releases\n([\s\S]*?)\n      - name: /,
        )?.[1];
        const guardIndex = deployBlock.indexOf(
            'Reject backend substitutions in frontend-only releases',
        );
        // Stage 2 renamed the copy step: config is staged into the private
        // per-attempt candidate directory, never straight onto live paths.
        const stageIndex = deployBlock.indexOf(
            'Stage candidate config on droplet',
        );

        expect(deployBlock).toContain(
            "inputs.target != 'frontend' || inputs.existing_candidate_sha == github.sha",
        );
        expect(deployBlock).toContain(
            'DEPLOYED_COMMIT: ${{ inputs.existing_candidate_sha || github.sha }}',
        );
        expect(workflow).toContain(
            'if [ "$RELEASE_TARGET" = "frontend" ] && [ -n "$BACKEND_DIGEST" ]; then',
        );
        expect(workflow).toContain(
            'if [ "$RELEASE_TARGET" = "frontend" ] && [ "$candidate_backend_commit" != "$previous_backend_commit" ]; then',
        );
        expect(deployBlock).toContain(
            'if [ -n "$BACKEND_TAG" ] && [ "$candidate_backend_commit" != "$DEPLOYED_COMMIT" ]; then',
        );
        expect(deployBlock).toContain(
            'docker exec -i -e EXPECTED_BACKEND_COMMIT="$candidate_backend_commit"',
        );

        // The preflight must observe the resolved build output (which falls back
        // to inputs.existing_backend_digest) and must run before any droplet
        // file is overwritten.
        expect(guardStep).toContain("if: inputs.target == 'frontend'");
        expect(guardStep).toContain('BACKEND_DIGEST: ${{ needs.build.outputs.backend_digest }}');
        expect(guardStep).toContain('if [ -n "${BACKEND_DIGEST:-}" ]; then');
        expect(guardIndex).toBeGreaterThan(-1);
        expect(stageIndex).toBeGreaterThan(guardIndex);
    });

    test('rollback rehearsal exercises the real worker-health and public-stack gates', () => {
        const rehearsal = fs.readFileSync(
            path.resolve(__dirname, '../../../../scripts/rollback-rehearsal.sh'),
            'utf8',
        );

        // Union of both extraction lists: Stage 2's config-hash/transaction
        // functions plus main's worker-health and public-stack gates.
        expect(rehearsal).toContain(
            "EXTRACTED_FUNCTIONS='resolve_container_digest,assert_immutable_ref,config_hashes,verify_config,verify_worker_health,verify_public_stack,verify_rollback,finish_deploy,rollback'",
        );
        expect(rehearsal).toContain('container_name: easymod-worker-1');
        expect(rehearsal).toContain('container_name: easymod-public-stub-1');
        expect(rehearsal).toContain('export APP_URL="http://127.0.0.1:18081"');
        expect(rehearsal).toContain('export API_URL="http://127.0.0.1:18081"');
        expect(rehearsal).toContain('export GROWTH_URL="http://127.0.0.1:18081"');
        expect(rehearsal).toContain('Worker health check passed on attempt');
        expect(rehearsal).toContain("grep -Fq 'smoke passed on attempt'");
        expect(rehearsal).toContain('rollback did not run the worker-health gate');
        expect(rehearsal).toContain('rollback did not run the identity-bound public-stack gate');
        expect(rehearsal).not.toContain('STUBBED-BY-REHEARSAL');

        // WP-04 restore-floor lane: a --restore-floor selector skips the
        // forward-cutover scenarios and runs the same extracted functions in
        // writer -> floor -> rollback order; the default full rehearsal appends
        // the lane after the forward scenarios so CI proves both.
        expect(rehearsal).toContain('--restore-floor');
        expect(rehearsal).toContain('if [[ "${1:-}" != --restore-floor ]]; then');
        expect(rehearsal).toContain('extract_function verify_reader_projection_source');
        expect(rehearsal).toContain('restore_assert_rollback_match');
        expect(rehearsal).toContain('does not match the rehearsed rollback digest');
        expect(rehearsal).toContain('is not a reader-only recovery revision');
        expect(rehearsal).toContain('git merge-base --is-ancestor "$floor_sha" "$writer_sha"');
        expect(rehearsal).toContain('does not match the exact floor pair');
        expect(rehearsal).toContain('restore_before_activation');
        expect(rehearsal).toContain('Floor-restore EXIT handler interruption checks passed');
        expect(rehearsal).toContain('restoreScenarios');
        for (const field of ['RESTORE_R1', 'RESTORE_R2', 'RESTORE_R3', 'RESTORE_R4', 'RESTORE_R5', 'RESTORE_R67', 'RESTORE_R8', 'RESTORE_GROWTH_OVERRIDE']) {
            expect(rehearsal).toContain(`${field}=PASS`);
        }
        // WP-06 growth-override case: fixture commit binding, public identity
        // through the live stub, swap taking effect, and rollback carry-restore.
        expect(rehearsal).toContain('Growth image build-info commit');
        expect(rehearsal).toContain('rollback did not restore the incumbent Growth image after the override');
    });

    test('successful cutover gates worker and identity-bound public app, API, and Growth health', () => {
        const deployBlock = workflow.match(/\n  deploy:\n([\s\S]*)$/)?.[1];
        const workerIndex = deployBlock.indexOf('verify_worker_health || exit 1');
        const versionIndex = deployBlock.indexOf('docker exec -i -e EXPECTED_BACKEND_COMMIT="$candidate_backend_commit"');
        const publicSmokeIndex = deployBlock.indexOf(
            'verify_public_stack "$candidate_backend_commit" "$candidate_growth_commit" || exit 1',
        );
        const successIndex = deployBlock.indexOf('deploy_succeeded=true');

        expect(workerIndex).toBeGreaterThan(-1);
        expect(versionIndex).toBeGreaterThan(workerIndex);
        expect(publicSmokeIndex).toBeGreaterThan(versionIndex);
        expect(successIndex).toBeGreaterThan(publicSmokeIndex);
        expect(deployBlock).toContain('Public app/API/Growth smoke passed');
        expect(deployBlock).toContain('payload.redis === "connected"');
        expect(deployBlock).toContain('payload.gitSha !== process.env.EXPECTED_BACKEND_COMMIT');
        expect(deployBlock).toContain('payload.commit !== process.env.EXPECTED_GROWTH_COMMIT');
        expect(deployBlock).toContain('deadline=$(( $(date +%s) + 120 ))');
        expect(deployBlock).toContain('smoke_get() {');
        expect(deployBlock).toContain('smoke_remaining=$(( deadline - $(date +%s) ))');
        expect(deployBlock).toContain('smoke_timeout=$(( smoke_remaining < 5 ? smoke_remaining : 5 ))');
        expect(deployBlock).toContain('-m "$smoke_timeout"');
        expect(deployBlock).toContain('failed after the 120s deadline');
        expect(deployBlock).toContain('exceeded the 120s deadline');
    });

    test('production probe records exact image identity and current capacity as an artifact', () => {
        expect(workflow).toContain('probe_output=$(ssh');
        expect(workflow).toContain('printf \'%s\\n\' "$probe_output" > _tmp/production-probe.txt');
        expect(workflow).toContain('name: production-probe-evidence');
        expect(workflow).toContain('path: _tmp/production-probe.txt');
        expect(workflow).toContain('echo PRODUCTION_CAPACITY');
        expect(workflow).toContain('docker stats --no-stream');
        expect(workflow).toContain('used_memory_peak:');
        expect(workflow).toContain('evicted_keys:');
        expect(workflow).toContain('$NF == "/" || $NF == "/var/lib/docker"');
        expect(workflow).not.toContain('$1 == "/" || $1 == "/var/lib/docker"');
    });

    test('restore-floor is a gated production-only recovery path with build and deploy excluded', () => {
        expect(workflow).toContain('options: [all, backend, frontend, probe, restore-floor]');
        expect(releaseWorkflow).toContain('options: [all, backend, frontend, probe, restore-floor]');
        expect(workflow.match(/inputs\.target != 'restore-floor'/g)).toHaveLength(2);
        const buildBlock = workflow.match(/\n  build:\n([\s\S]*?)\n  # ── 4\./)?.[1];
        expect(buildBlock).toContain("inputs.target != 'restore-floor' &&");
        const deployStart = workflow.indexOf('\n  deploy:\n');
        const deployGate = workflow.slice(deployStart, workflow.indexOf('environment: production', deployStart));
        expect(deployGate).toContain("inputs.target != 'restore-floor' &&");
        // The rehearsal + rollback-contract validator gate the restore dispatch.
        const deploymentConfigBlock = workflow.match(/\n  deployment-config:\n([\s\S]*?)\n  # ── 2d\./)?.[1];
        expect(deploymentConfigBlock).toContain("(inputs.target == 'probe' || inputs.target == 'restore-floor')");

        const restoreBlock = workflow.slice(workflow.indexOf('# ── 6. Restore-floor recovery'));
        expect(restoreBlock).toContain('name: Restore qualified floor images');
        expect(restoreBlock).toContain('needs: [changes, deployment-config]');
        expect(restoreBlock).toContain('timeout-minutes: 45');
        expect(restoreBlock).toContain('environment: production');
        expect(restoreBlock).toContain('permissions:\n      contents: read\n      packages: read');
        expect(restoreBlock).toContain("github.event_name == 'workflow_dispatch' &&");
        expect(restoreBlock).toContain("github.ref == 'refs/heads/main' &&");
        expect(restoreBlock).toContain("inputs.target == 'restore-floor' &&");
        expect(restoreBlock).toContain("vars.PRODUCTION_DEPLOY_ENABLED == 'true' &&");
        expect(restoreBlock).toContain("inputs.deploy_confirmation == format('DEPLOY-{0}', github.sha)");
        // No new dispatch inputs: the restore reuses the existing 13 and the
        // workflow_dispatch budget (capped by GitHub at 10 rendered fields)
        // must not grow.
        const dispatchBlock = workflow.slice(workflow.indexOf('  workflow_dispatch:'), workflow.indexOf('concurrency:'));
        expect((dispatchBlock.match(/^      [a-z_]+:$/gm) || [])).toHaveLength(13);
        // The gate is operator-owned: nothing in this workflow may mutate it.
        expect(restoreBlock).toContain('The workflow never mutates PRODUCTION_DEPLOY_ENABLED;');
        expect(restoreBlock).toContain('operator must set the gate back to false after');
        expect(workflow).not.toContain('gh variable set');
    });

    test('restore-floor qualifies the floor pair before activation, carries growth forward, and fails closed to the writer', () => {
        const restoreBlock = workflow.slice(workflow.indexOf('# ── 6. Restore-floor recovery'));
        const qualifyStep = restoreBlock.indexOf('- name: Qualify floor images');
        const sshStep = restoreBlock.indexOf('- name: Restore floor via SSH');
        const activation = restoreBlock.indexOf('            activation_started=true');
        const incumbent = restoreBlock.indexOf('[ "$previous_backend_image" != "$GHCR_BACKEND@$EXPECTED_ROLLBACK_BACKEND_DIGEST" ]');
        const marker = restoreBlock.indexOf('ln -- "$ROLLBACK_STATE_DIR/transaction" "$active_transaction"');
        const upLine = restoreBlock.indexOf('up -d --no-build --remove-orphans backend worker frontend growth-frontend');
        const metadata = restoreBlock.indexOf('"DEPLOYED_COMMIT": "${FLOOR_REVISION}",');
        expect(qualifyStep).toBeGreaterThan(-1);
        expect(sshStep).toBeGreaterThan(qualifyStep);
        expect(incumbent).toBeGreaterThan(sshStep);
        expect(incumbent).toBeLessThan(activation);
        expect(marker).toBeLessThan(activation);
        expect(activation).toBeLessThan(upLine);
        expect(upLine).toBeLessThan(metadata);
        expect(restoreBlock).toContain('deploy_succeeded=true');
        expect(restoreBlock).toContain('rollback || exit 70');

        // Runner-side qualification before any SSH: destructive/override inputs
        // rejected, all four digests required and exact, floor revision real.
        expect(restoreBlock).toContain('test -z "$WIPE_REQUEST$SEED_REQUEST$GROWTH_REQUEST$SCHEMA_DRIFT_REQUEST"');
        expect(restoreBlock).toContain('test "$RELEASE_TARGET" = restore-floor');
        expect(restoreBlock).toContain('for digest in "$EXISTING_BACKEND_DIGEST" "$EXISTING_FRONTEND_DIGEST" "$EXPECTED_ROLLBACK_BACKEND_DIGEST" "$EXPECTED_ROLLBACK_FRONTEND_DIGEST"; do');
        expect(restoreBlock).toContain('[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]');
        expect(restoreBlock).toContain('floor_revision=$(arm64_image_revision "$GHCR_BACKEND@$EXISTING_BACKEND_DIGEST")');
        expect(restoreBlock).toContain('if ! [[ "$floor_revision" =~ ^[0-9a-f]{40}$ ]]; then');
        expect(restoreBlock).toContain('git merge-base --is-ancestor "$floor_revision" "$SHA"');
        expect(restoreBlock).toContain("verify_reader_projection_source \"$floor_revision\" 'Restore floor' reader");
        expect(restoreBlock).toContain("verify_reader_projection_source \"$SHA\" 'Current main' writer");
        expect(restoreBlock).toContain('pull_arm64_image "$GHCR_FRONTEND@$EXISTING_FRONTEND_DIGEST" >/dev/null');
        expect(restoreBlock).toContain("printf 'floor_revision=%s\\n' \"$floor_revision\" >> \"$GITHUB_OUTPUT\"");
        expect(restoreBlock).toContain('FLOOR_REVISION: ${{ steps.floor.outputs.floor_revision }}');

        // Host-side candidate = floor pair; growth carried forward, never
        // overridden; interpolated production stack stays digest-pinned.
        expect(restoreBlock).toContain('candidate_backend_image="$GHCR_BACKEND@$EXISTING_BACKEND_DIGEST"');
        expect(restoreBlock).toContain('candidate_frontend_image="$GHCR_FRONTEND@$EXISTING_FRONTEND_DIGEST"');
        expect(restoreBlock).toContain('assert_immutable_ref "$candidate_backend_image"');
        expect(restoreBlock).toContain('assert_immutable_ref "$candidate_frontend_image"');
        expect(restoreBlock).toContain('export GHCR_IMAGE_BACKEND="$candidate_backend_image"');
        expect(restoreBlock).toContain('export GHCR_IMAGE_FRONTEND="$candidate_frontend_image"');
        expect(restoreBlock).toContain('candidate_growth_image="$previous_growth_image"');
        expect(restoreBlock).toContain('candidate_growth_image="${GHCR_GROWTH}@${GROWTH_BOOTSTRAP_DIGEST}"');
        expect(restoreBlock).toContain('assert_immutable_ref "$candidate_growth_image"');
        expect(restoreBlock).toContain('export GHCR_IMAGE_GROWTH="$candidate_growth_image"');
        expect(restoreBlock).toContain('candidate_growth_commit=$(extract_growth_commit "$candidate_growth_image")');
        expect(restoreBlock).toContain('production_images=$(docker compose --env-file .env.prod -f docker-compose.prod.yml config --images)');
        expect(restoreBlock).toContain('if [ "$candidate_backend_commit" != "$FLOOR_REVISION" ]; then');
        expect(restoreBlock).toContain('does not match the exact floor pair');
        expect(restoreBlock).toContain('verify_public_stack "$candidate_backend_commit" "$candidate_growth_commit" || exit 1');

        // The SSH envs literal is contiguous, restore-specific, and carries no
        // destructive input; the fingerprint site and command cap are explicit.
        expect(restoreBlock).toContain('id: ssh_host');
        expect(restoreBlock).toContain('fingerprint: ${{ steps.ssh_host.outputs.fingerprint }}');
        expect(restoreBlock).toContain('command_timeout: 30m');
        expect(restoreBlock).toContain('timeout: 600s');
        expect(restoreBlock).toContain('envs: GHCR_BACKEND,GHCR_FRONTEND,GHCR_GROWTH,GROWTH_BOOTSTRAP_DIGEST,EXISTING_BACKEND_DIGEST,EXISTING_FRONTEND_DIGEST,FLOOR_REVISION,WORKFLOW_RUN_ID,WORKFLOW_RUN_ATTEMPT,DEPLOYED_AT,GH_ACTOR,GH_TOKEN,ROLLBACK_STATE_DIR,APP_URL,API_URL,GROWTH_URL,EXPECTED_ROLLBACK_BACKEND_DIGEST,EXPECTED_ROLLBACK_FRONTEND_DIGEST');
        expect(restoreBlock).not.toContain('WIPE_DB: ${{');
        expect(restoreBlock).not.toContain('SEED_ADMIN: ${{');
        expect(restoreBlock).not.toContain('BACKEND_TAG: ${{');
        expect(restoreBlock).not.toContain('FRONTEND_TAG: ${{');

        // A restore changes images only: no candidate config is staged or
        // activated, no migrations run, no DB probe, no rendering, no build.
        // This is also the only way the validator's single-cp-line uniqueness
        // contract can hold with a second job in the file.
        expect(restoreBlock).not.toContain('cp -p "$candidate_dir');
        expect(restoreBlock).not.toContain('candidate.sha256');
        expect(restoreBlock).not.toContain('Stage candidate config');
        expect(restoreBlock).not.toContain('MIGRATION_START');
        expect(restoreBlock).not.toContain('migrate.js');
        expect(restoreBlock).not.toContain('schema-drift-audit');
        expect(restoreBlock).not.toContain('production-db-auth-probe');
        expect(restoreBlock).not.toContain('render-production-env');
        expect(restoreBlock).not.toContain('build-push-action');
        expect(restoreBlock).not.toContain('labels: org.opencontainers.image.revision');
        expect(restoreBlock).not.toContain('npm ci');
        expect(restoreBlock).not.toContain('npm run');
        expect(restoreBlock).not.toContain('SEED_ADMIN');
        expect(restoreBlock).not.toContain('WIPE_DB=WIPE is disabled');

        // Minimal run-scoped cleanup; snapshots and metadata stay for the
        // operator after every attempt.
        expect(restoreBlock).toContain('name: Remove run-scoped restore state');
        expect(restoreBlock).toContain('if: always()');
        expect(restoreBlock).toContain('refusing to clean a restore candidate environment outside this workflow attempt');
        expect(restoreBlock).toContain('restricted by its mode-700 parent directory');
    });

    test('the restore-floor job reuses the deploy machinery byte-identically', () => {
        // R3 design ruling: rollback-rehearsal.sh extracts each function by
        // FIRST name+indent match, so the forward scenarios exercise the
        // deploy-side copies; the restore job must therefore be a verbatim
        // copy, not a drifting second implementation. This pin compares the
        // full function text (definition through closing brace at the same
        // YAML block indent) between the two scopes.
        const restoreStart = workflow.indexOf('# ── 6. Restore-floor recovery');
        expect(restoreStart).toBeGreaterThan(-1);
        const deploySide = workflow.slice(0, restoreStart);
        const restoreSide = workflow.slice(restoreStart);
        const extractFunction = (source, name) => {
            const lines = source.split('\n');
            const opener = new RegExp(`^[ ]+${name}\\(\\) \\{$`);
            const start = lines.findIndex((line) => opener.test(line));
            if (start < 0) return undefined;
            const indent = lines[start].match(/^[ ]+/)[0];
            const end = lines.slice(start + 1).findIndex((line) => line === `${indent}}`);
            if (end < 0) return undefined;
            return lines.slice(start, start + 2 + end).join('\n');
        };
        for (const name of [
            'resolve_container_digest',
            'assert_immutable_ref',
            'config_hashes',
            'verify_config',
            'verify_worker_health',
            'verify_public_stack',
            'verify_rollback',
            'finish_deploy',
            'rollback',
            'extract_growth_commit',
            'pull_arm64_image',
            'arm64_image_revision',
            'verify_reader_projection_source',
        ]) {
            // Rehearsal extraction (first match) must keep landing on the
            // deploy-side copy, never the restore-side duplicate.
            expect(workflow.indexOf(`${name}() {`)).toBeLessThan(restoreStart);
            const reference = extractFunction(deploySide, name);
            const restored = extractFunction(restoreSide, name);
            expect([name, reference === undefined ? 'deploy-missing' : 'ok']).toEqual([name, 'ok']);
            expect([name, restored === undefined ? 'restore-missing' : 'ok']).toEqual([name, 'ok']);
            expect(restored).toBe(reference);
        }
    });
});

// The production mobile proof holds a real test merchant's password, reads the
// signed release and opens a read-only SSH session. Pin that envelope so a later
// edit cannot quietly widen it (docs/deployment/MOBILE_API_ACTIVATION_RUNBOOK.md).
describe('mobile production proof workflow', () => {
    const proof = fs
        .readFileSync(path.join(workflowDirectory, 'mobile-production-proof.yml'), 'utf8')
        .replace(/\r\n/g, '\n');
    const proofSql = fs.readFileSync(
        path.resolve(__dirname, '../../../../scripts/mobile-production-proof/observability.sql'),
        'utf8',
    );
    const code = proof.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');

    test('is manual, main-only and bound to the production environment', () => {
        expect(code).toMatch(/^on:\n {2}workflow_dispatch:/m);
        expect(code).not.toMatch(/^\s+(push|pull_request|pull_request_target|schedule|workflow_run):/m);
        expect(code).toContain("if: github.ref == 'refs/heads/main'");
        expect(code).toMatch(/^ {4}environment: production$/m);
        expect(code).toContain('cancel-in-progress: false');
    });

    test('is read-only toward the repository and never sees the upload key', () => {
        expect(code).toMatch(/^permissions:\n {2}contents: read\n/m);
        expect(code).not.toMatch(/:\s*write\b/);
        expect(code).not.toMatch(/ANDROID_UPLOAD|KEYSTORE/);
        const secrets = [...new Set([...code.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((match) => match[1]))].sort();
        expect(secrets).toEqual([
            'DEPLOY_HOST',
            'DO_SSH_KNOWN_HOSTS',
            'DO_SSH_PRIVATE_KEY',
            'META_REVIEW_MERCHANT_PASSWORD',
            'SEED_ADMIN_PASSWORD',
        ]);
        expect(code).not.toMatch(/toJSON\(\s*secrets\s*\)|\$\{\{\s*secrets\s*\}\}/);
    });

    test('keeps credentials out of the rollback-state proof', () => {
        expect(code).toContain("MERCHANT_PASSWORD: ${{ inputs.expect_mobile_api == 'enabled' && secrets.META_REVIEW_MERCHANT_PASSWORD || '' }}");
        expect(code).toContain("ADMIN_PASSWORD: ${{ inputs.expect_mobile_api == 'enabled' && secrets.SEED_ADMIN_PASSWORD || '' }}");
        expect(code).toContain("RUN_DEVICE: ${{ inputs.expect_mobile_api == 'enabled' && inputs.device }}");
    });

    test('uses production over SSH read-only, with a pinned host key', () => {
        expect(code).toContain('StrictHostKeyChecking=yes');
        expect(code).toContain('ssh-keygen -F "$DEPLOY_HOST" -f ~/.ssh/known_hosts');
        expect(code).not.toMatch(/ssh-keyscan|StrictHostKeyChecking=no|scp |docker compose|docker (run|restart|stop|rm)\b/);
        const remoteCommands = [...code.matchAll(/remote "([^\n]*)"/g)].map((match) => match[1]);
        expect(remoteCommands).toHaveLength(2);
        expect(remoteCommands[0]).toMatch(/^docker logs --since '\$PROOF_START' easymod-backend-1 /);
        expect(remoteCommands[1]).toMatch(/^docker exec -i easymod-postgres-1 sh -c 'psql /);
        expect(proofSql).toContain('BEGIN TRANSACTION READ ONLY;');
        expect(proofSql).toContain('ROLLBACK;');
        expect(proofSql).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|GRANT|COPY)\b/i);
    });

    test('verifies the signed artifact before any device run and scans every upload for the credential', () => {
        expect(code).toContain('git diff --quiet "$release_source_sha" HEAD -- EasyMod-mobile');
        expect(code).toContain('sha256sum --check SHA256SUMS');
        expect(code).toContain("steps.api.outcome == 'success'");
        expect(code).toContain("--expect-signer \"$(node -p \"require('./EasyMod-mobile/release-signing.json').certificateSha256\")\"");
        expect(code.indexOf('--expect-signer')).toBeLessThan(code.indexOf('android-emulator-runner'));
        expect(code).toContain('grep -rlF -- "$secret" proof');
        expect(code).toContain("if: ${{ !cancelled() && steps.api.outcome == 'success' && steps.scan.outcome == 'success' }}");
    });

    test('runs a signed build variant only under that variant\'s own identity', () => {
        expect(code).toMatch(/^ {6}variant:\n(?: {8}.+\n)*? {8}options: \[preview, production\]$/m);
        expect(code).toContain('preview) app_id=tech.easymod.merchant.preview; scheme=easymodmerchantpreview; artifact=mobile-release ;;');
        expect(code).toContain('production) app_id=tech.easymod.merchant; scheme=easymodmerchant; artifact=mobile-release-production ;;');
        expect(code).toContain('-n "$RELEASE_ARTIFACT-$release_sha"');
        for (const flag of ['--package "$MAESTRO_PROOF_APP_ID"', '--variant "$RELEASE_VARIANT"', '--source-sha "$RELEASE_SHA"']) {
            expect(code).toContain(flag);
            expect(code.indexOf(flag)).toBeLessThan(code.indexOf('android-emulator-runner'));
        }
    });
});

describe('merchant edge isolation and privileged command coverage', () => {
    test('uses an explicit loopback address for the Growth readiness listener', () => {
        const growthBlock = compose.match(
            /\r?\n {2}growth-frontend:\r?\n([\s\S]*?)(?:\r?\n {2}[a-z0-9-]+:|\r?\nvolumes:)/,
        )?.[1];
        const readinessUrl = growthBlock?.match(/http:\/\/[^\s"']+\/health\/ready/)?.[0];
        expect(readinessUrl).toBeTruthy();

        const url = new URL(readinessUrl);
        const listeners = Array.from(
            growthNginx.matchAll(/^\s*listen\s+([^;]+);/gm),
            (match) => match[1].trim(),
        );
        const reachesConfiguredListener = url.port === '8080'
            && ((url.hostname === '127.0.0.1' && listeners.includes('8080'))
                || (url.hostname === '::1' && listeners.includes('[::]:8080')));

        expect(reachesConfiguredListener).toBe(true);
    });

    test('the TLS edge no longer cold-depends on the internal Growth SPA', () => {
        const caddyBlock = compose.match(/\r?\n {2}caddy:\r?\n([\s\S]*?)\r?\n {2}# ── Backend/)?.[1];
        const dependsBlock = caddyBlock?.match(/\r?\n {4}depends_on:\r?\n([\s\S]*)$/)?.[1];
        expect(caddyBlock).toContain('depends_on:');
        expect(dependsBlock).toContain('backend:');
        expect(dependsBlock).toContain('condition: service_healthy');
        expect(dependsBlock).toContain('frontend:');
        expect(dependsBlock).not.toContain('growth-frontend');
        // The Growth SPA service itself remains defined and routed.
        expect(compose).toContain('  growth-frontend:');
        const caddyfile = fs.readFileSync(path.resolve(__dirname, '../../../../Caddyfile'), 'utf8');
        expect(caddyfile).toContain('growth.easymod.tech');
        expect(caddyfile).toContain('reverse_proxy growth-frontend:8080');
    });

    test('backups tolerate a stopped internal Growth SPA via the deployment-record reference', () => {
        const backupWorkflow = fs.readFileSync(
            path.resolve(__dirname, '../../../../.github/workflows/backup.yml'),
            'utf8',
        );
        expect(backupWorkflow).toContain('BACKUP_GROWTH_IMAGE_SOURCE=deployment-record');
        expect(backupWorkflow).not.toContain('growth-frontend-is-not-running"');
        // The digest-pinned contract itself must stay enforced.
        expect(backupWorkflow).toContain('image-is-not-digest-pinned');
    });

    test('every privileged SSH workflow caps remote commands explicitly', () => {
        const directory = path.resolve(__dirname, '../../../../.github/workflows');
        const offenders = fs.readdirSync(directory).filter((file) => {
            const text = fs.readFileSync(path.join(directory, file), 'utf8');
            return text.includes('appleboy/ssh-action') && !text.includes('command_timeout:');
        });
        expect(offenders).toEqual([]);
    });
});

describe('protected growth importer execution', () => {
    test('is manual, main-only, operator-bound, and serialized on the production environment', () => {
        expect(growthImporterWorkflow).toContain('workflow_dispatch:');
        expect(growthImporterWorkflow).toContain(
            "if: github.ref == 'refs/heads/main' && github.actor == 'mr3826'",
        );
        expect(growthImporterWorkflow).toContain('environment: production');
        expect(growthImporterWorkflow).toContain('group: run-growth-importer');
        expect(growthImporterWorkflow).toContain('cancel-in-progress: false');
    });

    test('defaults to dry-run and requires the literal phrase before any apply', () => {
        expect(growthImporterWorkflow).toContain('default: "dry-run"');
        expect(growthImporterWorkflow).toContain('"mode=apply requires the literal authorization phrase PRODUCTION-IMPORT-APPLY."');
        // Only the apply branch passes --apply; the default branch must not.
        const applyGuard = growthImporterWorkflow.indexOf('"$IMPORT_AUTHORIZATION" != "PRODUCTION-IMPORT-APPLY"');
        const applyFlag = growthImporterWorkflow.indexOf('import-growth-prospects.js --apply');
        expect(applyGuard).toBeGreaterThan(-1);
        expect(applyFlag).toBeGreaterThan(applyGuard);
    });

    test('enforces the post-apply idempotency gate instead of trusting the first run', () => {
        expect(growthImporterWorkflow).toContain('SECOND_RUN_WOULD_CREATE=');
        expect(growthImporterWorkflow).toContain('if [ "$would_create" != "0" ]; then');
    });

    test('refuses the idempotency proof unless the verification scan demonstrably completed', () => {
        // The importer exits 1 on per-row rejections while completing the scan,
        // and appends a sentinel row on a mid-scan read failure — so row-count
        // equality alone cannot prove completeness. The gate must capture the
        // apply status through the pipe, reject source-read failures, require
        // every source row accounted for, and require the same rejected set.
        expect(growthImporterWorkflow).toContain('apply_rc=${PIPESTATUS[0]}');
        expect(growthImporterWorkflow).toContain('verify_rc=${PIPESTATUS[0]}');
        expect(growthImporterWorkflow).toContain('PROBE_READ_FAILURE');
        expect(growthImporterWorkflow).toContain('if [ "$verify_read_failure" = "true" ]; then');
        expect(growthImporterWorkflow).toContain('verification pass incomplete');
        expect(growthImporterWorkflow).toContain('if [ -z "$verify_failed" ] || [ "$verify_failed" != "$apply_failed" ]; then');
        expect(growthImporterWorkflow).toContain('VERIFY_COMPLETED_WITH_KNOWN_ROW_REJECTIONS');
        expect(growthImporterWorkflow).toContain('exit "$apply_rc"');
    });

    test('runs the canonical script in the live backend container and persists receipts on the host', () => {
        expect(growthImporterWorkflow).toContain('scripts/import-growth-prospects.js');
        expect(growthImporterWorkflow).toContain('com.docker.compose.service=backend');
        expect(growthImporterWorkflow).toContain('/root/growth-os-receipts');
        // Inputs must be validated before interpolation into remote commands.
        expect(growthImporterWorkflow).toContain('case "$IMPORT_BATCH_SIZE" in "" | *[!0-9]*) IMPORT_BATCH_SIZE=100;; esac');
        // The remote program travels inside single quotes to ssh; apostrophes
        // inside it silently terminate the quoting (observed in run 36245354832).
        const remoteProgram = growthImporterWorkflow.split('root@"$DEPLOY_HOST" ')[1] || '';
        const quotedBody = remoteProgram.slice(remoteProgram.indexOf("'") + 1, remoteProgram.lastIndexOf("'"));
        expect(quotedBody.length).toBeGreaterThan(500);
        expect((quotedBody.match(/'/g) || []).length).toBe(0);
    });
});
