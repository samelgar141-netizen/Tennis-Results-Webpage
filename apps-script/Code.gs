/**
 * Tennis League Results — Google Apps Script backend (MVP).
 *
 * The Google Sheet this script is bound to acts as the database:
 *   Teams(teamId, name)
 *   Captains(email, teamId)
 *   Results(resultId, submittedAt, date, homeTeamId, awayTeamId, sets, winnerTeamId,
 *           submittedBy, status, confirmToken, respondedBy, respondedAt, comment)
 *   Config(key, value)            keys: leagueEmail, siteUrl, leagueName
 *
 * The frontend talks to this script only through a JSON POST API:
 *   { action: "<name>", ...params }  ->  { ok: true, data } | { ok: false, error }
 * Keeping to this contract means the backend can later be replaced (Supabase,
 * Firebase, ...) without touching the UI.
 *
 * Deploy: Deploy > New deployment > Web app, Execute as: Me, Who has access: Anyone.
 */

var CODE_TTL_SECONDS = 10 * 60;          // login code lifetime
var CODE_MAX_ATTEMPTS = 5;
var CODE_RESEND_SECONDS = 60;            // throttle code emails per address
var SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
var MAX_GAMES_PER_SET = 20;              // allows match tiebreaks such as 10-8

var SCHEMA = {
  Teams: ['teamId', 'name'],
  Captains: ['email', 'teamId'],
  Results: ['resultId', 'submittedAt', 'date', 'homeTeamId', 'awayTeamId', 'sets', 'winnerTeamId',
            'submittedBy', 'status', 'confirmToken', 'respondedBy', 'respondedAt', 'comment'],
  Config: ['key', 'value']
};

var STATUS = { PENDING: 'pending', CONFIRMED: 'confirmed', DISPUTED: 'disputed' };

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

function doGet() {
  return json_({ ok: true, data: { service: 'tennis-results', status: 'running' } });
}

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var handler = ACTIONS[body.action];
    if (!handler) throw new UserError('Unknown action');
    return json_({ ok: true, data: handler(body) });
  } catch (err) {
    if (err instanceof UserError) return json_({ ok: false, error: err.message });
    console.error(err && err.stack || err);
    return json_({ ok: false, error: 'Server error, please try again.' });
  }
}

var ACTIONS = {
  listTeams: listTeams,
  listResults: listResults,
  requestCode: requestCode,
  verifyCode: verifyCode,
  submitResult: submitResult,
  getConfirmation: getConfirmation,
  respondToResult: respondToResult
};

