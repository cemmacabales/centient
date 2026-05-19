/*
  Warnings:

  - A unique constraint covering the columns `[campaignId,prompt]` on the table `tasks` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "tasks_campaignId_prompt_key" ON "tasks"("campaignId", "prompt");
