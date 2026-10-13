-- CreateTable
CREATE TABLE "student_registrations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "token" TEXT NOT NULL,
    "course_id" INTEGER NOT NULL,
    "local_student_id" INTEGER NOT NULL,
    "pai_student_id" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "name" TEXT NOT NULL,
    "nick_name" TEXT NOT NULL,
    "document" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "owner_name" TEXT,
    "owner_document" TEXT,
    "note" TEXT,
    "error_message" TEXT,
    "source_agent_key" TEXT NOT NULL,
    "resolved_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "student_registrations_token_key" ON "student_registrations"("token");

-- CreateIndex
CREATE INDEX "student_registrations_status_idx" ON "student_registrations"("status");
