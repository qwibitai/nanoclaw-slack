---
name: add-slack
description: Add Slack as a channel. Supports Socket Mode (no public URL needed) or HTTP Webhook mode (requires public URL). Can replace WhatsApp entirely or run alongside it.
---

# Add Slack Channel

This skill adds Slack support to NanoClaw, then walks through interactive setup.

Two connection modes are available — the channel auto-selects based on which credentials are present in `.env`:

| Mode | Env vars required | Public URL? |
|------|-------------------|-------------|
| **Socket Mode** | `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` | No |
| **HTTP Webhook** | `SLACK_BOT_TOKEN` + `SLACK_SIGNING_SECRET` | Yes |

If both `SLACK_APP_TOKEN` and `SLACK_SIGNING_SECRET` are set, **Socket Mode takes precedence**.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/channels/slack.ts` exists. If it does, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

1. **Which mode do they want?** Socket Mode (simpler, no public URL) or HTTP Webhook (needs a reachable URL/port).
2. **Do they already have a Slack app configured?** If yes, collect the relevant tokens now. If no, we'll create one in Phase 3.

## Phase 2: Apply Code Changes

### Ensure channel remote

```bash
git remote -v
```

If `slack` is missing, add it:

```bash
git remote add slack https://github.com/qwibitai/nanoclaw-slack.git
```

### Merge the skill branch

```bash
git fetch slack main
git merge slack/main || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This merges in:
- `src/channels/slack.ts` (SlackChannel class with self-registration via `registerChannel`)
- `src/channels/slack.test.ts` (unit tests)
- `import './slack.js'` appended to the channel barrel file `src/channels/index.ts`
- `@slack/bolt` npm dependency in `package.json`
- `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, and `SLACK_SIGNING_SECRET` in `.env.example`

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Validate code changes

```bash
npm install
npm run build
npx vitest run src/channels/slack.test.ts
```

All tests must pass and build must be clean before proceeding.

## Phase 3: Setup

### Create Slack App (if needed)

If the user doesn't have a Slack app yet, follow the appropriate path below.

---

#### Option A: Socket Mode setup

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app (from scratch).
2. Under **Settings → Socket Mode**, enable Socket Mode and generate an **App-Level Token** with `connections:write` scope — this gives you the `xapp-...` token.
3. Under **Event Subscriptions**, enable events and subscribe to bot events:
   - `message.channels`, `message.groups`, `message.im`
4. Under **OAuth & Permissions**, add Bot Token Scopes:
   - `chat:write`, `channels:history`, `groups:history`, `im:history`, `channels:read`, `groups:read`, `users:read`
5. Install the app to your workspace and copy the **Bot Token** (`xoxb-...`).

Wait for the user to provide both tokens, then continue to "Configure environment" with:

```
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
```

---

#### Option B: HTTP Webhook mode setup

HTTP Webhook mode requires NanoClaw to be reachable from the internet. Determine the public URL first:
- If the host has a public IP: `http://<IP>:<SLACK_PORT>`
- If behind a reverse proxy (nginx, Caddy): route `/slack/events` to `localhost:<SLACK_PORT>`
- If using a tunnel (ngrok, cloudflared): `https://<tunnel-hostname>/slack/events`

Default port is `3000`. Override with `SLACK_PORT=<port>` in `.env`.

**Steps:**

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app (from scratch).
2. Under **Settings → Socket Mode**, make sure Socket Mode is **disabled**.
3. Under **Basic Information**, copy the **Signing Secret** — this is `SLACK_SIGNING_SECRET`.
4. Under **Event Subscriptions**, enable events and set the **Request URL** to:
   ```
   https://your-public-url/slack/events
   ```
   Slack will immediately send a challenge request to verify the URL — NanoClaw must be running and reachable for this to pass.
5. Subscribe to bot events: `message.channels`, `message.groups`, `message.im`
6. Under **OAuth & Permissions**, add Bot Token Scopes:
   - `chat:write`, `channels:history`, `groups:history`, `im:history`, `channels:read`, `groups:read`, `users:read`
7. Install the app to your workspace and copy the **Bot Token** (`xoxb-...`).

Wait for the user to provide the bot token and signing secret, then continue to "Configure environment" with:

```
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_SIGNING_SECRET=your-signing-secret
SLACK_PORT=3000        # optional, defaults to 3000
```

---

### Configure environment

Add the appropriate variables to `.env` (see above), then sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

The container reads environment from `data/env/env`, not `.env` directly.

Channels auto-enable when their credentials are present — no extra configuration needed.

### Build and restart

```bash
npm run build
# Linux:
systemctl --user restart nanoclaw
# macOS:
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

For HTTP Webhook mode, verify the receiver is listening:

```bash
curl -s http://localhost:${SLACK_PORT:-3000}/slack/events
# Expected: a 404 or method-not-allowed from the Bolt receiver (not a connection error)
```

## Phase 4: Registration

### Get Channel ID

Tell the user:

> 1. Add the bot to a Slack channel (right-click channel → **View channel details** → **Integrations** → **Add apps**)
> 2. In that channel, the channel ID is in the URL when you open it in a browser: `https://app.slack.com/client/T.../C0123456789` — the `C...` part is the channel ID
> 3. Alternatively, right-click the channel name → **Copy link** — the channel ID is the last path segment
>
> The JID format for NanoClaw is: `slack:C0123456789`

Wait for the user to provide the channel ID.

### Register the channel

The channel ID, name, and folder name are needed. Use `npx tsx setup/index.ts --step register` with the appropriate flags.

For a main channel (responds to all messages):

