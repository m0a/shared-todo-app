import { Hono } from 'hono';
import { getSignedCookie, setSignedCookie, deleteCookie } from 'hono/cookie';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { users, credentials } from '../db/schema';

import { isoBase64URL } from '@simplewebauthn/server/helpers';

const SESSION_COOKIE = 'session';
const CHALLENGE_COOKIE = 'webauthn_challenge';
const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30日

// RP ID / origin はリクエストのHostから導出する。
// localhost(テスト)・Tailscaleドメイン(開発)・workers.dev(本番)のどれでも動くようにするため
function rpFromRequest(url: string): { rpID: string; origin: string } {
  const u = new URL(url);
  return { rpID: u.hostname, origin: u.origin };
}

async function getSessionUserId(c: { req: { raw: Request } } & any, secret: string): Promise<string | null> {
  const v = await getSignedCookie(c, secret, SESSION_COOKIE);
  return v || null;
}

export function createAuthApp() {
  return new Hono<{ Bindings: Env }>()
    // ---- 登録 ----
    .post(
      '/register/options',
      zValidator('json', z.object({ displayName: z.string().min(1).max(50) })),
      async (c) => {
        const { displayName } = c.req.valid('json');
        const { rpID } = rpFromRequest(c.req.url);
        const userId = nanoid();
        const options = await generateRegistrationOptions({
          rpName: 'Shared Todo',
          rpID,
          userID: new TextEncoder().encode(userId),
          userName: displayName,
          attestationType: 'none',
          authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
        });
        await setSignedCookie(
          c,
          CHALLENGE_COOKIE,
          JSON.stringify({ challenge: options.challenge, userId, displayName }),
          c.env.SESSION_SECRET,
          { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 300 },
        );
        return c.json(options);
      },
    )
    .post('/register/verify', async (c) => {
      const body = (await c.req.json()) as RegistrationResponseJSON;
      const stored = await getSignedCookie(c, c.env.SESSION_SECRET, CHALLENGE_COOKIE);
      if (!stored) return c.json({ error: 'challenge expired' }, 400);
      const { challenge, userId, displayName } = JSON.parse(stored) as {
        challenge: string;
        userId: string;
        displayName: string;
      };
      const { rpID, origin } = rpFromRequest(c.req.url);

      const verification = await verifyRegistrationResponse({
        response: body,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
      });
      if (!verification.verified || !verification.registrationInfo) {
        return c.json({ error: 'verification failed' }, 400);
      }

      const { credential } = verification.registrationInfo;
      const db = drizzle(c.env.DB);
      const now = Date.now();
      await db.batch([
        db.insert(users).values({ id: userId, displayName, createdAt: now }),
        db.insert(credentials).values({
          id: credential.id,
          userId,
          publicKey: isoBase64URL.fromBuffer(credential.publicKey),
          counter: credential.counter,
          transports: JSON.stringify(credential.transports ?? []),
          createdAt: now,
        }),
      ]);

      deleteCookie(c, CHALLENGE_COOKIE, { path: '/' });
      await setSignedCookie(c, SESSION_COOKIE, userId, c.env.SESSION_SECRET, {
        httpOnly: true,
        sameSite: 'Lax',
        path: '/',
        maxAge: SESSION_MAX_AGE,
      });
      return c.json({ ok: true, displayName });
    })

    // ---- ログイン ----
    .post('/login/options', async (c) => {
      const { rpID } = rpFromRequest(c.req.url);
      const options = await generateAuthenticationOptions({ rpID, userVerification: 'preferred' });
      await setSignedCookie(
        c,
        CHALLENGE_COOKIE,
        JSON.stringify({ challenge: options.challenge }),
        c.env.SESSION_SECRET,
        { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 300 },
      );
      return c.json(options);
    })
    .post('/login/verify', async (c) => {
      const body = (await c.req.json()) as AuthenticationResponseJSON;
      const stored = await getSignedCookie(c, c.env.SESSION_SECRET, CHALLENGE_COOKIE);
      if (!stored) return c.json({ error: 'challenge expired' }, 400);
      const { challenge } = JSON.parse(stored) as { challenge: string };
      const { rpID, origin } = rpFromRequest(c.req.url);

      const db = drizzle(c.env.DB);
      const [cred] = await db.select().from(credentials).where(eq(credentials.id, body.id));
      if (!cred) return c.json({ error: 'unknown credential' }, 400);

      const verification = await verifyAuthenticationResponse({
        response: body,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: {
          id: cred.id,
          publicKey: isoBase64URL.toBuffer(cred.publicKey),
          counter: cred.counter,
          transports: cred.transports ? JSON.parse(cred.transports) : undefined,
        },
      });
      if (!verification.verified) return c.json({ error: 'verification failed' }, 400);

      await db
        .update(credentials)
        .set({ counter: verification.authenticationInfo.newCounter })
        .where(eq(credentials.id, cred.id));

      deleteCookie(c, CHALLENGE_COOKIE, { path: '/' });
      await setSignedCookie(c, SESSION_COOKIE, cred.userId, c.env.SESSION_SECRET, {
        httpOnly: true,
        sameSite: 'Lax',
        path: '/',
        maxAge: SESSION_MAX_AGE,
      });
      const [user] = await db.select().from(users).where(eq(users.id, cred.userId));
      return c.json({ ok: true, displayName: user?.displayName ?? '' });
    })

    // ---- セッション ----
    .get('/me', async (c) => {
      const userId = await getSessionUserId(c, c.env.SESSION_SECRET);
      if (!userId) return c.json({ user: null });
      const db = drizzle(c.env.DB);
      const [user] = await db.select().from(users).where(eq(users.id, userId));
      if (!user) return c.json({ user: null });
      return c.json({ user: { id: user.id, displayName: user.displayName } });
    })
    .post('/logout', (c) => {
      deleteCookie(c, SESSION_COOKIE, { path: '/' });
      return c.json({ ok: true });
    });
}

export { getSessionUserId };
