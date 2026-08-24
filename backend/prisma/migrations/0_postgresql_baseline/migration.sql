-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Layout" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "componentType" TEXT NOT NULL,
    "settings" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Layout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Scene" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "layoutId" INTEGER NOT NULL,
    "chyronText" TEXT,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Scene_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgramState" (
    "id" SERIAL NOT NULL,
    "programId" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'tv',
    "activeSceneId" INTEGER,
    "songSequence" JSONB,
    "shuffleOrder" JSONB,
    "engineState" JSONB,
    "audioMixer" JSONB,
    "activeFlightSequenceId" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProgramState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FlightSequence" (
    "id" SERIAL NOT NULL,
    "programStateId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "loop" BOOLEAN NOT NULL DEFAULT false,
    "isRunning" BOOLEAN NOT NULL DEFAULT false,
    "activeItemId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FlightSequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgramScene" (
    "id" SERIAL NOT NULL,
    "programStateId" INTEGER NOT NULL,
    "sceneId" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "ProgramScene_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BroadcastSettings" (
    "id" INTEGER NOT NULL,
    "timeOverrideEnabled" BOOLEAN NOT NULL DEFAULT false,
    "timeOverrideStartTime" TEXT,
    "timeOverrideStartedAt" TIMESTAMP(3),
    "mixerChannels" JSONB,
    "mainMasterVolume" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "songMasterVolume" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "instantMasterVolume" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "streamMasterVolume" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "songMuted" BOOLEAN NOT NULL DEFAULT false,
    "instantMuted" BOOLEAN NOT NULL DEFAULT false,
    "streamMuted" BOOLEAN NOT NULL DEFAULT false,
    "songSolo" BOOLEAN NOT NULL DEFAULT false,
    "instantSolo" BOOLEAN NOT NULL DEFAULT false,
    "streamSolo" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BroadcastSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Instant" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "audioUrl" TEXT NOT NULL,
    "volume" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Instant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Song" (
    "id" SERIAL NOT NULL,
    "artist" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "audioUrl" TEXT NOT NULL,
    "coverUrl" TEXT,
    "durationMs" INTEGER,
    "earoneSongId" TEXT,
    "earoneRank" TEXT,
    "earoneSpins" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Song_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Media" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaGroup" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaGroupItem" (
    "id" SERIAL NOT NULL,
    "mediaGroupId" INTEGER NOT NULL,
    "mediaId" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "MediaGroupItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgramMediaGroup" (
    "id" SERIAL NOT NULL,
    "programStateId" INTEGER NOT NULL,
    "mediaGroupId" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "ProgramMediaGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Stinger" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "videoUrl" TEXT NOT NULL,
    "cutPointMs" INTEGER NOT NULL DEFAULT 1000,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Stinger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgramStinger" (
    "id" SERIAL NOT NULL,
    "programStateId" INTEGER NOT NULL,
    "stingerId" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "ProgramStinger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RadioSettings" (
    "id" SERIAL NOT NULL,
    "programStateId" INTEGER NOT NULL,
    "palazzoUrl" TEXT NOT NULL DEFAULT 'http://palazzo:3100',
    "bumperEnabled" BOOLEAN NOT NULL DEFAULT false,
    "bumperInterval" INTEGER,
    "bumperInstantIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "bumperMode" TEXT NOT NULL DEFAULT 'sequential',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RadioSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NowPlayingConsumer" (
    "id" SERIAL NOT NULL,
    "programStateId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'POST',
    "headers" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NowPlayingConsumer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Layout_name_key" ON "Layout"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ProgramState_programId_key" ON "ProgramState"("programId");

-- CreateIndex
CREATE UNIQUE INDEX "FlightSequence_programStateId_name_key" ON "FlightSequence"("programStateId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ProgramScene_programStateId_sceneId_key" ON "ProgramScene"("programStateId", "sceneId");

-- CreateIndex
CREATE UNIQUE INDEX "ProgramScene_programStateId_position_key" ON "ProgramScene"("programStateId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "Instant_position_key" ON "Instant"("position");

-- CreateIndex
CREATE UNIQUE INDEX "MediaGroup_name_key" ON "MediaGroup"("name");

-- CreateIndex
CREATE UNIQUE INDEX "MediaGroupItem_mediaGroupId_mediaId_key" ON "MediaGroupItem"("mediaGroupId", "mediaId");

-- CreateIndex
CREATE UNIQUE INDEX "MediaGroupItem_mediaGroupId_position_key" ON "MediaGroupItem"("mediaGroupId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "ProgramMediaGroup_programStateId_mediaGroupId_key" ON "ProgramMediaGroup"("programStateId", "mediaGroupId");

-- CreateIndex
CREATE UNIQUE INDEX "ProgramMediaGroup_programStateId_position_key" ON "ProgramMediaGroup"("programStateId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "ProgramStinger_programStateId_stingerId_key" ON "ProgramStinger"("programStateId", "stingerId");

-- CreateIndex
CREATE UNIQUE INDEX "ProgramStinger_programStateId_position_key" ON "ProgramStinger"("programStateId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "RadioSettings_programStateId_key" ON "RadioSettings"("programStateId");

-- CreateIndex
CREATE UNIQUE INDEX "NowPlayingConsumer_programStateId_name_key" ON "NowPlayingConsumer"("programStateId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "NowPlayingConsumer_programStateId_position_key" ON "NowPlayingConsumer"("programStateId", "position");

-- AddForeignKey
ALTER TABLE "Scene" ADD CONSTRAINT "Scene_layoutId_fkey" FOREIGN KEY ("layoutId") REFERENCES "Layout"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgramState" ADD CONSTRAINT "ProgramState_activeSceneId_fkey" FOREIGN KEY ("activeSceneId") REFERENCES "Scene"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FlightSequence" ADD CONSTRAINT "FlightSequence_programStateId_fkey" FOREIGN KEY ("programStateId") REFERENCES "ProgramState"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgramScene" ADD CONSTRAINT "ProgramScene_programStateId_fkey" FOREIGN KEY ("programStateId") REFERENCES "ProgramState"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgramScene" ADD CONSTRAINT "ProgramScene_sceneId_fkey" FOREIGN KEY ("sceneId") REFERENCES "Scene"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaGroupItem" ADD CONSTRAINT "MediaGroupItem_mediaGroupId_fkey" FOREIGN KEY ("mediaGroupId") REFERENCES "MediaGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaGroupItem" ADD CONSTRAINT "MediaGroupItem_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "Media"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgramMediaGroup" ADD CONSTRAINT "ProgramMediaGroup_programStateId_fkey" FOREIGN KEY ("programStateId") REFERENCES "ProgramState"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgramMediaGroup" ADD CONSTRAINT "ProgramMediaGroup_mediaGroupId_fkey" FOREIGN KEY ("mediaGroupId") REFERENCES "MediaGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgramStinger" ADD CONSTRAINT "ProgramStinger_programStateId_fkey" FOREIGN KEY ("programStateId") REFERENCES "ProgramState"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgramStinger" ADD CONSTRAINT "ProgramStinger_stingerId_fkey" FOREIGN KEY ("stingerId") REFERENCES "Stinger"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RadioSettings" ADD CONSTRAINT "RadioSettings_programStateId_fkey" FOREIGN KEY ("programStateId") REFERENCES "ProgramState"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NowPlayingConsumer" ADD CONSTRAINT "NowPlayingConsumer_programStateId_fkey" FOREIGN KEY ("programStateId") REFERENCES "ProgramState"("id") ON DELETE CASCADE ON UPDATE CASCADE;