```bash
npx tsx setup/index.ts --step register -- --jid "slack:<channel-id>" --name "<channel-name>" --folder "slack_main" --trigger "@${ASSISTANT_NAME}" --channel slack --no-trigger-required --is-main
```

For additional channels (trigger-only):

```bash
npx tsx setup/index.ts --step register -- --jid "slack:<channel-id>" --name "<channel-name>" --folder "slack_<channel-name>" --trigger "@${ASSISTANT_NAME}" --channel slack
```

## Phase 5: Verify

### Test the connection

Tell the user:

> Send a message in your registered Slack channel:
> - For main channel: Any message works
> - For non-main: `@<assistant-name> hello` (using the configured trigger word)
>
> The bot should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

---

## Migrating from Socket Mode to HTTP Webhook mode

If Slack is already working in Socket Mode and you want to switch to HTTP webhooks:

**1. Update the Slack app configuration**

- Go to [api.slack.com/apps](https://api.slack.com/apps) → your app.
- Under **Settings → Socket Mode**, **disable** Socket Mode.
- Under **Event Subscriptions**, enable events and set the **Request URL** to `https://your-public-url/slack/events`. (NanoClaw must be running and reachable when you save — Slack sends an immediate challenge.)
- Confirm the same bot events are still subscribed: `message.channels`, `message.groups`, `message.im`.

**2. Copy the Signing Secret**

Under **Basic Information** → **App Credentials** → copy **Signing Secret**.

**3. Update `.env`**

Remove `SLACK_APP_TOKEN` and add `SLACK_SIGNING_SECRET` (and optionally `SLACK_PORT`):

```bash
# Before
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...

# After
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=your-signing-secret
SLACK_PORT=3000        # optional, defaults to 3000
```

Sync to container:

```bash
mkdir -p data/env && cp .env data/env/env
```

**4. Restart**

```bash
# Linux:
systemctl --user restart nanoclaw
# macOS:
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

**5. Verify**

```bash
curl -s http://localhost:${SLACK_PORT:-3000}/slack/events
# Should get a Bolt response, not a connection refused
```

Send a test message in Slack — the bot should respond as before. No group re-registration needed; all existing registered channels continue to work.

---

## Troubleshooting

### Bot not responding

1. Check credentials are set in `.env` AND synced to `data/env/env`
2. Check channel is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'slack:%'"`
3. For non-main channels: message must include trigger pattern
4. Service is running:
   - Linux: `systemctl --user is-active nanoclaw`
   - macOS: `launchctl list | grep nanoclaw`

### HTTP Webhook: "URL verification failed" in Slack

Slack sends an HTTP challenge when you save the Request URL. NanoClaw must be:
1. Running (`systemctl --user is-active nanoclaw`)
2. Reachable on `SLACK_PORT` from the internet
3. Using the correct `SLACK_SIGNING_SECRET` in `.env`

Check: `curl -v http://localhost:${SLACK_PORT:-3000}/slack/events` from the server.

### HTTP Webhook: events arrive but bot doesn't respond

Slack sends events as HTTP POST. If the public URL isn't routing to NanoClaw's port, events are silently dropped. Check your reverse proxy or firewall rules.

### Socket Mode: bot connected but not receiving messages

1. Verify Socket Mode is enabled in the Slack app settings
2. Verify the bot is subscribed to the correct events (`message.channels`, `message.groups`, `message.im`)
3. Verify the bot has been added to the channel
4. Check that the bot has the required OAuth scopes

### Bot not seeing messages in channels

By default, bots only see messages in channels they've been explicitly added to. Make sure to:
1. Add the bot to each channel you want it to monitor
2. Check the bot has `channels:history` and/or `groups:history` scopes

### "missing_scope" errors

1. Go to **OAuth & Permissions** in your Slack app settings
2. Add the missing scope listed in the error message
3. **Reinstall the app** to your workspace — scope changes require reinstallation
4. Copy the new Bot Token (it changes on reinstall) and update `.env`
5. Sync: `mkdir -p data/env && cp .env data/env/env`
6. Restart the service

### Getting channel ID

- In Slack desktop: right-click channel → **Copy link** → extract the `C...` ID from the URL
- In Slack web: the URL shows `https://app.slack.com/client/TXXXXXXX/C0123456789`
- Via API: `curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" "https://slack.com/api/conversations.list" | jq '.channels[] | {id, name}'`

## After Setup

The Slack channel supports:
- **Public channels** — Bot must be added to the channel
- **Private channels** — Bot must be invited to the channel
- **Direct messages** — Users can DM the bot directly
- **Multi-channel** — Can run alongside WhatsApp or other channels (auto-enabled by credentials)

## Known Limitations

- **Threads are flattened** — Threaded replies are delivered to the agent as regular channel messages. The agent sees them but has no awareness they originated in a thread. Responses always go to the channel, not back into the thread. Users in a thread will need to check the main channel for the bot's reply.
- **No typing indicator** — Slack's Bot API does not expose a typing indicator endpoint. The `setTyping()` method is a no-op.
- **Message splitting is naive** — Long messages are split at a fixed 4000-character boundary, which may break mid-word or mid-sentence.
- **No file/image handling** — The bot only processes text content. File uploads, images, and rich message blocks are not forwarded to the agent.
- **Channel metadata sync is unbounded** — `syncChannelMetadata()` paginates through all channels the bot is a member of with no upper bound. Large workspaces may experience slow startup.
- **HTTP mode: no automatic retry on delivery failure** — In Socket Mode, the WebSocket reconnects automatically. In HTTP Webhook mode, if NanoClaw is down when Slack delivers an event, Slack retries for up to 3 days with exponential backoff, but events delivered during the outage window may arrive out of order.
