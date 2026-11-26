/**
 * FAQ question resolution with the mirror invariant (review round 1, A9).
 *
 * Since migration 20261126_001 EVERY new write keeps `question` ==
 * `category` (category mirrors question for pre-redesign readers). Therefore
 * a row where both are present and DIFFER can only have been written by the
 * OLD image during a rollback window — and the old image could only change
 * `category`. So the differing category is the FRESHER truth until the next
 * content save re-mirrors both columns. Shared by knowledge.service and
 * index-source.contract so the two index-text builders cannot drift.
 */
function resolveFaqQuestion(row, fallback = 'General') {
  const q = typeof (row && row.question) === 'string' ? row.question.trim() : '';
  const c = typeof (row && row.category) === 'string' ? row.category.trim() : '';
  if (q && c && q !== c) return c;
  return q || c || fallback;
}

module.exports = { resolveFaqQuestion };
