-- gaulatti/alcantara#424 (#222 R3): rundown recipes. Additive only: a new table keyed to a
-- program; existing rows are untouched.
CREATE TABLE "RundownRecipe" (
    "id" SERIAL NOT NULL,
    "programStateId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "bumperSceneId" INTEGER,
    "slideshowSceneId" INTEGER,
    "returnSceneId" INTEGER,
    "transitionId" TEXT NOT NULL DEFAULT 'cut',
    "holdMs" INTEGER NOT NULL DEFAULT 3000,
    "steps" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RundownRecipe_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RundownRecipe_programStateId_name_key" ON "RundownRecipe"("programStateId", "name");

ALTER TABLE "RundownRecipe" ADD CONSTRAINT "RundownRecipe_programStateId_fkey" FOREIGN KEY ("programStateId") REFERENCES "ProgramState"("id") ON DELETE CASCADE ON UPDATE CASCADE;
