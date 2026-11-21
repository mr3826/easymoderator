# Stage 2 Security Review

`GET /api/conversation/history` reaches `conversation.controller.js:getHistory` after authentication and shop membership checks. The service selects conversations by shop and customer, but the controller returned opaque `metadata`. That is a confirmed shop-scoped information disclosure in source; it is not evidence of cross-shop disclosure or of specific production data being read.

The `fix/conversation-wire-privacy-stage2` worktree preserves the history envelope and returns an empty metadata compatibility field, validates UUID and bounded pagination, projects only a string `normalized_message`, and returns a generic failure. Its controller tests use synthetic records and verify scope, projection, and error handling.

Stage 2 REST and SSE publish/frame paths expose only validated reply evidence reasons and provenance categories. They explicitly clear evidence on draft approval and for acknowledged replies that have only proposal evidence. This is a Stage 2 namespace projection, not a blanket sign-off on all other metadata, legacy/native or export contracts. Mixed API/worker versions and buffered events need explicit end-to-end checks. Do not deploy the telemetry writer with an incumbent reader that can return its internal fields.
