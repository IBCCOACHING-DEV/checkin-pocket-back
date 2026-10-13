-- AlterTable
ALTER TABLE "students" ADD COLUMN "label_printed" BOOLEAN NOT NULL DEFAULT false;

-- Quem já foi credenciado teve a etiqueta enviada para impressão (nesta estação
-- ou em outra) — exceto quando o único print_job do aluno morreu sem imprimir.
UPDATE "students"
SET "label_printed" = true
WHERE "checked_in" = true
  AND NOT EXISTS (
    SELECT 1 FROM "print_jobs" p
    WHERE p."student_id" = "students"."id" AND p."status" = 'dead'
  );
