import { App, LogLevel } from '@slack/bolt';
import type { GenericMessageEvent, BotMessageEvent } from '@slack/types';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import {
  getLatestMessage,
  removeReaction,
  storeReaction,
  updateChatName,
} from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

// Slack's chat.postMessage API limits text to ~4000 characters per call.
// Messages exceeding this are split into sequential chunks.
const MAX_MESSAGE_LENGTH = 4000;

// The message subtypes we process. Bolt delivers all subtypes via app.event('message');
// we filter to regular messages (GenericMessageEvent, subtype undefined) and bot messages
// (BotMessageEvent, subtype 'bot_message') so we can track our own output.
type HandledMessageEvent = GenericMessageEvent | BotMessageEvent;

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class SlackChannel implements Channel {
  name = 'slack';

  private app: App;
  private botUserId: string | undefined;
  private connected = false;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private userNameCache = new Map<string, string>();

  private opts: SlackChannelOpts;

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;

    // Read tokens from .env (not process.env — keeps secrets off the environment
    // so they don't leak to child processes, matching NanoClaw's security pattern)
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
    const botToken = env.SLACK_BOT_TOKEN;
    const appToken = env.SLACK_APP_TOKEN;

    if (!botToken || !appToken) {
      throw new Error(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env',
      );
    }

    this.app = new App({
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: LogLevel.ERROR,
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Use app.event('message') instead of app.message() to capture all
    // message subtypes including bot_message (needed to track our own output)
    this.app.event('message', async ({ event }) => {
      // Bolt's event type is the full MessageEvent union (17+ subtypes).
      // We filter on subtype first, then narrow to the two types we handle.
      const subtype = (event as { subtype?: string }).subtype;
      if (subtype && subtype !== 'bot_message') return;

      // After filtering, event is either GenericMessageEvent or BotMessageEvent
      const msg = event as HandledMessageEvent;

      if (!msg.text) return;

      // Threaded replies are flattened into the channel conversation.
      // The agent sees them alongside channel-level messages; responses
      // always go to the channel, not back into the thread.

      const jid = `slack:${msg.channel}`;
      const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();
      const isGroup = msg.channel_type !== 'im';

      // Always report metadata for group discovery
      this.opts.onChatMetadata(jid, timestamp, undefined, 'slack', isGroup);

      // Only deliver full messages for registered groups
      const groups = this.opts.registeredGroups();
      if (!groups[jid]) return;

      const isBotMessage =
        !!msg.bot_id || msg.user === this.botUserId;

      let senderName: string;
      if (isBotMessage) {
        senderName = ASSISTANT_NAME;
      } else {
        senderName =
          (msg.user ? await this.resolveUserName(msg.user) : undefined) ||
          msg.user ||
          'unknown';
      }

      // Translate Slack <@UBOTID> mentions into TRIGGER_PATTERN format.
      // Slack encodes @mentions as <@U12345>, which won't match TRIGGER_PATTERN
      // (e.g., ^@<ASSISTANT_NAME>\b), so we prepend the trigger when the bot is @mentioned.
      let content = msg.text;
      if (this.botUserId && !isBotMessage) {
        const mentionPattern = `<@${this.botUserId}>`;
        if (content.includes(mentionPattern) && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      this.opts.onMessage(jid, {
        id: msg.ts,
        chat_jid: jid,
        sender: msg.user || msg.bot_id || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: isBotMessage,
        is_bot_message: isBotMessage,
      });
    });

    this.app.event('reaction_added', async ({ event }) => {
      await this.handleReactionEvent(event, 'added');
    });

    this.app.event('reaction_removed', async ({ event }) => {
      await this.handleReactionEvent(event, 'removed');
    });
  }

  private async handleReactionEvent(
    event: {
      user?: string;
      reaction?: string;
      item?: { type?: string; channel?: string; ts?: string };
      event_ts?: string;
    },
    kind: 'added' | 'removed',
  ): Promise<void> {
    try {
      if (!event.item || event.item.type !== 'message') return;
      const channelId = event.item.channel;
      const messageId = event.item.ts;
      const emoji = event.reaction;
      const reactorUserId = event.user;
      if (!channelId || !messageId || !emoji || !reactorUserId) return;

      const chatJid = `slack:${channelId}`;
      const groups = this.opts.registeredGroups();
      if (!groups[chatJid]) return;

      const timestamp = event.event_ts
        ? new Date(parseFloat(event.event_ts) * 1000).toISOString()
        : new Date().toISOString();
      const reactorJid = `slack:${reactorUserId}`;
      const reactorName = await this.resolveUserName(reactorUserId);

      if (kind === 'added') {
        storeReaction({
          message_id: messageId,
          message_chat_jid: chatJid,
          reactor_jid: reactorJid,
          reactor_name: reactorName,
          emoji,
          timestamp,
        });
      } else {
        removeReaction(messageId, chatJid, reactorJid, emoji);
      }

      logger.info(
        {
          chatJid,
          messageId,
          reactor: reactorName || reactorUserId,
          emoji,
        },
        kind === 'added' ? 'Slack reaction added' : 'Slack reaction removed',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to process Slack reaction');
    }
  }

  async connect(): Promise<void> {
    await this.app.start();

    // Get bot's own user ID for self-message detection.
    // Resolve this BEFORE setting connected=true so that messages arriving
    // during startup can correctly detect bot-sent messages.
    try {
      const auth = await this.app.client.auth.test();
      this.botUserId = auth.user_id as string;
      logger.info({ botUserId: this.botUserId }, 'Connected to Slack');
    } catch (err) {
      logger.warn(
        { err },
        'Connected to Slack but failed to get bot user ID',
      );
    }

    this.connected = true;

    // Flush any messages queued before connection
    await this.flushOutgoingQueue();

    // Sync channel names on startup
    await this.syncChannelMetadata();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'Slack disconnected, message queued',
      );
      return;
    }

    try {
      // Slack limits messages to ~4000 characters; split if needed
      if (text.length <= MAX_MESSAGE_LENGTH) {
        await this.app.client.chat.postMessage({ channel: channelId, text });
      } else {
        for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
          await this.app.client.chat.postMessage({
            channel: channelId,
            text: text.slice(i, i + MAX_MESSAGE_LENGTH),
          });
        }
      }
      logger.info({ jid, length: text.length }, 'Slack message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Slack message, queued',
      );
    }
  }

  /**
   * Send a reaction to a message.
   * `emoji` is the Slack shortcode name without surrounding colons
   * (e.g. `"thumbsup"`, `"+1"`). An empty or falsy value removes the bot's
   * reaction — Slack requires the original emoji name to remove, which we
   * can't reconstruct without state, so callers should pass the emoji that
   * was previously added.
   */
  async sendReaction(
    chatJid: string,
    messageKey: { id: string; remoteJid: string },
    emoji: string,
  ): Promise<void> {
    if (!this.connected) {
      logger.warn({ chatJid, emoji }, 'Cannot send reaction - not connected');
      throw new Error('Not connected to Slack');
    }

    const channelId = (messageKey.remoteJid || chatJid).replace(/^slack:/, '');
    const name = this.normalizeEmojiName(emoji);

    try {
      if (!name) {
        // Empty emoji is treated as "remove whatever I reacted with" — but
        // Slack has no "remove all" API, so we no-op and log.
        logger.warn(
          { chatJid },
          'sendReaction called with empty emoji — Slack requires a specific emoji name to remove; no-op',
        );
        return;
      }
      await this.app.client.reactions.add({
        channel: channelId,
        timestamp: messageKey.id,
        name,
      });
      logger.info(
        { chatJid, messageId: messageKey.id, emoji: name },
        'Slack reaction sent',
      );
    } catch (err) {
      const errMsg = (err as { data?: { error?: string } })?.data?.error;
      if (errMsg === 'already_reacted') {
        logger.debug(
          { chatJid, emoji: name },
          'Slack reaction already present, ignoring',
        );
        return;
      }
      logger.error({ chatJid, emoji: name, err }, 'Failed to send Slack reaction');
      throw err;
    }
  }

  async reactToLatestMessage(chatJid: string, emoji: string): Promise<void> {
    const latest = getLatestMessage(chatJid);
    if (!latest) {
      throw new Error(`No messages found for chat ${chatJid}`);
    }
    await this.sendReaction(
      chatJid,
      { id: latest.id, remoteJid: chatJid },
      emoji,
    );
  }

  /**
   * Normalize an emoji input to the Slack shortcode name used by the
   * reactions API. Accepts:
   *   - bare shortcode   → `thumbsup`
   *   - wrapped shortcode → `:thumbsup:`
   *   - unicode emoji    → currently unsupported, returned as-is
   */
  private normalizeEmojiName(emoji: string): string {
    if (!emoji) return '';
    const trimmed = emoji.trim();
    if (trimmed.startsWith(':') && trimmed.endsWith(':')) {
      return trimmed.slice(1, -1);
    }
    return trimmed;
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('slack:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.app.stop();
  }

  // Slack does not expose a typing indicator API for bots.
  // This no-op satisfies the Channel interface so the orchestrator
  // doesn't need channel-specific branching.
  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // no-op: Slack Bot API has no typing indicator endpoint
  }

  /**
   * Sync channel metadata from Slack.
   * Fetches channels the bot is a member of and stores their names in the DB.
   */
  async syncChannelMetadata(): Promise<void> {
    try {
      logger.info('Syncing channel metadata from Slack...');
      let cursor: string | undefined;
      let count = 0;

      do {
        const result = await this.app.client.conversations.list({
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 200,
          cursor,
        });

        for (const ch of result.channels || []) {
          if (ch.id && ch.name && ch.is_member) {
            updateChatName(`slack:${ch.id}`, ch.name);
            count++;
          }
        }

        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);

      logger.info({ count }, 'Slack channel metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync Slack channel metadata');
    }
  }

  private async resolveUserName(
    userId: string,
  ): Promise<string | undefined> {
    if (!userId) return undefined;

    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    try {
      const result = await this.app.client.users.info({ user: userId });
      const name = result.user?.real_name || result.user?.name;
      if (name) this.userNameCache.set(userId, name);
      return name;
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to resolve Slack user name');
      return undefined;
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing Slack outgoing queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        const channelId = item.jid.replace(/^slack:/, '');
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: item.text,
        });
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued Slack message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}

registerChannel('slack', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
  if (!envVars.SLACK_BOT_TOKEN || !envVars.SLACK_APP_TOKEN) {
    logger.warn('Slack: SLACK_BOT_TOKEN or SLACK_APP_TOKEN not set');
    return null;
  }
  return new SlackChannel(opts);
});