/** Run once from the Apps Script editor to create the tabs and a signing secret. */
function setup() {
  var ss = SpreadsheetApp.getActive();
  Object.keys(SCHEMA).forEach(function (name) {
    var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(SCHEMA[name]);
      sheet.setFrozenRows(1);
    }
  });
  // Store results as plain text so Sheets doesn't turn "6-4" or dates into Date values.
  ss.getSheetByName('Results').getRange('A:Z').setNumberFormat('@');
  var config = ss.getSheetByName('Config');
  if (config.getLastRow() === 1) {
    config.appendRow(['leagueEmail', 'league@example.com']);
    config.appendRow(['siteUrl', 'https://YOUR-USERNAME.github.io/Tennis-Results-Webpage/']);
    config.appendRow(['leagueName', 'Tennis League']);
  }
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('SESSION_SECRET')) {
    props.setProperty('SESSION_SECRET', Utilities.getUuid() + Utilities.getUuid());
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function listTeams() {
  return readRows_('Teams').map(function (t) {
    return { teamId: String(t.teamId), name: String(t.name) };
  });
}

function listResults() {
  return readRows_('Results').map(publicResult_);
}

function requestCode(p) {
  var email = normEmail_(p.email);
  var captain = findCaptain_(email);
  if (!captain) throw new UserError('That email is not registered as a team captain.');

  var cache = CacheService.getScriptCache();
  if (cache.get('throttle:' + email)) {
    throw new UserError('A code was sent recently. Please wait a minute and check your inbox.');
  }
  var code = randomCode_();
  cache.put('code:' + email, JSON.stringify({ code: code, attempts: 0 }), CODE_TTL_SECONDS);
  cache.put('throttle:' + email, '1', CODE_RESEND_SECONDS);

  sendMail_(email, 'Your sign-in code',
    'Your sign-in code for ' + config_('leagueName', 'the league results site') + ' is:\n\n' +
    code + '\n\nIt expires in 10 minutes. If you did not request this, you can ignore this email.');
  return { sent: true };
}

function verifyCode(p) {
  var email = normEmail_(p.email);
  var cache = CacheService.getScriptCache();
  var raw = cache.get('code:' + email);
  if (!raw) throw new UserError('Code expired. Please request a new one.');
  var entry = JSON.parse(raw);
  if (String(p.code || '').trim() !== entry.code) {
    entry.attempts++;
    if (entry.attempts >= CODE_MAX_ATTEMPTS) cache.remove('code:' + email);
    else cache.put('code:' + email, JSON.stringify(entry), CODE_TTL_SECONDS);
    throw new UserError('Incorrect code.');
  }
  cache.remove('code:' + email);
  var captain = findCaptain_(email);
  if (!captain) throw new UserError('That email is no longer registered as a captain.');
  return sessionInfo_(email, captain.teamId, issueSession_(email));
}

function submitResult(p) {
  var email = requireSession_(p.token);
  var captain = findCaptain_(email);
  if (!captain) throw new UserError('You are no longer registered as a captain.');

  var teams = teamMap_();
  var home = String(p.homeTeamId || ''), away = String(p.awayTeamId || '');
  var winner = String(p.winnerTeamId || '');
  if (!teams[home] || !teams[away]) throw new UserError('Unknown team.');
  if (home === away) throw new UserError('Home and away teams must be different.');
  if (captain.teamId !== home && captain.teamId !== away) {
    throw new UserError('You can only enter results for matches your team played.');
  }
  if (winner !== home && winner !== away) throw new UserError('Please select the winner.');
  var date = validateDate_(p.date);
  var sets = validateSets_(p.sets);

  var opponentId = captain.teamId === home ? away : home;
  var opponentEmails = captainsForTeam_(opponentId);
  if (!opponentEmails.length) {
    throw new UserError('The opposing team has no registered captain. Please contact the league.');
  }

  var result = {
    resultId: Utilities.getUuid(),
    submittedAt: new Date().toISOString(),
    date: date,
    homeTeamId: home,
    awayTeamId: away,
    sets: formatSets_(sets),
    winnerTeamId: winner,
    submittedBy: email,
    status: STATUS.PENDING,
    confirmToken: Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''),
    respondedBy: '',
    respondedAt: '',
    comment: ''
  };

  withLock_(function () { appendRow_('Results', result); });

  var link = siteUrl_() + '?confirm=' + result.confirmToken;
  var summary = describeResult_(result, teams);
  opponentEmails.forEach(function (to) {
    sendMail_(to, 'Please confirm match result: ' + teams[home] + ' v ' + teams[away],
      teams[captain.teamId] + ' (' + email + ') has entered this result:\n\n' + summary +
      '\n\nPlease confirm or dispute it here:\n' + link +
      '\n\nThe result is not final until you respond.');
  });
  return { resultId: result.resultId };
}

function getConfirmation(p) {
  var found = findByToken_(p.confirmToken);
  if (!found) throw new UserError('This confirmation link is not valid.');
  return publicResult_(found.row);
}

