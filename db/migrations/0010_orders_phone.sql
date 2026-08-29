-- Optional contact number, collected at checkout for bike deliveries so
-- delivery-service can fan out SMS delivery updates (rider picked up,
-- delivered) alongside the existing email notification. Never required,
-- never used for anything auth-related — purely a notification channel.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS phone TEXT;

