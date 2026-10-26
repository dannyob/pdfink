# Google Drive (proof of concept)

The browser-only build can open a PDF from Google Drive and save it back to the same file. Everything happens in the browser: the PDF goes from Drive to the tab and back, and no pdfink server ever sees it. The code is in `src/gdrive.ts`.

This is off unless the build is given Google settings. Without them the Drive buttons don't appear and nothing loads from Google.

## How it works

- **Drive…** signs in with Google (a popup the first time), opens the Google Picker filtered to PDFs, and loads the chosen file. Save, Ctrl+S and autosave then write back to that file.
- **Save to Drive…** puts the current document in Drive as a new file (in My Drive) and switches Save to it.
- Autosave runs a minute after the last change and when the tab is hidden. That's slower than server mode's 10 seconds because every save uploads the whole PDF, and Drive keeps each upload as a revision that counts against the user's storage until Drive prunes it.
- Before each save the app checks the file's Drive `version`. If it changed since it was opened (edited on another device, say) the app asks before overwriting. If the file was deleted or trashed it offers to save a new copy.

The app asks for the `drive.file` scope only. That lets it see files the user picked in the Picker or that pdfink created, and nothing else in their Drive. Google classes it as non-sensitive, so the app doesn't need the yearly security assessment that full-Drive scopes require.

## Setting up a Google Cloud project

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project (or pick one). Note its **project number** on the dashboard.
2. APIs & Services, Library: enable the **Google Drive API** and the **Google Picker API**.
3. Google Auth Platform (OAuth consent screen): user type External, app name, support email. Under Data access add the scope `https://www.googleapis.com/auth/drive.file`. While the app is in Testing, add your own Google account as a test user.
4. Clients: create an OAuth client of type **Web application**. Under Authorized JavaScript origins add every origin the app is served from, for example `http://localhost:5173` for development and `https://pdfink.example.com` for the published build. No redirect URIs are needed.
5. Credentials: create an **API key**. Restrict it to the Google Picker API, and to HTTP referrers on the same origins.

## Building with Drive

Vite reads the settings at build time from the environment or from `.env.local` (gitignored):

```sh
VITE_GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
VITE_GOOGLE_API_KEY=AIza...
VITE_GOOGLE_APP_ID=1234567890   # the project number
```

Then `npm run dev` and open `http://localhost:5173/?storage=local`, or `npm run deploy` for the published browser-only build. These values end up in the JavaScript bundle; that's expected for a browser OAuth client and API key, which is why the key is restricted to the Picker and your origins.

Drive is only offered in browser-only (local) mode. Server mode keeps using its notebooks folder.

## Known gaps

- Google's sign-in popup is only allowed shortly after a click. When the hour-long access token runs out, an autosave can't renew it, so the status line says to Save again; that click signs in and saves.
- A file opened from a shared drive works for Save, but Save to Drive always creates the new file in My Drive.
- Tests use a fake Drive (`tests/e2e/drive.spec.ts`) and a stub fetch for the REST calls (`tests/unit/gdrive.test.ts`). The sign-in and Picker code has not yet been run against a real Google project.
- Only Google so far. Dropbox and OneDrive would be further backends behind the same `DriveBackend` interface.
