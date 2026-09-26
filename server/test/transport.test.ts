import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { createMailer } from '../src/email/transport';
import { createLogger } from '../src/logger';

const message = { to: 'jo@example.com', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' };

function recordingFetch(response: Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return response;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('email transports', () => {
  it('sends through Postmark without link tracking', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      EMAIL_TRANSPORT: 'postmark',
      POSTMARK_SERVER_TOKEN: 'pm-token',
      EMAIL_FROM: 'Toretto <no-reply@example.com>',
    });
    const { calls, fetchImpl } = recordingFetch(Response.json({ MessageID: 'pm-1' }));
    const result = await createMailer(config, createLogger('silent'), fetchImpl).send(message);
    expect(result.messageId).toBe('pm-1');
    expect(calls[0]!.url).toBe('https://api.postmarkapp.com/email');
    expect((calls[0]!.init.headers as Record<string, string>)['X-Postmark-Server-Token']).toBe(
      'pm-token',
    );
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({
      From: 'Toretto <no-reply@example.com>',
      To: 'jo@example.com',
      TrackLinks: 'None',
      MessageStream: 'outbound',
    });
  });

  it('sends through SendGrid without click tracking', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      EMAIL_TRANSPORT: 'sendgrid',
      SENDGRID_API_KEY: 'sg-key',
      EMAIL_FROM: 'Toretto <no-reply@example.com>',
    });
    const { calls, fetchImpl } = recordingFetch(
      new Response(null, { status: 202, headers: { 'x-message-id': 'sg-1' } }),
    );
    const result = await createMailer(config, createLogger('silent'), fetchImpl).send(message);
    expect(result.messageId).toBe('sg-1');
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.from).toEqual({ name: 'Toretto', email: 'no-reply@example.com' });
    expect(body.tracking_settings.click_tracking.enable).toBe(false);
  });

  it('surfaces provider errors so the worker can retry', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      EMAIL_TRANSPORT: 'postmark',
      POSTMARK_SERVER_TOKEN: 't',
    });
    const { fetchImpl } = recordingFetch(
      new Response('{"Message":"Invalid token"}', { status: 401 }),
    );
    await expect(
      createMailer(config, createLogger('silent'), fetchImpl).send(message),
    ).rejects.toThrow(/Postmark rejected the email \(HTTP 401/);
  });

  it('validates provider settings at startup', () => {
    expect(() => loadConfig({ EMAIL_TRANSPORT: 'smtp' })).toThrow('SMTP_URL is required');
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(
      'APP_URL is required in production',
    );
  });
});
