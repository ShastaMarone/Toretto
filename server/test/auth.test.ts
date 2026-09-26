import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearEmails,
  createTestContext,
  createUser,
  emails,
  login,
  PASSWORD,
  tokenIn,
  type TestContext,
} from './helpers';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

describe('first-run setup', () => {
  it('creates the first admin, seeds tiers and requires email confirmation', async () => {
    const agent = ctx.agent();
    const boot = await agent.get('/api/bootstrap');
    expect(boot.body.setupRequired).toBe(true);
    expect(boot.body.user).toBeNull();

    const res = await agent.post('/api/auth/setup').send({
      name: 'Robin Admin',
      email: 'Robin@Example.com',
      password: 'correct horse battery',
      orgName: 'Support Org',
      timezone: 'America/Vancouver',
    });
    expect(res.status).toBe(201);
    expect(res.body.email).toBe('robin@example.com');

    const tiers = await ctx.db.query('SELECT name FROM tiers ORDER BY sort_order');
    expect(tiers.rows.map((t) => t.name)).toEqual(['Tier 1', 'Tier 2', 'Tier 3']);
    const labels = await ctx.db.query(
      'SELECT name FROM labels WHERE tier_id IS NULL ORDER BY name',
    );
    expect(labels.rows.map((l) => l.name)).toEqual(['On-Call', 'Overtime', 'Training']);

    // Can't sign in until the email is confirmed.
    const early = await agent
      .post('/api/auth/login')
      .send({ email: 'robin@example.com', password: 'correct horse battery' });
    expect(early.status).toBe(403);
    expect(early.body.error.code).toBe('EMAIL_NOT_VERIFIED');

    const [verify] = await emails(ctx.db, { to: 'robin@example.com', kind: 'verify_email' });
    expect(verify!.subject).toBe('Confirm your email for Support Org');
    const token = tokenIn(verify!, '/verify-email');

    const confirmed = await agent.post('/api/auth/verify-email').send({ token });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.user).toMatchObject({ email: 'robin@example.com', role: 'admin' });

    const after = await agent.get('/api/bootstrap');
    expect(after.body.setupRequired).toBe(false);
    expect(after.body.user.name).toBe('Robin Admin');
    expect(after.body.org).toEqual({
      name: 'Support Org',
      timezone: 'America/Vancouver',
      weekStartsOn: 1,
    });

    // Links are single-use.
    const again = await ctx.agent().post('/api/auth/verify-email').send({ token });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('INVALID_TOKEN');
  });

  it('cannot run twice', async () => {
    const res = await ctx.agent().post('/api/auth/setup').send({
      name: 'Intruder',
      email: 'intruder@example.com',
      password: 'password123',
      orgName: 'Mine now',
      timezone: 'UTC',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SETUP_COMPLETE');
  });

  it('locks setup on a public URL until ADMIN_EMAIL is set', async () => {
    const pub = await createTestContext({ APP_URL: 'https://schedule.example.com' });
    try {
      const res = await pub.agent().post('/api/auth/setup').send({
        name: 'First Visitor',
        email: 'first@example.com',
        password: 'password123',
        orgName: 'Org',
        timezone: 'UTC',
      });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('SETUP_LOCKED');
    } finally {
      await pub.close();
    }
  });

  it('only lets ADMIN_EMAIL complete setup when configured', async () => {
    const locked = await createTestContext({ ADMIN_EMAIL: 'boss@example.com' });
    try {
      const body = { name: 'X', password: 'password123', orgName: 'Org', timezone: 'UTC' };
      const wrong = await locked
        .agent()
        .post('/api/auth/setup')
        .send({ ...body, email: 'x@example.com' });
      expect(wrong.status).toBe(403);
      expect(wrong.body.error.code).toBe('SETUP_EMAIL_MISMATCH');
      const right = await locked
        .agent()
        .post('/api/auth/setup')
        .send({ ...body, email: 'BOSS@example.com' });
      expect(right.status).toBe(201);
    } finally {
      await locked.close();
    }
  });
});

describe('sign in and out', () => {
  beforeEach(() => clearEmails(ctx.db));

  it('rejects bad credentials with the same message for unknown emails', async () => {
    await createUser(ctx.db, { name: 'Lee Member', email: 'lee@example.com' });
    const wrong = await ctx
      .agent()
      .post('/api/auth/login')
      .send({ email: 'lee@example.com', password: 'nope-nope' });
    const unknown = await ctx
      .agent()
      .post('/api/auth/login')
      .send({ email: 'ghost@example.com', password: 'nope-nope' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });

  it('keeps a session cookie until logout', async () => {
    const agent = ctx.agent();
    await login(agent, 'lee@example.com');
    expect((await agent.get('/api/bootstrap')).body.user.email).toBe('lee@example.com');
    const cookie = (await agent.post('/api/auth/logout')).headers['set-cookie'];
    expect(String(cookie)).toContain('toretto_session=;');
    expect((await agent.get('/api/bootstrap')).body.user).toBeNull();
    expect((await agent.get('/api/my/time-off')).status).toBe(401);
  });

  it('blocks deactivated people and ends their sessions', async () => {
    const user = await createUser(ctx.db, { name: 'Gone Soon' });
    const agent = ctx.agent();
    await login(agent, user.email);
    await ctx.db.query('UPDATE users SET deactivated_at = now() WHERE id = $1', [user.id]);
    expect((await agent.get('/api/bootstrap')).body.user).toBeNull();
    const res = await ctx
      .agent()
      .post('/api/auth/login')
      .send({ email: user.email, password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_DEACTIVATED');
  });

  it('rejects cross-site requests', async () => {
    const res = await ctx
      .agent()
      .post('/api/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ email: 'lee@example.com', password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('BAD_ORIGIN');
  });
});

describe('invites', () => {
  it('lets an invited person set a password, which confirms their email', async () => {
    const admin = ctx.agent();
    await login(admin, 'robin@example.com', 'correct horse battery');
    const invite = await admin
      .post('/api/users')
      .send({ name: 'Nia New', email: 'nia@example.com' });
    expect(invite.status).toBe(201);
    expect(invite.body.status).toBe('invited');

    const [mail] = await emails(ctx.db, { to: 'nia@example.com', kind: 'invite' });
    expect(mail!.subject).toBe('Robin Admin invited you to the Support Org schedule');
    const token = tokenIn(mail!, '/set-password');

    const info = await ctx.agent().post('/api/auth/token-info').send({ token });
    expect(info.body).toEqual({ purpose: 'invite', name: 'Nia New', email: 'nia@example.com' });

    const member = ctx.agent();
    const set = await member
      .post('/api/auth/set-password')
      .send({ token, password: 'my new password' });
    expect(set.status).toBe(200);
    expect(set.body.user).toMatchObject({
      email: 'nia@example.com',
      role: 'member',
      hasPassword: true,
    });

    const people = await admin.get('/api/users');
    expect(people.body.find((p: { email: string }) => p.email === 'nia@example.com').status).toBe(
      'active',
    );
    expect(
      (await ctx.agent().post('/api/auth/set-password').send({ token, password: 'again12345' }))
        .status,
    ).toBe(400);
    await login(ctx.agent(), 'nia@example.com', 'my new password');
  });

  it('resending an invite invalidates the previous link', async () => {
    const admin = ctx.agent();
    await login(admin, 'robin@example.com', 'correct horse battery');
    const { body: person } = await admin
      .post('/api/users')
      .send({ name: 'Omar Two', email: 'omar@example.com' });
    await admin.post(`/api/users/${person.id}/resend-invite`).expect(200);
    const [first, second] = await emails(ctx.db, { to: 'omar@example.com', kind: 'invite' });
    const oldToken = tokenIn(first!, '/set-password');
    const newToken = tokenIn(second!, '/set-password');
    expect((await ctx.agent().post('/api/auth/token-info').send({ token: oldToken })).status).toBe(
      400,
    );
    expect((await ctx.agent().post('/api/auth/token-info').send({ token: newToken })).status).toBe(
      200,
    );
  });
});

describe('magic links and password resets', () => {
  beforeEach(() => clearEmails(ctx.db));

  it('signs in with an emailed link and confirms the address', async () => {
    const invited = await createUser(ctx.db, {
      name: 'Link User',
      verified: false,
      withPassword: false,
    });
    const res = await ctx
      .agent()
      .post('/api/auth/magic-link')
      .send({ email: invited.email, next: '/my-schedule' });
    expect(res.status).toBe(202);
    const [mail] = await emails(ctx.db, { to: invited.email, kind: 'magic_link' });
    expect(mail!.text).toContain('next=%2Fmy-schedule');
    const agent = ctx.agent();
    const signIn = await agent
      .post('/api/auth/magic-link/verify')
      .send({ token: tokenIn(mail!, '/magic-link') });
    expect(signIn.status).toBe(200);
    expect(signIn.body.user.email).toBe(invited.email);
    const { rows } = await ctx.db.query('SELECT email_verified_at FROM users WHERE id = $1', [
      invited.id,
    ]);
    expect(rows[0].email_verified_at).not.toBeNull();
  });

  it('does not reveal whether an email exists', async () => {
    const res = await ctx
      .agent()
      .post('/api/auth/magic-link')
      .send({ email: 'nobody@example.com' });
    expect(res.status).toBe(202);
    expect(await emails(ctx.db)).toHaveLength(0);
  });

  it('drops unsafe redirect targets', async () => {
    await ctx
      .agent()
      .post('/api/auth/magic-link')
      .send({ email: 'lee@example.com', next: '//evil.example' });
    const [mail] = await emails(ctx.db, { kind: 'magic_link' });
    expect(mail!.text).not.toContain('evil');
  });

  it('resets a password and signs out other devices', async () => {
    const user = await createUser(ctx.db, { name: 'Reset Me' });
    const oldDevice = ctx.agent();
    await login(oldDevice, user.email);

    await ctx.agent().post('/api/auth/forgot-password').send({ email: user.email }).expect(202);
    const [mail] = await emails(ctx.db, { to: user.email, kind: 'reset_password' });
    const info = await ctx
      .agent()
      .post('/api/auth/token-info')
      .send({ token: tokenIn(mail!, '/set-password') });
    expect(info.body.purpose).toBe('reset_password');

    const newDevice = ctx.agent();
    await newDevice
      .post('/api/auth/set-password')
      .send({ token: tokenIn(mail!, '/set-password'), password: 'brand new password' })
      .expect(200);
    expect((await oldDevice.get('/api/bootstrap')).body.user).toBeNull();
    expect((await newDevice.get('/api/bootstrap')).body.user.email).toBe(user.email);
    expect(
      (await ctx.agent().post('/api/auth/login').send({ email: user.email, password: PASSWORD }))
        .status,
    ).toBe(401);
    await login(ctx.agent(), user.email, 'brand new password');
  });

  it('rejects expired links', async () => {
    const user = await createUser(ctx.db, { name: 'Slow Clicker' });
    await ctx.agent().post('/api/auth/magic-link').send({ email: user.email });
    await ctx.db.query(
      `UPDATE auth_tokens SET expires_at = now() - interval '1 minute' WHERE user_id = $1`,
      [user.id],
    );
    const [mail] = await emails(ctx.db, { to: user.email });
    const res = await ctx
      .agent()
      .post('/api/auth/magic-link/verify')
      .send({ token: tokenIn(mail!, '/magic-link') });
    expect(res.status).toBe(400);
  });
});

describe('self sign-up', () => {
  beforeEach(() => clearEmails(ctx.db));

  it('is off by default', async () => {
    const res = await ctx
      .agent()
      .post('/api/auth/signup')
      .send({ name: 'Walk In', email: 'walk@example.com', password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SIGNUP_DISABLED');
  });

  it('can be limited to company domains and requires email confirmation', async () => {
    const admin = ctx.agent();
    await login(admin, 'robin@example.com', 'correct horse battery');
    const settings = await admin
      .patch('/api/admin/settings')
      .send({ selfSignup: true, allowedDomains: ['@Company.com'] });
    expect(settings.body.allowedDomains).toEqual(['company.com']);

    const outsider = await ctx
      .agent()
      .post('/api/auth/signup')
      .send({ name: 'Out', email: 'out@gmail.com', password: PASSWORD });
    expect(outsider.status).toBe(403);
    expect(outsider.body.error.code).toBe('DOMAIN_NOT_ALLOWED');

    const res = await ctx
      .agent()
      .post('/api/auth/signup')
      .send({ name: 'Casey Staff', email: 'casey@company.com', password: PASSWORD });
    expect(res.status).toBe(202);
    const [mail] = await emails(ctx.db, { to: 'casey@company.com', kind: 'verify_email' });
    expect(
      (
        await ctx
          .agent()
          .post('/api/auth/login')
          .send({ email: 'casey@company.com', password: PASSWORD })
      ).status,
    ).toBe(403);
    const agent = ctx.agent();
    const verified = await agent
      .post('/api/auth/verify-email')
      .send({ token: tokenIn(mail!, '/verify-email') });
    expect(verified.body.user).toMatchObject({ role: 'member', tierId: null });
  });

  it('emails the owner instead of revealing an existing account', async () => {
    const res = await ctx
      .agent()
      .post('/api/auth/signup')
      .send({ name: 'Dup', email: 'casey@company.com', password: 'other password' });
    expect(res.status).toBe(202);
    const sent = await emails(ctx.db, { to: 'casey@company.com' });
    expect(sent.map((e) => e.kind)).toEqual(['account_exists']);
    const { rows } = await ctx.db.query(
      "SELECT count(*)::int AS n FROM users WHERE email = 'casey@company.com'",
    );
    expect(rows[0].n).toBe(1);
  });
});
