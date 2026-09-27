// League scoring rules: two sets, then a championship tiebreak at one set all.
// apps-script/Code.gs enforces the same rules on the server — keep them in step.
window.Scoring = (function () {
  const SET_SCORES = ['6-0', '6-1', '6-2', '6-3', '6-4', '7-5', '7-6'];

  function validSet(h, a) {
    return SET_SCORES.includes(`${Math.max(h, a)}-${Math.min(h, a)}`);
  }

  // First to 10 points, 2 clear; beyond 10 the margin must be exactly 2.
  function validTiebreak(h, a) {
    const hi = Math.max(h, a), lo = Math.min(h, a);
    return hi >= 10 && hi - lo >= 2 && (hi === 10 || hi - lo === 2);
  }

  // sets: [[home, away], [home, away], [home, away]?] -> { winner: 'home' | 'away' }
  function validateScore(sets) {
    if (!Array.isArray(sets) || sets.length < 2 || sets.length > 3) {
      throw new Error('Please enter scores for sets 1 and 2.');
    }
    sets.forEach((s) => {
      if (!Array.isArray(s) || s.length !== 2 || !s.every((n) => Number.isInteger(n) && n >= 0 && n <= 99)) {
        throw new Error('Scores must be whole numbers.');
      }
    });
    for (let i = 0; i < 2; i++) {
      if (!validSet(sets[i][0], sets[i][1])) {
        throw new Error(`Set ${i + 1} score ${sets[i][0]}-${sets[i][1]} isn't valid (e.g. 6-4, 7-5 or 7-6).`);
      }
    }
    const homeSets = sets.slice(0, 2).filter(([h, a]) => h > a).length;
    if (homeSets !== 1) {
      if (sets.length === 3) throw new Error('No championship tiebreak is played after a straight-sets win.');
      return { winner: homeSets === 2 ? 'home' : 'away' };
    }
    if (sets.length !== 3) throw new Error('At one set all, please enter the championship tiebreak score.');
    const [h, a] = sets[2];
    if (!validTiebreak(h, a)) {
      throw new Error(`Championship tiebreak ${h}-${a} isn't valid: first to 10, 2 points clear (e.g. 10-8, 12-10).`);
    }
    return { winner: h > a ? 'home' : 'away' };
  }

  // 6–4, 3–6, [10–8]
  function formatScore(sets) {
    return sets.map((s, i) => (i === 2 ? `[${s[0]}–${s[1]}]` : `${s[0]}–${s[1]}`)).join(', ');
  }

  return { validateScore, formatScore };
})();
