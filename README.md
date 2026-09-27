# Tennis-Results-Webpage

A simple site for a tennis league:

- **Results tab (public):** anyone can view confirmed match results.
- **Enter result tab (captains only):** a captain signs in with a one-time code emailed to them and submits a result.
- **Opponent confirmation:** the opposing team's captain is emailed a link to **confirm** or **dispute** the result. It only counts once they confirm.
- **League notification:** when a result is confirmed or disputed, the league email address (and the submitting captain) is notified.

## Try it now (demo mode)

With no backend configured, the site runs on a fake in-browser backend. The emails it "sends" appear in a *Demo outbox* on the page.

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

Sign in as `captain@riverside.test`, take the code from the outbox, submit a result against Oakfield, then click the confirm link in the outbox email to `captain@oakfield.test`.

## How it works

```
Browser (GitHub Pages: index.html, app.js)
        │  api.js — one small JSON API
        ▼
Google Apps Script web app (apps-script/Code.gs)
        │
        ├── Google Sheet: Teams, Captains, Results, Config
        └── Gmail (MailApp): sign-in codes, confirmation requests, league notifications
```

- **Who can enter results:** only emails listed in the `Captains` sheet. Every rule is checked on the server, not just in the page.
- **Confirmation:** each result gets a secret single-use link, which is emailed only to the opposing team's captain(s).
- **Result status:** `pending` → `confirmed` or `disputed`. Only confirmed results show by default.

## Setting up the real version (about 20 minutes)

1. **Create the Google Sheet.** Use the Google account the emails should come from. Create a new Google Sheet, then choose **Extensions → Apps Script**.
2. **Add the code.** Delete the sample code and paste in the contents of `apps-script/Code.gs`. Save.
3. **Run setup.** Pick `setup` in the function dropdown and click **Run**. Approve the permissions (Sheets and send email). This creates the tabs `Teams`, `Captains`, `Results` and `Config`.

   Google will show **"Google hasn't verified this app"**. This is expected for any personal script, and the "developer" it names is you. Click **Advanced → Go to *(project name)* (unsafe) → Allow**. You only do this once. Captains and viewers never see this screen.
4. **Fill in the sheet:**
   - `Teams`: one row per team, e.g. `riverside | Riverside LTC`. Choose short IDs and don't change them later.
   - `Captains`: one row per captain email, e.g. `jo@example.com | riverside`. A team can have more than one (e.g. a vice-captain).
   - `Config`: set `leagueEmail`, `leagueName` and `siteUrl`. The site URL is the GitHub Pages URL from step 6.
5. **Deploy as a web app.** In Apps Script choose **Deploy → New deployment → Web app**, with *Execute as:* **Me** and *Who has access:* **Anyone**. Copy the web app URL.
6. **Publish the site.** Put that URL into `API_URL` in `config.js` (and set `LEAGUE_NAME`), then commit. In GitHub go to **Settings → Pages**, choose *Deploy from a branch*, and select `main` / root. Copy the Pages URL into `siteUrl` in the `Config` sheet.
7. **Test it.** Use two captain emails you control: submit as one, confirm from the email sent to the other, and check that the league inbox gets the notification.

> **Whenever `Code.gs` changes:** paste the new version into Apps Script, save, then choose **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**. The URL stays the same, so `config.js` doesn't need to change.

The league administers everything from the Sheet: add or remove captains, fix scores, or delete a duplicate row.

## Limits of this MVP

- Gmail accounts can send about 100 emails a day through Apps Script, which is plenty for a typical league.
- Captains choose the opponent themselves. There's no fixture list yet, so duplicates are possible (delete them in the Sheet).
- The match format is fixed: two sets (6-0 to 6-4, 7-5 or 7-6), then a **championship tiebreak** at one set all (first to 10 points, 2 clear, e.g. 10-8 or 12-10). Scores are entered home team first. The winner is worked out from the score, and the rules are checked in both `scoring.js` and `Code.gs`. Retirements and walkovers aren't supported yet.
- There are no automatic reminders or auto-confirm yet.

## Upgrading later

The UI only talks to the backend through the functions in `api.js`: `listTeams`, `listResults`, `requestCode`, `verifyCode`, `submitResult`, `getConfirmation` and `respondToResult`. `api.mock.js` implements the same interface. To move to a different backend (e.g. Supabase or Firebase, for a custom sending domain or more users), write a new implementation of those functions and export each Sheet tab to CSV. The columns are designed to map straight onto database tables.

Natural next steps: a fixture list (so the opponent is known automatically), league tables, reminder emails for unconfirmed results, and team matches with several rubbers.
