// Backend client for the Google Apps Script API.
// Every backend (this one, the mock, or a future Supabase/Firebase one) exposes
// the same async functions, so the UI in app.js never needs to change.
window.RealApi = (function () {
  async function call(action, params) {
    // text/plain avoids a CORS preflight, which Apps Script cannot answer.
    const res = await fetch(window.APP_CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ action }, params))
    });
    if (!res.ok) throw new Error('Could not reach the results server.');
    const body = await res.json();
    if (!body.ok) throw new Error(body.error || 'Something went wrong.');
    return body.data;
  }

  return {
    listTeams: () => call('listTeams'),
    listResults: () => call('listResults'),
    requestCode: (email) => call('requestCode', { email }),
    verifyCode: (email, code) => call('verifyCode', { email, code }),
    submitResult: (token, result) => call('submitResult', Object.assign({ token }, result)),
    getConfirmation: (confirmToken) => call('getConfirmation', { confirmToken }),
    respondToResult: (confirmToken, decision, comment) =>
      call('respondToResult', { confirmToken, decision, comment })
  };
})();
