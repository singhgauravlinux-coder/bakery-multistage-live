-- Notifications can now be rendered from a named HTML template instead of a
-- raw body. `template` selects the renderer (see
-- services/notification-service/lib/templates.js) and `payload` carries the
-- data it needs. Rendering happens in the worker at delivery time, not at
-- enqueue time, so a template fix reaches jobs that are already queued.
ALTER TABLE notification_jobs ADD COLUMN IF NOT EXISTS template TEXT;
ALTER TABLE notification_jobs ADD COLUMN IF NOT EXISTS payload JSONB;