function respondToResult(p) {
  var decision = p.decision;
  if (decision !== 'confirm' && decision !== 'dispute') throw new UserError('Invalid decision.');
  var comment = String(p.comment || '').slice(0, 1000);
  if (decision === 'dispute' && !comment.trim()) {
    throw new UserError('Please explain what is wrong with the result.');
  }

  var updated = withLock_(function () {
    var found = findByToken_(p.confirmToken);
    if (!found) throw new UserError('This confirmation link is not valid.');
    if (found.row.status !== STATUS.PENDING) {
      throw new UserError('This result has already been ' + found.row.status + '.');
    }
    var row = found.row;
    row.status = decision === 'confirm' ? STATUS.CONFIRMED : STATUS.DISPUTED;
    row.respondedBy = opponentLabel_(row);
    row.respondedAt = new Date().toISOString();
    row.comment = comment;
    writeRow_('Results', found.index, row);
    return row;
  });

  var teams = teamMap_();
  var summary = describeResult_(updated, teams);
  var subject = 'Result ' + updated.status + ': ' + teams[updated.homeTeamId] + ' v ' + teams[updated.awayTeamId];
  var body = 'The following result has been ' + updated.status.toUpperCase() + ' by ' + updated.respondedBy + ':\n\n' +
    summary + (comment ? '\n\nComment: ' + comment : '') +
    '\n\nEntered by: ' + updated.submittedBy;
  var leagueEmail = config_('leagueEmail', '');
  if (leagueEmail) sendMail_(leagueEmail, subject, body);
  sendMail_(updated.submittedBy, subject, body);
  return publicResult_(updated);
}

// ---------------------------------------------------------------------------
// Sessions (stateless signed tokens, so nothing needs cleaning up)
// ---------------------------------------------------------------------------

function issueSession_(email) {
  var payload = b64_(JSON.stringify({ email: email, exp: Date.now() + SESSION_TTL_MS }));
  return payload + '.' + sign_(payload);
}

function requireSession_(token) {
  var parts = String(token || '').split('.');
  if (parts.length !== 2 || sign_(parts[0]) !== parts[1]) {
    throw new UserError('Please sign in again.');
  }
  var data = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString());
  if (!data.exp || data.exp < Date.now()) throw new UserError('Your session has expired. Please sign in again.');
  return data.email;
}

function sign_(payload) {
  var secret = PropertiesService.getScriptProperties().getProperty('SESSION_SECRET');
  if (!secret) throw new Error('Run setup() first to create SESSION_SECRET.');
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(payload, secret)).replace(/=+$/, '');
}

function b64_(s) {
  return Utilities.base64EncodeWebSafe(s, Utilities.Charset.UTF_8).replace(/=+$/, '');
}

function sessionInfo_(email, teamId, token) {
  return { token: token, email: email, teamId: teamId, teamName: teamMap_()[teamId] || teamId };
}

// ---------------------------------------------------------------------------
// Validation and formatting
// ---------------------------------------------------------------------------

function validateDate_(d) {
  var s = String(d || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(new Date(s).getTime())) {
    throw new UserError('Please enter a valid match date.');
  }
  return s;
}

/** sets: [[homeGames, awayGames], ...] — 1 to 5 sets, no tied sets. */
function validateSets_(sets) {
  if (!Array.isArray(sets) || sets.length < 1 || sets.length > 5) {
    throw new UserError('Please enter the set scores.');
  }
  return sets.map(function (s) {
    if (!Array.isArray(s) || s.length !== 2) throw new UserError('Invalid set score.');
    var h = Number(s[0]), a = Number(s[1]);
    [h, a].forEach(function (n) {
      if (!Number.isInteger(n) || n < 0 || n > MAX_GAMES_PER_SET) throw new UserError('Invalid set score.');
    });
    if (h === a) throw new UserError('A set cannot be tied.');
    return [h, a];
  });
}

function formatSets_(sets) {
  return sets.map(function (s) { return s[0] + '-' + s[1]; }).join(', ');
}

function parseSets_(str) {
  return String(str || '').split(',').filter(function (x) { return x.trim(); }).map(function (x) {
    var p = x.trim().split('-');
    return [Number(p[0]), Number(p[1])];
  });
}

function describeResult_(r, teams) {
  return 'Date: ' + r.date + '\n' +
    'Home: ' + teams[r.homeTeamId] + '\n' +
    'Away: ' + teams[r.awayTeamId] + '\n' +
    'Score (home first): ' + r.sets + '\n' +
    'Winner: ' + teams[r.winnerTeamId];
}

