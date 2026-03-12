import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { YandexMessengerChannel } from './yandex-messenger.js';
import { ChannelOpts } from './registry.js';
import { ASSISTANT_NAME } from '../config.js';

describe('YandexMessengerChannel', () => {
  let opts: ChannelOpts;
  let channel: YandexMessengerChannel;

  beforeEach(() => {
    opts = {
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: vi.fn().mockReturnValue({
        'ya:12345': {
          name: 'Yandex Chat',
          folder: 'ya_main',
          trigger: `@${ASSISTANT_NAME}`,
          added_at: new Date().toISOString(),
          isMain: true,
        },
      }),
    };
    channel = new YandexMessengerChannel('dummy-token', opts);

    // Mock fetch globally
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    channel.disconnect();
  });

  it('should initialize and connect', async () => {
    // Setup fetch mock for getUpdates
    const fetchMock = vi.mocked(fetch);
    // Let it hang or return empty quickly to not block
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ updates: [] }),
    } as any);

    await channel.connect();

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const callUrl = fetchMock.mock.calls[0][0] as string;
    expect(callUrl).toContain('getUpdates');
    expect(callUrl).toContain('offset=0');
  });

  it('should process incoming messages for registered groups', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        updates: [
          {
            update_id: 1,
            message: {
              message_id: 'msg-1',
              chat: { id: '12345', type: 'private' },
              from: { login: 'user1', name: 'User One', id: 'u1' },
              text: 'Hello bot',
              timestamp: Date.now() / 1000,
            },
          },
        ],
      }),
    } as any);

    // To prevent infinite loop in tests, we can abort the controller early after the first fetch
    // the safest way is to mock fetch to throw AbortError on the second call
    fetchMock.mockRejectedValueOnce(
      Object.assign(new Error('AbortError'), { name: 'AbortError' }),
    );

    await channel.connect();

    // Wait for async poll in background
    await vi.waitFor(() => {
      expect(opts.onChatMetadata).toHaveBeenCalled();
    });

    expect(opts.onChatMetadata).toHaveBeenCalledWith(
      'ya:12345',
      expect.any(String),
      'User One',
      'yandex-messenger',
      false,
    );

    expect(opts.onMessage).toHaveBeenCalledWith('ya:12345', {
      id: 'msg-1',
      chat_jid: 'ya:12345',
      sender: 'user1',
      sender_name: 'User One',
      content: 'Hello bot',
      timestamp: expect.any(String),
      is_from_me: false,
    });
  });

  it('should ignore messages from unregistered groups', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        updates: [
          {
            update_id: 2,
            message: {
              message_id: 'msg-2',
              chat: {
                id: 'unregistered-999',
                type: 'group',
                title: 'Unknown Group',
              },
              from: { login: 'user2', name: 'User Two' },
              text: 'Who are you?',
            },
          },
        ],
      }),
    } as any);
    fetchMock.mockRejectedValueOnce(
      Object.assign(new Error('AbortError'), { name: 'AbortError' }),
    );

    await channel.connect();

    // Wait for background poll
    await vi.waitFor(() => {
      expect(opts.onChatMetadata).toHaveBeenCalled();
    });

    // onChatMetadata is called for discovery
    expect(opts.onChatMetadata).toHaveBeenCalledWith(
      'ya:unregistered-999',
      expect.any(String),
      'Unknown Group',
      'yandex-messenger',
      true,
    );

    // But onMessage should NOT be called
    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('should send a message successfully', async () => {
    channel['isConnectedFlag'] = true; // Force connected state

    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => 'ok',
    } as any);

    await channel.sendMessage('ya:12345', 'Response from bot');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://botapi.messenger.yandex.net/bot/v1/messages/sendText/',
      {
        method: 'POST',
        headers: {
          Authorization: 'OAuth dummy-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chat_id: '12345',
          text: 'Response from bot',
        }),
      },
    );
  });

  it('should format ownsJid correctly', () => {
    expect(channel.ownsJid('ya:123')).toBe(true);
    expect(channel.ownsJid('tg:123')).toBe(false);
  });
});
