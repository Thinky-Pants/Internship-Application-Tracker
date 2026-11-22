# Gmail setup

The app connects to your own @gmail.com mailbox with Google sign-in (OAuth). It never sees your Google password.

## 1. Create a Google Cloud project (free, no billing needed)

1. Go to https://console.cloud.google.com and sign in with **the Gmail account you will send from**.
2. Top bar → project picker → **New project**. Name it e.g. "Outreach Manager". Create and select it.
3. **APIs & Services → Library** → search **Gmail API** → **Enable**.

## 2. Configure the consent screen as a *Personal* app

Google offers a **Personal** user type for apps used only by the account that created them. Per Google's documentation, Personal apps "do not require OAuth app verification, are not subject to the OAuth user cap or 7-day test user token expiration, and do not display the unverified app screen."

1. **APIs & Services → OAuth consent screen** (shown as **Google Auth Platform** in newer consoles) → **Get started**.
2. App name: "Outreach Manager"; support email: your Gmail address.
3. **Audience / User type:** choose **Personal**. This is a one-time choice and can't be changed later. Only your own Google account will be able to sign in, which is what you want.
4. Contact email: your address → finish.

If **Personal** is not offered in your console, choose **External**, then under **Audience** click **Publish app** (status *In production*). You will see an "unverified app" warning when connecting; it's your own app, so continue past it ("Advanced" → "Go to … (unsafe)"). Do **not** leave it in *Testing*: in Testing, Google expires the sign-in every 7 days and you would have to reconnect weekly.

## 3. Create the OAuth client

1. **APIs & Services → Credentials → Create credentials → OAuth client ID** (or **Clients → Create client**).
2. Application type: **Web application**. Name: "Outreach Manager local".
3. **Authorized redirect URIs → Add URI:** `http://localhost:3000/api/oauth/google/callback` (exactly; `localhost`, no trailing slash). For a cloud deployment add `https://<your-domain>/api/oauth/google/callback` as well.
4. **Create**. Copy the **Client ID** and **Client secret**.

Scopes are requested by the app at sign-in; you don't need to add them in the console. The app asks for:

| Scope | Why |
| --- | --- |
| `gmail.readonly` | Read Inbox/Sent to detect replies and confirm that a message was sent |
| `gmail.compose` | Create the draft (with your CV), and send it after your approval |
| `openid`, `email` | Identify which Gmail account is connected |

Google classifies both Gmail scopes as "restricted"; that is why the Personal user type matters.

## 4. Configure the app

Edit `.env` in the project folder (type the secret yourself; don't paste it into chats):

```
GOOGLE_CLIENT_ID=<Client ID>
GOOGLE_CLIENT_SECRET=<Client secret>
GOOGLE_REDIRECT_URI=http://localhost:3000/api/oauth/google/callback
```

Restart the containers so they read the new values:

```powershell
docker compose up -d --force-recreate web worker
```

## 5. Connect

App → **Settings & Integrations → Connect Gmail account** → choose your account → allow **both** Gmail permissions (if you untick one, the app refuses the connection and tells you). The mailbox then shows **connected**, folders (Inbox, Sent, your labels) are discovered, and the first sync covers the last 90 days of Inbox and Sent.

**Disconnect** revokes the app's access at Google, removes stored tokens, holds pending sends (never deletes them) and keeps history. You can also review access at https://myaccount.google.com/permissions.

## How it works with Gmail

- **Draft-first sending:** the worker creates a Gmail draft from the approved revision with the exact CV bytes (≤ 3 MB per attachment), then sends that draft. Gmail deletes the draft and creates the sent message (new ID, same thread); the app finds it in the thread and records **sent**.
- **Edited in Gmail?** Editing a draft in Gmail replaces its underlying message. The app notices the change and **holds** the send instead of sending under the old approval.
- **Uncertain sends:** if the connection drops after Gmail may have sent, the app checks the thread for the sent copy before any retry; it never blindly resends.
- **Replies:** Gmail keeps In-Reply-To/References headers, so replies are matched to the exact message; your replies from the app go into the same thread.
- **Sync:** history-based incremental sync every 5 minutes (and on "Sync now"). If Gmail's history position expires (typically after about a week offline), the app resyncs the recent window without creating duplicates. Track extra labels in Settings if Gmail filters move replies out of the Inbox.
- **Limits:** keep the app's per-mailbox limits conservative (defaults: 40/day, 10/hour, 4 minutes apart). Consumer Gmail accounts also have their own daily sending limits.

## Things that end the connection

Google may invalidate the sign-in if you **change your Google password**, revoke access, leave it unused for **six months**, or reconnect the same app more than 100 times. The app then marks the mailbox **expired**, holds sends, and you click **Reconnect Gmail**.

## Not implemented for Gmail

Push notifications (Gmail → Cloud Pub/Sub) are not implemented; the worker polls instead, which is fine for a personal mailbox. Attachments over 3 MB are rejected.
