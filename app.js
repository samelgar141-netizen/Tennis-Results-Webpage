(function () {
  const cfg = window.APP_CONFIG || {};
  const api = cfg.API_URL ? window.RealApi : window.MockApi;
  const SESSION_KEY = 'tennis-session';
  const $ = (id) => document.getElementById(id);

  let teams = [];
  let session = loadSession();

  // ---------- helpers ----------
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    });
    children.flat().forEach((c) => node.append(c instanceof Node ? c : String(c)));
    return node;
  }
  const teamName = (id) => (teams.find((t) => t.teamId === id) || {}).name ||
    (session && session.teamId === id ? session.teamName : id);
  const score = (sets) => window.Scoring.formatScore(sets);
  const statusBadge = (s) => el('span', { class: 'badge badge-' + s }, s);

  function loadSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY)) || null; } catch (e) { return null; }
  }
  function saveSession(s) {
    session = s;
    try { s ? localStorage.setItem(SESSION_KEY, JSON.stringify(s)) : localStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
  }

  function showMessage(text, kind) {
    const m = $('enter-message');
    m.textContent = text;
    m.className = 'message ' + (kind || '');
    m.hidden = !text;
  }

  async function busy(button, fn) {
    button.disabled = true;
    try { return await fn(); } finally { button.disabled = false; }
  }

  // Loads the team list, retrying when it is empty (or forced) so a failed or
  // stale first load doesn't leave the opponent list blank.
  async function ensureTeams({ force } = {}) {
    if (teams.length && !force) return;
    const box = $('teams-error');
    try {
      teams = await api.listTeams();
      box.hidden = true;
    } catch (e) {
      box.hidden = false;
      $('teams-error-text').textContent = `Couldn't load the team list: ${e.message}`;
    }
  }

  // ---------- tabs ----------
  async function selectTab(name) {
    document.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    $('tab-results').hidden = name !== 'results';
    $('tab-enter').hidden = name !== 'enter';
    if (name === 'results') renderResults();
    if (name === 'enter') { await ensureTeams(); renderEnter(); }
  }

  // ---------- results tab ----------
  async function renderResults() {
    const list = $('results-list');
    await ensureTeams();
    try {
      const results = (await api.listResults())
        .filter((r) => $('show-pending').checked || r.status === 'confirmed')
        .sort((a, b) => (b.date + b.submittedAt).localeCompare(a.date + a.submittedAt));
      if (!results.length) {
        list.replaceChildren(el('p', { class: 'muted' }, 'No results yet.'));
        return;
      }
      list.replaceChildren(el('table', { class: 'results' },
        el('thead', {}, el('tr', {}, ['Date', 'Home', 'Away', 'Score', 'Winner', 'Status'].map((h) => el('th', {}, h)))),
        el('tbody', {}, results.map((r) => el('tr', { class: 'status-' + r.status },
          el('td', { 'data-label': 'Date' }, r.date),
          el('td', { 'data-label': 'Home' }, teamName(r.homeTeamId)),
          el('td', { 'data-label': 'Away' }, teamName(r.awayTeamId)),
          el('td', { 'data-label': 'Score' }, score(r.sets)),
          el('td', { 'data-label': 'Winner' }, teamName(r.winnerTeamId)),
          el('td', { 'data-label': 'Status' }, statusBadge(r.status))
        )))
      ));
    } catch (e) {
      list.replaceChildren(el('p', { class: 'message error' }, e.message));
    }
    renderDemo();
  }

  // ---------- enter tab ----------
  function renderEnter() {
    const signedIn = !!session;
    $('login-email-form').hidden = signedIn;
    $('login-code-form').hidden = true;
    $('entry-area').hidden = !signedIn;
    if (!signedIn) return;
    $('me-email').textContent = session.email;
    $('me-team').textContent = session.teamName;
    const opp = $('opponent');
    const prev = opp.value;
    opp.replaceChildren(el('option', { value: '' }, 'Select opponent…'),
      ...teams.filter((t) => t.teamId !== session.teamId).map((t) => el('option', { value: t.teamId }, t.name)));
    opp.value = prev;
    updateFormLabels();
  }

  function sides() {
    const home = document.querySelector('input[name=venue]:checked').value === 'home';
    const opp = $('opponent').value;
    return home ? { homeTeamId: session.teamId, awayTeamId: opp } : { homeTeamId: opp, awayTeamId: session.teamId };
  }

  const scoreInput = (set, side) => document.querySelector(`input[data-set="${set}"][data-side="${side}"]`);

  // Returns the sets entered so far; throws if a row is half-filled.
  function readSets() {
    const sets = [];
    for (let i = 0; i < 3; i++) {
      const [h, a] = [0, 1].map((side) => scoreInput(i, side).value);
      if (h === '' && a === '') continue;
      if (h === '' || a === '') {
        throw new Error(i === 2 ? 'Please complete both championship tiebreak scores.' : `Please complete both scores for set ${i + 1}.`);
      }
      sets.push([Number(h), Number(a)]);
    }
    return sets;
  }

  function updateFormLabels() {
    const { homeTeamId, awayTeamId } = sides();
    $('home-label').textContent = homeTeamId ? teamName(homeTeamId) : 'Home';
    $('away-label').textContent = awayTeamId ? teamName(awayTeamId) : 'Away';

    // The championship tiebreak is only played at one set all.
    const setWinner = (i) => {
      const h = scoreInput(i, 0).value, a = scoreInput(i, 1).value;
      return h === '' || a === '' ? null : Number(h) > Number(a) ? 'home' : Number(a) > Number(h) ? 'away' : null;
    };
    const w1 = setWinner(0), w2 = setWinner(1);
    const tiebreakNeeded = !!w1 && !!w2 && w1 !== w2;
    [0, 1].forEach((side) => {
      const input = scoreInput(2, side);
      input.disabled = !tiebreakNeeded;
      input.required = tiebreakNeeded;
      if (!tiebreakNeeded) input.value = '';
    });
    $('tiebreak-row').classList.toggle('inactive', !tiebreakNeeded);

    // Work out the winner live, and flag score problems once both sets are in.
    const line = $('winner-line');
    let text = 'Winner: enter the scores above';
    let error = false;
    try {
      const sets = readSets();
      if (sets.length >= 2 && (!tiebreakNeeded || sets.length === 3)) {
        const { winner } = window.Scoring.validateScore(sets);
        const id = winner === 'home' ? homeTeamId : awayTeamId;
        text = 'Winner: ' + (id ? teamName(id) : winner === 'home' ? 'Home team' : 'Away team');
      }
    } catch (e) {
      text = e.message;
      error = true;
    }
    line.textContent = text;
    line.classList.toggle('error-text', error);
  }

  // ---------- confirm view ----------
  async function renderConfirm(token) {
    $('confirm-view').hidden = false;
    $('main-view').hidden = true;
    const body = $('confirm-body');
    await ensureTeams();
    try {
      const r = await api.getConfirmation(token);
      const summary = el('dl', { class: 'summary' },
        el('dt', {}, 'Date'), el('dd', {}, r.date),
        el('dt', {}, 'Home'), el('dd', {}, teamName(r.homeTeamId)),
        el('dt', {}, 'Away'), el('dd', {}, teamName(r.awayTeamId)),
        el('dt', {}, 'Score'), el('dd', {}, score(r.sets)),
        el('dt', {}, 'Winner'), el('dd', {}, teamName(r.winnerTeamId)),
        el('dt', {}, 'Status'), el('dd', {}, statusBadge(r.status)));
      if (r.status !== 'pending') {
        body.replaceChildren(summary, el('p', {}, `This result has already been ${r.status}. Thank you.`));
        return;
      }
      const comment = el('textarea', { id: 'dispute-comment', rows: '3', placeholder: 'Required if disputing: what is wrong?' });
      const msg = el('p', { class: 'message', role: 'status', hidden: '' });
      const respond = (decision) => async (ev) => {
        await busy(ev.currentTarget, async () => {
          try {
            await api.respondToResult(token, decision, comment.value);
            renderConfirm(token);
          } catch (e) {
            msg.textContent = e.message; msg.className = 'message error'; msg.hidden = false;
          }
        });
      };
      body.replaceChildren(summary,
        el('p', {}, 'Is this result correct? Once confirmed, the league will be notified.'),
        el('label', {}, 'Comment (optional when confirming)', comment),
        el('div', { class: 'actions' },
          el('button', { type: 'button', id: 'confirm-btn', onclick: respond('confirm') }, 'Confirm result'),
          el('button', { type: 'button', id: 'dispute-btn', class: 'danger', onclick: respond('dispute') }, 'Dispute')),
        msg);
    } catch (e) {
      body.replaceChildren(el('p', { class: 'message error' }, e.message));
    }
    renderDemo();
  }

  // ---------- demo panel ----------
  function renderDemo() {
    if (!api.isMock) return;
    $('demo-panel').hidden = false;
    $('demo-captains').textContent = api.captains().map((c) => c.email).join(', ');
    const mails = api.outbox();
    $('demo-outbox').replaceChildren(mails.length
      ? el('ul', { class: 'outbox' }, mails.map((m) => el('li', {},
          el('div', { class: 'muted' }, `To: ${m.to}`),
          el('strong', {}, m.subject),
          el('pre', {}, linkify(m.body)))))
      : el('p', { class: 'muted' }, 'No emails yet.'));
  }
  function linkify(text) {
    return text.split(/(https?:\/\/\S+)/).map((part) =>
      /^https?:\/\//.test(part) ? el('a', { href: part }, part) : part);
  }

  // ---------- wiring ----------
  function wire() {
    document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));
    $('show-pending').addEventListener('change', renderResults);

    $('login-email-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      await busy(ev.submitter || ev.target.querySelector("button[type=submit]"), async () => {
        try {
          await api.requestCode($('login-email').value);
          $('code-email').textContent = $('login-email').value;
          $('login-email-form').hidden = true;
          $('login-code-form').hidden = false;
          $('login-code').value = '';
          $('login-code').focus();
          showMessage('');
          renderDemo();
        } catch (e) { showMessage(e.message, 'error'); }
      });
    });

    $('login-code-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      await busy(ev.submitter || ev.target.querySelector("button[type=submit]"), async () => {
        try {
          saveSession(await api.verifyCode($('login-email').value, $('login-code').value));
          showMessage('');
          await ensureTeams({ force: true });
          renderEnter();
        } catch (e) { showMessage(e.message, 'error'); }
      });
    });

    $('code-back').addEventListener('click', () => { showMessage(''); renderEnter(); });
    $('sign-out').addEventListener('click', () => { saveSession(null); showMessage(''); renderEnter(); });

    const form = $('result-form');
    form.addEventListener('input', updateFormLabels);
    form.addEventListener('change', updateFormLabels);
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      await busy(ev.submitter || ev.target.querySelector("button[type=submit]"), async () => {
        try {
          const payload = Object.assign(sides(), {
            date: $('match-date').value,
            sets: readSets()
          });
          if (!payload.awayTeamId || !payload.homeTeamId) throw new Error('Please select the opponent.');
          window.Scoring.validateScore(payload.sets);
          await api.submitResult(session.token, payload);
          form.reset();
          updateFormLabels();
          showMessage("Result submitted. The opposing captain has been emailed to confirm it. It will appear once they've confirmed.", 'success');
          renderDemo();
        } catch (e) {
          if (/sign in again/i.test(e.message)) { saveSession(null); renderEnter(); }
          showMessage(e.message, 'error');
        }
      });
    });

    $('teams-retry').addEventListener('click', async () => {
      await ensureTeams({ force: true });
      const confirmToken = new URLSearchParams(location.search).get('confirm');
      if (confirmToken) renderConfirm(confirmToken);
      else { renderEnter(); renderResults(); }
    });
    $('demo-reset').addEventListener('click', () => { api.reset(); saveSession(null); location.href = location.pathname; });
  }

  async function init() {
    if (cfg.LEAGUE_NAME) {
      $('league-name').textContent = cfg.LEAGUE_NAME + ' Results';
      document.title = cfg.LEAGUE_NAME + ' Results';
    }
    $('demo-badge').hidden = !api.isMock;
    wire();
    await ensureTeams();

    const confirmToken = new URLSearchParams(location.search).get('confirm');
    if (confirmToken) return renderConfirm(confirmToken);
    renderEnter();
    selectTab('results');
  }

  init();
})();
