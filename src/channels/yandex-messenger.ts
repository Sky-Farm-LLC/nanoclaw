import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export class YandexMessengerChannel implements Channel {
  name = 'yandex-messenger';

  private token: string;
  private opts: ChannelOpts;
  private isConnectedFlag: boolean = false;
  private abortController: AbortController | null = null;
  private offset: number = 0;
  private pollTimeoutMs: number = 30000;

  constructor(token: string, opts: ChannelOpts) {
    this.token = token;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.isConnectedFlag = true;
    this.abortController = new AbortController();

    // Start long polling loop in background
    setTimeout(() => {
      this.pollUpdates().catch((err) => {
        logger.error({ err }, 'Yandex Messenger polling failed');
      });
    }, 0);

    logger.info('Yandex Messenger bot connected (polling started)');
    console.log(`\n  Yandex Messenger bot connected`);
  }

  private async pollUpdates() {
    while (
      this.isConnectedFlag &&
      this.abortController &&
      !this.abortController.signal.aborted
    ) {
      try {
        const url = `https://botapi.messenger.yandex.net/bot/v1/messages/getUpdates/?offset=${this.offset}&limit=10&timeout=${this.pollTimeoutMs / 1000}`;
        const res = await fetch(url, {
          headers: {
            Authorization: `OAuth ${this.token}`,
          },
          signal: this.abortController.signal,
        });

        if (!res.ok) {
          const text = await res.text();
          logger.error(
            { status: res.status, text },
            'Yandex API error while polling',
          );
          await new Promise((r) => setTimeout(r, 5000)); // wait before retry
          continue;
        }

        const data = (await res.json()) as any;
        if (data && Array.isArray(data.updates)) {
          for (const update of data.updates) {
            if (update.update_id >= this.offset) {
              this.offset = update.update_id + 1;
            }
            this.handleUpdate(update);
          }
        }
      } catch (err: any) {
        if (err.name === 'AbortError') {
          break;
        }
        logger.error(
          { err: err.message },
          'Error polling Yandex Messenger updates',
        );
        await new Promise((r) => setTimeout(r, 5000)); // wait before retry on error
      }
    }
  }

  private handleUpdate(update: any) {
    // Expected structure typically includes text, chat, from, etc.
    if (!update.message || !update.message.text) {
      return;
    }

    const msg = update.message;
    const chatId = msg.chat?.id;
    if (!chatId) return;

    const chatJid = `ya:${chatId}`;
    let content = msg.text;
    const timestamp = msg.timestamp
      ? new Date(msg.timestamp * 1000).toISOString()
      : new Date().toISOString();

    const sender = msg.from?.login || msg.from?.id?.toString() || 'unknown';
    const senderName = msg.from?.name || sender;
    const msgId = msg.message_id?.toString() || Math.random().toString();

    // Check if group
    const isGroup = msg.chat?.type === 'group' || msg.chat?.type === 'channel';
    const chatName = !isGroup ? senderName : msg.chat?.title || chatJid;

    // Store chat metadata
    this.opts.onChatMetadata(
      chatJid,
      timestamp,
      chatName,
      'yandex-messenger',
      isGroup,
    );

    // Only deliver full message for registered groups
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug(
        { chatJid, chatName },
        'Message from unregistered Yandex chat',
      );
      return;
    }

    this.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });

    logger.info(
      { chatJid, chatName, sender: senderName },
      'Yandex Messenger message stored',
    );
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.isConnectedFlag) {
      logger.warn('Yandex Messenger bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^ya:/, '');
      const url = `https://botapi.messenger.yandex.net/bot/v1/messages/sendText/`;

      // Payload accepts chat_id for group chat or direct user chat ID
      const payload = {
        chat_id: numericId,
        text: text,
      };

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `OAuth ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`API error ${res.status}: ${errText}`);
      }

      logger.info(
        { jid, length: text.length },
        'Yandex messenger message sent',
      );
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Yandex messenger message');
    }
  }

  isConnected(): boolean {
    return this.isConnectedFlag;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('ya:');
  }

  async disconnect(): Promise<void> {
    this.isConnectedFlag = false;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    logger.info('Yandex Messenger bot stopped');
  }
}

registerChannel('yandex-messenger', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['YANDEX_MESSENGER_BOT_TOKEN']);
  const token =
    process.env.YANDEX_MESSENGER_BOT_TOKEN ||
    envVars.YANDEX_MESSENGER_BOT_TOKEN ||
    '';
  if (!token) {
    logger.warn('Yandex Messenger: YANDEX_MESSENGER_BOT_TOKEN not set');
    return null;
  }
  return new YandexMessengerChannel(token, opts);
});
