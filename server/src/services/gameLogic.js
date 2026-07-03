/**
 * Computes Levenshtein distance between two strings.
 * Used for lenient answer matching (1 character typo tolerance).
 */
function levenshteinDistance(a, b) {
  const m = a.length;
  const n = b.length;

  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  return dp[m][n];
}

/**
 * Checks whether a player's answer is correct.
 *
 * @param {object} question - The question object from the DB
 * @param {string} playerAnswer - The answer submitted by the player
 * @returns {boolean}
 */
function checkAnswer(question, playerAnswer) {
  const { format, correct_answer, case_sensitive, spelling_tolerance, options } = question;

  if (!playerAnswer || typeof playerAnswer !== 'string') return false;

  if (format === 'multiple_choice') {
    // For MC, compare option keys/values case-insensitively
    const normalizedPlayer = playerAnswer.trim().toLowerCase();
    const normalizedCorrect = correct_answer.trim().toLowerCase();
    return normalizedPlayer === normalizedCorrect;
  }

  if (format === 'type_answer') {
    let submitted = playerAnswer.trim();
    let expected = correct_answer.trim();

    if (!case_sensitive) {
      submitted = submitted.toLowerCase();
      expected = expected.toLowerCase();
    }

    if (spelling_tolerance === 'lenient') {
      // Allow up to 1 character difference (typo)
      return levenshteinDistance(submitted, expected) <= 1;
    }

    // Default: strict exact match
    return submitted === expected;
  }

  return false;
}

/**
 * Masks a phone number, showing only the last 4 digits.
 * e.g. "08012345678" → "******5678"
 */
function maskPhone(phone) {
  if (!phone || phone.length < 4) return '****';
  return '*'.repeat(phone.length - 4) + phone.slice(-4);
}

/**
 * Strips the correct_answer field from a question object
 * before sending it to the player.
 */
function sanitizeQuestion(question) {
  const { correct_answer, ...safe } = question;
  return safe;
}

module.exports = { checkAnswer, maskPhone, sanitizeQuestion, levenshteinDistance };
