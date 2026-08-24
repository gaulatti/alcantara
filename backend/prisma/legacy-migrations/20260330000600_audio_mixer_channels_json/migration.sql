ALTER TABLE "BroadcastSettings"
ADD COLUMN IF NOT EXISTS "mixerChannels" JSONB;
