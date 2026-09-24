-- The PDF bytes move into the database so they survive hosts with ephemeral disks
-- (Render's free plan empties storage/ on every deploy and wake-from-sleep).
-- Nullable: records uploaded before this column existed have no recoverable bytes.
ALTER TABLE "SourceDocument" ADD COLUMN "content" BYTEA;