function publicResult_(r) {
  return {
    resultId: String(r.resultId),
    submittedAt: r.submittedAt instanceof Date ? r.submittedAt.toISOString() : String(r.submittedAt),
    date: normDate_(r.date),
    homeTeamId: String(r.homeTeamId),
    awayTeamId: String(r.awayTeamId),
    sets: parseSets_(r.sets),
    winnerTeamId: String(r.winnerTeamId),
    status: String(r.status),
    comment: String(r.comment || '')
  };
}

function opponentLabel_(row) {
  var submitter = findCaptain_(row.submittedBy);
  var teams = teamMap_();
  var opponentId = submitter && submitter.teamId === String(row.homeTeamId) ? row.awayTeamId : row.homeTeamId;
  return (teams[opponentId] || 'opponent') + ' captain';
}

// ---------------------------------------------------------------------------
// Sheet helpers (column access is by header name, so columns can be reordered)
// ---------------------------------------------------------------------------

function sheet_(name) {
  var s = SpreadsheetApp.getActive().getSheetByName(name);
  if (!s) throw new Error('Missing sheet "' + name + '". Run setup().');
  return s;
}

function readRows_(name) {
  var values = sheet_(name).getDataRange().getValues();
  var headers = values.shift() || [];
  return values.filter(function (r) { return r.join('') !== ''; }).map(function (r) {
    var o = {};
    headers.forEach(function (h, i) { o[h] = r[i]; });
    return o;
  });
}

function appendRow_(name, obj) {
  var s = sheet_(name);
  var headers = s.getRange(1, 1, 1, s.getLastColumn()).getValues()[0];
  s.appendRow(headers.map(function (h) { return obj[h] === undefined ? '' : obj[h]; }));
}

/** index is the 0-based data row index as returned by readRows_ ordering. */
function writeRow_(name, index, obj) {
  var s = sheet_(name);
  var headers = s.getRange(1, 1, 1, s.getLastColumn()).getValues()[0];
  s.getRange(index + 2, 1, 1, headers.length)
    .setValues([headers.map(function (h) { return obj[h] === undefined ? '' : obj[h]; })]);
}

function findByToken_(token) {
  token = String(token || '');
  if (!token) return null;
  var s = sheet_('Results');
  var values = s.getDataRange().getValues();
  var headers = values.shift();
  var col = headers.indexOf('confirmToken');
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][col]) === token) {
      var o = {};
      headers.forEach(function (h, j) { o[h] = values[i][j]; });
      return { index: i, row: o };
    }
  }
  return null;
}

function findCaptain_(email) {
  email = normEmail_(email);
  var hit = readRows_('Captains').filter(function (c) { return normEmail_(c.email) === email; })[0];
  return hit ? { email: email, teamId: String(hit.teamId) } : null;
}

function captainsForTeam_(teamId) {
  return readRows_('Captains')
    .filter(function (c) { return String(c.teamId) === String(teamId); })
    .map(function (c) { return normEmail_(c.email); });
}

function teamMap_() {
  var m = {};
  listTeams().forEach(function (t) { m[t.teamId] = t.name; });
  return m;
}

function config_(key, fallback) {
  var hit = readRows_('Config').filter(function (r) { return r.key === key; })[0];
  return hit && hit.value !== '' ? String(hit.value) : fallback;
}

function siteUrl_() {
  var url = config_('siteUrl', '');
  if (!url) throw new Error('Set siteUrl in the Config sheet.');
  return url.replace(/[?#].*$/, '');
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

function UserError(message) { this.message = message; }
UserError.prototype = Object.create(Error.prototype);

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function sendMail_(to, subject, body) {
  MailApp.sendEmail({ to: to, subject: '[' + config_('leagueName', 'League') + '] ' + subject, body: body });
}

function randomCode_() {
  var n = parseInt(Utilities.getUuid().replace(/-/g, '').slice(0, 8), 16) % 1000000;
  return ('000000' + n).slice(-6);
}

function normEmail_(e) {
  return String(e || '').trim().toLowerCase();
}

/** Sheets may turn "2026-09-27" into a Date object; normalise back to YYYY-MM-DD. */
function normDate_(d) {
  if (d instanceof Date) return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return String(d);
}
