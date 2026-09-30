-- CreateTable
CREATE TABLE "ticket_transfers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "student_id" INTEGER NOT NULL,
    "course_id" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requested_name" TEXT NOT NULL,
    "requested_email" TEXT NOT NULL,
    "requested_phone" TEXT NOT NULL,
    "requested_document" TEXT,
    "requested_nick_name" TEXT,
    "requested_note" TEXT,
    "error_message" TEXT,
    "source_agent_key" TEXT NOT NULL,
    "resolved_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "ticket_transfers_status_idx" ON "ticket_transfers"("status");

-- CreateIndex
CREATE INDEX "ticket_transfers_student_id_idx" ON "ticket_transfers"("student_id");
