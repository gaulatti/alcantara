/*
    Warnings:

    - You are about to drop the column `engineState` on the `ProgramState` table, which is not recoverable. The column is obsolete: it is neither read nor written by the current radio engine, and live playback state must not be persisted in Alcantara.

*/
-- AlterTable
ALTER TABLE "ProgramState" DROP COLUMN IF EXISTS "engineState";
