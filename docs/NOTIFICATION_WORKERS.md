# Notification workers

`notification-service` is split into a producer and a consumer that share one
image and one CI pipeline:

| Process | Entrypoint | Deployment | Traffic |
|---|---|---|---|
| API (producer) | `node server.js` | `notification-service` | HTTP :3010 |
| Worker (consumer) | `node worker.js` | `notification-worker` | none — probes only, :3110 |

`POST /notify/email` and `POST /notify/sms` validate the request, INSERT a row
into `notification_jobs`, and return `202` with a `jobId`. Workers claim rows
and talk to the providers. The `202` is now honest: a queued job survives an
API pod restart, and a slow provider can no longer stall a caller's request.

## Why a separate Deployment

Delivery throughput and API throughput have nothing to do with each other. A
provider outage should back up the queue, not the checkout path. Splitting them
lets each scale — and fail — on its own, and keeps a long retry ladder off the
request thread.

## How concurrency is kept safe

Workers claim with `FOR UPDATE SKIP LOCKED`, so a row locked by one replica is
stepped over rather than waited on. Two pods never get the same job, and
raising `replicas` raises throughput roughly linearly. Verified with two
workers against 40 jobs: 20/20 split, 40 deliveries, 40 unique.

Delivery is **at-least-once**. If a pod dies mid-send, its rows sit in
`processing` until another worker's stale-lock sweep requeues them
(`WORKER_STALE_LOCK_SECONDS`, default 300). Keep the provider calls idempotent.

## Failure handling

Failures fall into three classes, because treating them alike loses mail:

| Class | Examples | Behaviour | Log event |
|---|---|---|---|
| Permanent | invalid recipient, unknown channel, SMTP 5xx (550/553/554) | dead-lettered on the first attempt | `notification_dead_lettered` |
| Transient | mock provider failure, SMTP 4xx (450/452 greylisting, rate limits) | backoff ladder, **attempt consumed** | `notification_retry_scheduled` |
| Infrastructure | SMTP unreachable, 421, 534/535 bad credentials | requeued, **attempt NOT consumed** | `notification_deferred` |

Backoff is exponential with full jitter (`WORKER_BACKOFF_BASE_SECONDS` →
`WORKER_BACKOFF_MAX_SECONDS`). The jitter matters: without it a provider outage
synchronises every retry in the cluster into a thundering herd.

The infrastructure class exists because a wrong App Password fails every job
identically. If that counted as a normal retry, the entire backlog would
dead-letter within a few minutes of backoff while someone was still looking for
the cause. Instead those jobs wait indefinitely and drain on their own once the
secret is corrected and the worker restarts — verified end to end.

Alert on `notification_deferred`: it means nothing is being delivered at all,
which a rising `queued` count alone will not distinguish from a traffic spike.

## Tuning

| Env var | Default | Notes |
|---|---|---|
| `WORKER_BATCH_SIZE` | 10 | rows claimed per tick |
| `WORKER_CONCURRENCY` | 5 | in-flight deliveries per replica |
| `WORKER_POLL_INTERVAL_MS` | 1000 | poll delay when work was found |
| `WORKER_IDLE_INTERVAL_MS` | 5000 | poll delay when the queue was empty |
| `WORKER_BACKOFF_BASE_SECONDS` | 5 | first-retry ceiling |
| `WORKER_BACKOFF_MAX_SECONDS` | 900 | backoff cap |
| `WORKER_STALE_LOCK_SECONDS` | 300 | age at which a locked job is reclaimed |
| `WORKER_SHUTDOWN_GRACE_MS` | 15000 | drain window on SIGTERM |
| `NOTIFY_FAILURE_RATE` | 0 | mock provider failure rate; ignored once `SMTP_HOST` is set |
| `SMTP_HOST` | *(unset)* | unset = email is mocked, not sent |
| `SMTP_PORT` | 587 | 587 STARTTLS, 465 implicit TLS, 1025 Mailpit |
| `SMTP_SECURE` | auto | defaults to true only on port 465 |
| `SMTP_USER` / `SMTP_PASS` | *(unset)* | omit both for an unauthenticated relay like Mailpit |
| `SMTP_FROM` | Crumb & Ember no-reply | ignored by Gmail, which rewrites it |
| `SMTP_MAX_CONNECTIONS` | 1 | pool size; keep at 1 for Gmail |

Replica counts are set per overlay. The overlays apply a blanket
`replicas: 1` patch to every Deployment labelled
`app.kubernetes.io/part-of=crumb-and-ember`, so `notification-worker` carries
its own patch *after* that one (dev 1, uat 2, production 2).

## Operating

```bash
# queue depth by status — alert on rising `queued` or any `dead`
curl http://localhost:3010/notify/queue/stats

# where did one notification get to?
curl http://localhost:3010/notify/jobs/ntf-abc123

# worker health (probe port, not routed through the gateway)
kubectl -n bakery-prod port-forward deploy/notification-worker 3110:3110
curl http://localhost:3110/ready
```

Every worker log line carries the `traceId` of the request that queued the job,
so a delivery joins straight back to the originating API call:

```bash
kubectl -n bakery-prod logs -l app=notification-worker --tail=200 \
  | grep trace-8ad8bce7
```

Exercise the retry and dead-letter paths locally:

```bash
NOTIFY_FAILURE_RATE=0.3 docker compose up --build
docker compose up --scale notification-worker=3
```

## Mail server configuration

Email sends over SMTP when `SMTP_HOST` is set and is mocked otherwise, so the
stack boots fine with no mail server at all.

**Locally** `docker compose up` starts Mailpit and points the worker at it:
a fake SMTP server that captures every message at http://localhost:8025. No
credentials, no sending limits, nothing leaves the machine. Override in `.env`
to send elsewhere.

**In Kubernetes** the settings come from a `smtp-credentials` Secret that is
applied out of band with `kubectl`, so no credential is committed or rendered
into an overlay:

```bash
cp k8s/base/secrets.smtp.example.yaml k8s/secrets-smtp.yaml   # git-ignored
$EDITOR k8s/secrets-smtp.yaml
kubectl -n bakery-dev apply -f k8s/secrets-smtp.yaml
kubectl -n bakery-dev rollout restart deploy/notification-worker
```

Every key is consumed with `optional: true`, so the worker starts before the
Secret exists — it logs `smtp_disabled` and mocks email until you create it.
Apply the Secret once per namespace you want mail from.

### Gmail as a test target

Workable for a smoke test, with limits worth knowing:

- Requires 2-Step Verification plus an App Password from
  https://myaccount.google.com/apppasswords. A normal account password is
  rejected — Google retired "less secure app" access. Strip the spaces from
  the 16 characters Google displays.
- Roughly 2,000 messages per 24 hours, and parallel sessions are throttled.
  Keep `SMTP_MAX_CONNECTIONS=1` (the manifest default) and `WORKER_CONCURRENCY`
  low. It is a smoke-test target, not a load-test target.
- Gmail rewrites `From` to the authenticated account, so `SMTP_FROM` is
  cosmetic there — don't test sender-formatting logic against it.
- A rejected password shows up at boot as `smtp_verify_failed` and then as
  `notification_deferred` per job; nothing is lost.

## Swapping in a real provider

Replace `sendEmail` / `sendSms` in `services/notification-service/lib/providers.js`.
Throw to retry; throw with `permanent: true` to dead-letter immediately. Nothing
else in the worker changes.

