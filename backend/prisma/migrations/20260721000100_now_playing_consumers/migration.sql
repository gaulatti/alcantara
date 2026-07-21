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

CREATE UNIQUE INDEX "NowPlayingConsumer_programStateId_name_key" ON "NowPlayingConsumer"("programStateId", "name");
CREATE UNIQUE INDEX "NowPlayingConsumer_programStateId_position_key" ON "NowPlayingConsumer"("programStateId", "position");

ALTER TABLE "NowPlayingConsumer" ADD CONSTRAINT "NowPlayingConsumer_programStateId_fkey" FOREIGN KEY ("programStateId") REFERENCES "ProgramState"("id") ON DELETE CASCADE ON UPDATE CASCADE;
