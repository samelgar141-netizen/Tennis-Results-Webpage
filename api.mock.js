// In-browser demo backend. Same interface as api.js, but data lives in
// localStorage and "emails" go to a demo outbox shown on the page.
// It mirrors the rules enforced by apps-script/Code.gs.
window.MockApi = (function () {
  const KEY = 'tennis-demo-db';
  const SEED = {
    teams: [
      { teamId: 'riverside', name: 'Riverside LTC' },
      { teamId: 'oakfield', name: 'Oakfield TC' },
      { teamId: 'hillview', name: 'Hillview Tennis' },
      { teamId: 'parkside', name: 'Parkside Racquets' }
    ],
    captains: [
      { email: 'captain@riverside.test', teamId: 'riverside' },
      { email: 'captain@oakfield.test', teamId: 'oakfield' },
      { email: 'captain@hillview.test', teamId: 'hillview' },
      { email: 'captain@parkside.test', teamId: 'parkside' }
    ],
    results: [],
    codes: {},
    outbox: [],
    leagueEmail: 'league@example.test'
  };

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* fall through to seed */ }
    return JSON.parse(JSON.stringify(SEED));
  }
  function save(db) {
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { /* demo only */ }
  }
  function fail(msg) { throw new Error(msg); }
  function norm(e) { return String(e || '').trim().toLowerCase(); }
  function delay() { return new Promise((r) => setTimeout(r, 150)); }
  function uid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
  function teamName(db, id) { return (db.teams.find((t) => t.teamId === id) || {}).name || id; }
  function captain(db, email) { return db.captains.find((c) => norm(c.email) === norm(email)); }
  function mail(db, to, subject, body) {
    db.outbox.unshift({ to, subject, body, at: new Date().toISOString() });
  }
  function siteUrl() { return location.href.replace(/[?#].*$/, ''); }
  function publicResult(r) {
    const { confirmToken, submittedBy, respondedBy, ...rest } = r;
    return rest;
  }
  function describe(db, r) {
    return `Date: ${r.date}\nHome: ${teamName(db, r.homeTeamId)}\nAway: ${teamName(db, r.awayTeamId)}\n` +
      `Score (home first): ${r.sets.map((s) => s.join('-')).join(', ')}` +
      (r.sets.length === 3 ? ' (third score is the championship tiebreak)' : '') + `\nWinner: ${teamName(db, r.winnerTeamId)}`;
  }
  function session(token) {
    try {
      const s = JSON.parse(atob(token));
      if (s.exp > Date.now()) return s.email;
    } catch (e) { /* invalid */ }
    return fail('Please sign in again.');
  }

  return {
    isMock: true,

    async listTeams() { await delay(); return load().teams; },

    async listResults() { await delay(); return load().results.map(publicResult); },

    async requestCode(email) {
      await delay();
      const db = load();
      if (!captain(db, email)) fail('That email is not registered as a team captain.');
      const code = String(Math.floor(100000 + Math.random() * 900000));
      db.codes[norm(email)] = { code, exp: Date.now() + 10 * 60 * 1000 };
      mail(db, norm(email), 'Your sign-in code', `Your sign-in code is: ${code}`);
      save(db);
      return { sent: true };
    },

    async verifyCode(email, code) {
      await delay();
      const db = load();
      const entry = db.codes[norm(email)];
      if (!entry || entry.exp < Date.now()) fail('Code expired. Please request a new one.');
      if (String(code).trim() !== entry.code) fail('Incorrect code.');
      delete db.codes[norm(email)];
      save(db);
      const c = captain(db, email);
      const token = btoa(JSON.stringify({ email: norm(email), exp: Date.now() + 7 * 864e5 }));
      return { token, email: norm(email), teamId: c.teamId, teamName: teamName(db, c.teamId) };
    },

    async submitResult(token, p) {
      await delay();
      const db = load();
      const email = session(token);
      const c = captain(db, email) || fail('You are no longer registered as a captain.');
      const ids = db.teams.map((t) => t.teamId);
      if (!ids.includes(p.homeTeamId) || !ids.includes(p.awayTeamId)) fail('Unknown team.');
      if (p.homeTeamId === p.awayTeamId) fail('Home and away teams must be different.');
      if (c.teamId !== p.homeTeamId && c.teamId !== p.awayTeamId) {
        fail('You can only enter results for matches your team played.');
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date || '')) fail('Please enter a valid match date.');
      // The winner is always worked out from the score, never taken from the client.
      const { winner } = window.Scoring.validateScore(p.sets);
      const winnerTeamId = winner === 'home' ? p.homeTeamId : p.awayTeamId;
      const opponent = c.teamId === p.homeTeamId ? p.awayTeamId : p.homeTeamId;
      const oppEmails = db.captains.filter((x) => x.teamId === opponent).map((x) => x.email);
      if (!oppEmails.length) fail('The opposing team has no registered captain. Please contact the league.');

      const r = {
        resultId: uid(), submittedAt: new Date().toISOString(), date: p.date,
        homeTeamId: p.homeTeamId, awayTeamId: p.awayTeamId, sets: p.sets, winnerTeamId,
        submittedBy: email, status: 'pending', confirmToken: uid() + uid(), respondedBy: '', comment: ''
      };
      db.results.push(r);
      const link = `${siteUrl()}?confirm=${r.confirmToken}`;
      oppEmails.forEach((to) => mail(db, to,
        `Please confirm match result: ${teamName(db, r.homeTeamId)} v ${teamName(db, r.awayTeamId)}`,
        `${teamName(db, c.teamId)} (${email}) has entered this result:\n\n${describe(db, r)}\n\n` +
        `Please confirm or dispute it here:\n${link}`));
      save(db);
      return { resultId: r.resultId };
    },

    async getConfirmation(confirmToken) {
      await delay();
      const r = load().results.find((x) => x.confirmToken === confirmToken);
      if (!r) fail('This confirmation link is not valid.');
      return publicResult(r);
    },

    async respondToResult(confirmToken, decision, comment) {
      await delay();
      const db = load();
      const r = db.results.find((x) => x.confirmToken === confirmToken);
      if (!r) fail('This confirmation link is not valid.');
      if (decision !== 'confirm' && decision !== 'dispute') fail('Invalid decision.');
      if (decision === 'dispute' && !String(comment || '').trim()) fail('Please explain what is wrong with the result.');
      if (r.status !== 'pending') fail(`This result has already been ${r.status}.`);
      r.status = decision === 'confirm' ? 'confirmed' : 'disputed';
      r.comment = String(comment || '');
      const subject = `Result ${r.status}: ${teamName(db, r.homeTeamId)} v ${teamName(db, r.awayTeamId)}`;
      const body = `The following result has been ${r.status.toUpperCase()}:\n\n${describe(db, r)}` +
        (r.comment ? `\n\nComment: ${r.comment}` : '') + `\n\nEntered by: ${r.submittedBy}`;
      mail(db, db.leagueEmail, subject, body);
      mail(db, r.submittedBy, subject, body);
      save(db);
      return publicResult(r);
    },

    // Demo-only helpers
    outbox() { return load().outbox; },
    captains() { return load().captains; },
    reset() { try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ } }
  };
})();
