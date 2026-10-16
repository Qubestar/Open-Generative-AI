# Google Sheets connection in Story and Channel Tracker

Story can use a Google Sheets row as the starting brief for a video. Vidmyo only lists spreadsheets, reads worksheet metadata and reads cell values. It does not update the source spreadsheet.

Channel Workspace can also create and synchronize its own Google tracker. That tracker has a visible `Videos` worksheet with the exact 21 Vidmyo tracker columns and a hidden `_Vidmyo` worksheet. The hidden worksheet holds each stable `videoId`, its visible row, a revision, and a row fingerprint. It lets Vidmyo detect an edit made in Sheets before it writes, so a sync returns a conflict instead of silently overwriting the edit.

## For users

There are two access paths.

### Connect Google for private spreadsheets

When the Story page shows **Connect Google**:

1. Click **Connect Google**.
2. Finish the Google sign-in in the browser.
3. Approve the Drive metadata and Google Sheets access shown by Google.
4. Return to Vidmyo, choose a spreadsheet and worksheet, then load a row.

Vidmyo encrypts the OAuth client configuration and account tokens with Electron `safeStorage`, backed by the operating system's credential protection, before writing them under the app's private user-data directory. Project manifests contain only selected spreadsheet and row metadata; credentials and tokens never enter the renderer or a project file.

If the app shows **Configure Google**, choose the Desktop OAuth client JSON supplied by your organization or release owner. Vidmyo validates and imports it through the native file picker; it never asks you to paste a token. A public release can include its release-owned client configuration separately. If neither is available, use a Viewer link.

The app reports a specific connection state so the interface can show the correct next step:

| Status | Meaning | Next step |
| --- | --- | --- |
| `connected` | A read-only Google account is available | Browse private spreadsheets |
| `connect-ready` | The helper and OAuth client are present, but no valid account session is available | Click **Connect Google** |
| `setup-required` / `oauth-client-missing` | Native Google Connect is available, but no Desktop OAuth client is configured | Click **Configure Google** and import an authorized Desktop client JSON, or use a Viewer link |
| `setup-required` / `gws-missing` | Neither native configuration nor the legacy `gws` helper is available | Configure native Google access or use a Viewer link |
| `unavailable` | The connection check failed for another reason | Retry the check; the Viewer-link path remains available |

These are additive fields returned by `googleAccount()`: `status`, `reason`, `nextAction`, `readOnly`, and `sharedLinkAvailable`. Existing `connected`, `email`, `canConnect`, `canSetup`, `canDisconnect`, and `hint` fields remain available. `readOnly` describes Story operations. Story remains read-only even though native Google Connect now requests the Sheets scope needed for an explicit Channel Tracker create or sync action.

### Use a Viewer shared link

This path needs no Google sign-in or connection helper:

1. In Google Sheets, select **Share**.
2. Under **General access**, choose **Anyone with the link** and **Viewer**.
3. Copy the spreadsheet URL, including its `gid` when a specific worksheet is open.
4. Paste the URL into Story and choose **Use shared link**.

Anyone who receives that URL can read the shared spreadsheet. Use the private connection path for sheets that should not be link-readable.

Vidmyo reads at most 1,000 titled rows per load. It recognizes common title, status, video-number, hook and description headers, including the existing Curio and Superius tracker order. The chosen row is copied into the editable project brief; later edits do not write back to Sheets.

## Current support status

| Installation | Viewer shared link | Private Google account |
| --- | --- | --- |
| Configured development machine | Supported | Native OAuth, with legacy `gws` fallback |
| Clean source checkout | Supported | Import a Desktop OAuth client JSON once, then sign in natively |
| Packaged clean install | Supported | Import an authorized Desktop OAuth client JSON now; zero-configuration Connect needs the release-owned client resource described below |

The native path uses Authorization Code + PKCE, a random state value and a temporary `127.0.0.1` callback. It opens the system browser, refreshes expired access tokens in the main process and exposes only account metadata and authenticated API results to renderer-facing bridges. The OAuth helper itself keeps GET requests allowlisted and accepts JSON writes only to narrow Google Sheets v4 endpoints used to create a tracker, update or append values, clear values, or run the required spreadsheet/value batch update. The legacy `gws` path remains a fallback for already-configured development machines.

## Channel Tracker synchronization

Create a tracker from a loaded Channel Workspace after clicking **Connect Google**. Vidmyo creates a spreadsheet with:

- `Videos`: the exact 21-column Doodle 1/Vidmyo tracker, beginning with `Status`, `Video #`, and `Working Title`.
- `_Vidmyo`: a hidden control worksheet containing `videoId`, `row`, `revision`, and `fingerprint`.

Pull reads both worksheets and imports the visible rows using the core tracker importer. If only the Sheet changed, Vidmyo imports it and advances the hidden baseline. Push exports the core tracker rows and writes them only when the Sheet still matches that baseline. If the local workspace and the Sheet both changed the same video, or if tracked remote rows disappeared, sync returns a bounded conflict list and changes neither visible tracker data nor the local manifest. Resolve the conflict by choosing which version to retain, then run the appropriate pull or push again.

