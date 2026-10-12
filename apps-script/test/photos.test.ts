// Google profile pictures: looked up in the company directory, stored on the
// person, and sent to the page in bootstrap so it can show them over initials.
import { beforeAll, describe, expect, it } from 'vitest';
import { runHourlyJobs } from '../src/services/jobs';
import { photoOf, sizedPhotoUrl } from '../src/services/photos';
import { activate } from './emulator';
import { createTestContext, createUser, login, type Agent, type TestContext } from './helpers';

let ctx: TestContext;
let ana: Agent;
let admin: Agent;
const people: Record<'admin' | 'ana' | 'bo', { id: string; email: string }> = {} as never;

const PIC = 'https://lh3.googleusercontent.com/a/ana=s100';
const SIZED = 'https://lh3.googleusercontent.com/a/ana=s96-c';

const hourly = () => {
  activate(ctx.env);
  runHourlyJobs();
};
const photos = async (who: Agent) =>
  ((await who.get('/api/bootstrap').expect(200)).body as { photos?: Record<string, string> }).photos;

beforeAll(async () => {
  ctx = await createTestContext();
  people.admin = await createUser(ctx.db, { name: 'Robin Admin', role: 'admin' });
  people.ana = await createUser(ctx.db, { name: 'Ana Ortiz' });
  people.bo = await createUser(ctx.db, { name: 'Bo Lee' });
  [admin, ana] = [ctx.agent(), ctx.agent()];
  await login(admin, people.admin.email);
});

describe('profile pictures', () => {
  it('asks Google for a small square crop, and ignores the default silhouette', () => {
    expect(sizedPhotoUrl(PIC)).toBe(SIZED);
    expect(sizedPhotoUrl('https://example.com/p.jpg')).toBe('https://example.com/p.jpg');
    expect(photoOf({ photos: [{ url: PIC, default: true }] })).toBeNull();
    expect(photoOf({ photos: [{ url: PIC }] })).toBe(SIZED);
    expect(photoOf(undefined)).toBeNull();
  });

  it("fetches someone's picture the first time they open the app", async () => {
    ctx.env.directory.set(people.ana.email, PIC);
    await login(ana, people.ana.email);
    expect(await photos(ana)).toEqual({ [people.ana.id]: SIZED });
  });

  it('shows everyone on the team the same pictures', async () => {
    expect(await photos(admin)).toEqual({ [people.ana.id]: SIZED });
  });

  it('picks up pictures for people who have not opened the app yet, in the hourly job', async () => {
    ctx.env.directory.set(people.bo.email, 'https://lh3.googleusercontent.com/a/bo=s64-c');
    hourly();
    expect(await photos(admin)).toEqual({
      [people.ana.id]: SIZED,
      [people.bo.id]: 'https://lh3.googleusercontent.com/a/bo=s96-c',
    });
  });

  it('leaves out people with only the default picture', async () => {
    const cy = await createUser(ctx.db, { name: 'Cy Doe' });
    ctx.env.directory.set(cy.email, null);
    hourly();
    expect((await photos(admin))?.[cy.id]).toBeUndefined();
  });

  it("falls back to the app account's contacts when the directory is not shared", async () => {
    const ed = await createUser(ctx.db, { name: 'Ed Ray' });
    ctx.env.directoryDown = 'The G Suite domain admin has disabled external directory sharing.';
    ctx.env.contacts.set(ed.email, 'https://lh3.googleusercontent.com/a/ed=s64');
    hourly();
    expect((await photos(admin))?.[ed.id]).toBe('https://lh3.googleusercontent.com/a/ed=s96-c');
    ctx.env.directoryDown = null;
    ctx.env.contacts.clear();
  });

  it('keeps the page working, with initials, when no source can be read', async () => {
    const di = await createUser(ctx.db, { name: 'Di Park' });
    ctx.env.directoryDown = 'Not a valid scope: directory.readonly';
    ctx.env.contactsDown = 'Not a valid scope: contacts.other.readonly';
    hourly();
    const agent = ctx.agent();
    await login(agent, di.email);
    expect((await photos(agent))?.[di.id]).toBeUndefined();
    // A failed lookup isn't remembered as "checked": the next run tries again.
    ctx.env.directoryDown = null;
    ctx.env.contactsDown = null;
    ctx.env.directory.set(di.email, 'https://lh3.googleusercontent.com/a/di=s100');
    hourly();
    expect((await photos(agent))?.[di.id]).toBe('https://lh3.googleusercontent.com/a/di=s96-c');
  });
});
