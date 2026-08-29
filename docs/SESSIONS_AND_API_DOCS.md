# Sessions, refresh tokens and API-docs hosting

Two changes are covered here:

1. **Refresh tokens + session timeout** — the storefront no longer holds a
   24-hour bearer token, and no screen depends on the user pressing reload.
2. **`/api/docs` is off the public API host** — Swagger UI moved to its own
   listener, Service and Ingress.

---

## 1. Session model

### What changed

Previously `/auth/login` issued a single JWT valid for 24 hours. The browser
stored it and nothing ever re-checked it, so:

- an expired token surfaced as a random failure mid-flow;
- logout could not actually end anything (the token stayed valid);
- the email-verification state was read once at page load, which is why
  verifying required a manual refresh.

Now:

| Token | Lifetime | Purpose |
| --- | --- | --- |
| Access token (JWT, HS256) | `AUTH_ACCESS_TOKEN_TTL_MS` (15 min) | Sent as `Authorization: Bearer`. Carries a `sid` claim binding it to a session row. |
| Refresh token (opaque) | `AUTH_REFRESH_TOKEN_TTL_MS` (7 days) | `POST /auth/refresh` exchanges it for a new access token. Single-use — every call rotates it. |

Two deadlines end a session, whichever comes first:

- **Idle** — `AUTH_SESSION_IDLE_TIMEOUT_MS` (30 min) since the last refresh.
- **Absolute** — `AUTH_SESSION_ABSOLUTE_TTL_MS` (12 h) since sign-in.

Both are enforced server-side on every `/auth/refresh`; the client-side
countdown is a convenience, not the control.

### Storage

Sessions live in `auth_sessions` (`db/migrations/0009_auth_sessions.sql`;
auth-service also applies the DDL itself at boot, like the other security
tables). Only the SHA-256 of the refresh secret is stored, so a dump of the
table cannot be replayed.

The refresh token is formatted `<sessionId>.<secret>`. The session id travels
in the clear deliberately: when an already-rotated token is presented we can
still find the session and revoke it.

### Reuse detection

A successful refresh rotates the secret. Presenting a consumed token means
either a replay or a stolen copy racing the real client — either way the
session is revoked immediately and the response is
`401 { reason: 'refresh_token_reuse' }`. This is the OAuth 2.0 Security BCP
behaviour for public clients.

### What revokes a session

| Trigger | `revoked_reason` |
| --- | --- |
| `POST /auth/logout` | `logout` |
| `POST /auth/logout-all` | `logout_all` |
| Idle deadline passed | `session_idle_timeout` |
| Absolute deadline passed | `session_absolute_timeout` |
| Consumed refresh token replayed | `refresh_token_reuse` |
| Password reset via emailed link | `password_reset` |
| Password changed while signed in | `password_changed` |

Note the honest limitation: revocation kills the *refresh* token instantly,
but an already-issued access token stays valid for its remaining minutes,
because verifying it is stateless. That is exactly why the access TTL is 15
minutes rather than a day. Checking revocation on every request would mean a
database round-trip per API call — if you need that, add a Redis deny-list
keyed on `sid`.

### Browser behaviour

- Renews the access token roughly a minute before expiry, but **only if the
  person has been active in the last 5 minutes** — otherwise the timer alone
  would keep the server-side session alive forever and the idle timeout would
  never fire.
- Single-flight: concurrent requests share one refresh call. Two parallel
  exchanges of a single-use token would look like a replay.
- Shows a "Still there?" dialog 60 seconds before the idle cut-off, with
  *Keep me signed in* / *Sign out now*.
- Returning to a background tab is deliberately **not** counted as activity —
  the point is to notice a session that died while the tab sat idle.
- `BroadcastChannel` + the `storage` event keep every open tab in sync, so
  signing out (or verifying) in one tab updates the rest.

### Testing it quickly

```bash
AUTH_SESSION_IDLE_TIMEOUT_MS=60000 docker compose up -d auth-service
```

Sign in, leave the tab alone, and the warning appears at 60 s. `npm test` in
`services/auth-service` covers rotation, reuse detection, the idle timeout,
revocation on logout and the verification-status flip.

---

## 2. Email verification without a manual refresh

The old flow had no UI at all — verification state was whatever the page
happened to load with.

- `POST /auth/verify-email/request` emails `<APP_BASE_URL>/?verify=<token>`.
- The SPA reads `?verify=` on load, confirms it, strips the token from the
  address bar with `history.replaceState` (so a reload or a leaked `Referer`
  can't replay it) and updates the badge in place.
- While the address is unverified and the account panel is open, the panel
  polls `GET /auth/verify-email/status` every `AUTH_VERIFY_POLL_INTERVAL_MS`.
  Clicking the link in a mail client flips the badge on its own.
- Polling uses the non-renewing request path on purpose, so it cannot keep a
  session alive by itself. It is also bounded to 15 minutes per open.

**`APP_BASE_URL` must be set per environment** or the emailed link points at
the wrong stack. The dev and uat overlays patch it to
`http://dev.bakery.local` and `http://uat.bakery.local`.

---

## 3. API docs on a separate Ingress

`/api/docs` is no longer mounted on the gateway's public listener. Anything
that could reach the API could previously read the entire API surface, and
there was no way to protect the docs without also protecting `/api`.

**Now:**

- api-gateway runs a second, independent Express app on `DOCS_PORT` (3100)
  serving `/api/docs`, `/docs`, `/openapi.json` and its own `/health`. It has
  **no proxy routes**, so the worst case if it leaks is that someone reads the
  spec — not that they reach an upstream service.
- The main listener returns `404` for `/api/docs` and `/api/openapi.json`,
  registered *before* the `/api` proxy so those paths can never be forwarded
  upstream either.
- Service `api-docs` (port 3100) and Ingress `bakery-docs-ingress`
  (`k8s/base/ingress/api-docs-ingress.yaml`) publish it on its own host.

| Environment | Docs host |
| --- | --- |
| dev | `docs.dev.bakery.local` |
| uat | `docs.uat.bakery.local` |
| production | not deployed — the prod overlay doesn't include `../../base/ingress` |
| docker compose | `http://localhost:3100/api/docs` |

### Managing it yourself

To use your own Ingress instead, drop `api-docs-ingress.yaml` from
`k8s/base/ingress/kustomization.yaml` and point your own object at the
`api-docs` Service on port 3100. Nothing else needs to change.

To turn the docs off entirely, set `DOCS_SERVER_ENABLED=false` on the gateway
Deployment — the port stops listening and the Ingress 502s.

### Protecting it

A Traefik `basicAuth` Middleware named `docs-basic-auth` ships alongside the
Ingress, with the annotation commented out so the manifest applies cleanly
without a secret. To enable:

```bash
htpasswd -nb docs 'a-strong-password'
kubectl -n bakery-dev create secret generic docs-basic-auth \
  --from-literal=users='docs:$apr1$....'
```

then uncomment the `router.middlewares` line in `api-docs-ingress.yaml`
(adjust the namespace prefix: `bakery-dev-docs-basic-auth@kubernetescrd`).

The `authelia-forwardauth` middleware already used for the Adminer Ingress is
an equally good fit if you'd rather have SSO.

### Escape hatch

`API_DOCS_ON_GATEWAY=true` restores the old inline `/api/docs` for local work.
The gateway logs a warning at startup when it is on.

