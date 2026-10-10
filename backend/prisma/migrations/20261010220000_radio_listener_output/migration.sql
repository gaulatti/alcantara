-- Nullable and additive: existing stations keep their playback configuration.
ALTER TABLE "RadioSettings" ADD COLUMN "listenerUrl" TEXT;