The service API is main-process only:

```js
const tracker = createChannelSheets({ google: nativeGoogle });
await tracker.create(workspace, { title: 'My channel tracker' });
await tracker.pull(workspace);
await tracker.push(workspace);
```

Each call returns bounded metadata such as `spreadsheetId`, `rows`, `action`, and at most 25 conflicting video IDs. It never returns credentials, access tokens, refresh tokens, or cell contents.

## Developer setup

For development, create a Google Cloud project, enable the Drive and Sheets APIs, configure its consent screen, and create an OAuth client of type **Desktop app**. In Vidmyo, click **Configure Google** and choose the downloaded JSON. The imported configuration is encrypted locally and is not copied into a project.

The app requests OpenID email identity, Drive metadata read access for listing spreadsheets, and the Google Sheets scope. Story uses the connection only for worksheet metadata and value reads. Channel Tracker uses it only after the user explicitly creates, pulls, or pushes a Vidmyo-managed tracker.

### Legacy `gws` fallback

Existing development setups can continue to use the open-source [Google Workspace CLI](https://github.com/googleworkspace/cli) when native OAuth has not been configured. This compatibility path is not required for a clean native installation.

1. Install a tested `gws` binary. The upstream project recommends a release binary and also documents:

   ```bash
   npm install -g @googleworkspace/cli
   # or on macOS/Linux
   brew install googleworkspace-cli
   ```

   Vidmyo resolves the helper in this order: `VIDMYO_GWS_PATH`, the process `PATH`, then the usual Homebrew locations `/opt/homebrew/bin` and `/usr/local/bin`. For a controlled development machine, set `VIDMYO_GWS_PATH` to the absolute binary path. Do not point it at a credential file.

2. Create a Google Cloud project and enable the Google Drive API and Google Sheets API.
3. Configure the OAuth consent screen for the intended audience.
4. Create an OAuth client of type **Desktop app**. For local development, place the downloaded file at `~/.config/gws/client_secret.json` and restrict its filesystem permissions.
5. Start Vidmyo and click **Connect Google**. The app runs the browser login for Drive and Sheets in read-only mode; developers and users should never paste tokens into Vidmyo.

The upstream helper can automate steps 2–4 when `gcloud` is installed:

```bash
gws auth setup
```

For a manual setup, keep the Desktop OAuth file at the helper's existing `~/.config/gws/client_secret.json` path. `gws auth login` then encrypts the resulting credentials; Vidmyo invokes the narrower equivalent `gws auth login --readonly --services drive,sheets` from the explicit Connect button. Validate setup without printing credentials:

```bash
gws --version
gws auth status
```

Do not pass credential JSON, access tokens, refresh tokens, client secrets, or the contents of `~/.config/gws` through Vidmyo arguments, logs, test fixtures, support messages, or release artifacts.

For local setup details, follow the upstream [`gws` authentication guide](https://github.com/googleworkspace/cli#authentication). Google documents the available [Sheets scopes](https://developers.google.com/workspace/sheets/api/scopes) and recommends the narrowest scope that supports the product.

Do not copy a developer's OAuth client file, encrypted credential store or tokens into the repository, installer resources, tests, logs or support messages.

## Public-release provisioning

Vidmyo cannot invent or silently reuse a developer's OAuth identity. For a public build whose users should connect without importing configuration, the release owner must:

- Provision a Vidmyo-owned Google Cloud OAuth project with Drive and Sheets enabled and a Desktop OAuth client for the shipped app.
- Request only the scopes the product uses: Drive metadata read access and Google Sheets access for the explicit Tracker operations.
- Complete Google's consent-screen publishing and verification requirements for the selected scopes. A project left in Testing is limited to listed test users and its non-basic authorizations expire after seven days.
- Add the real release-owned `google-oauth-client.json` as an installer resource through the release pipeline. Vidmyo cannot fabricate this resource or silently reuse a developer's OAuth identity. Never source it from a developer's private configuration. User tokens remain encrypted per installation.
- Release CI can now provision it with `VIDMYO_GOOGLE_OAUTH_CLIENT=/secure/path/client.json`. Public builds should also set `VIDMYO_REQUIRE_GOOGLE_OAUTH=1`; packaging then fails instead of shipping an installer whose zero-configuration Google login is incomplete. The file is copied into app resources and is never committed here.
- Test a signed clean install with no global `gws`, no prior Vidmyo user data and no developer environment variables. **Connect Google** must open browser consent, return to Vidmyo and complete an account/list/tab/read probe.
- Verify the failure states for denied consent, expired/revoked authorization, disabled Drive or Sheets API, offline use and an empty account.

Until that provisioning and consent work passes, users can import an authorized Desktop client JSON with **Configure Google**. Viewer shared links remain the no-login fallback.
