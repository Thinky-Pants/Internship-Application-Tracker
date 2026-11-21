-- Append-only tables: reject UPDATE so approved content, CV bytes and the
-- transition log cannot be rewritten in place. (DELETE remains possible only
-- through owner-level cascades, e.g. full account removal.)
CREATE OR REPLACE FUNCTION reject_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER message_revisions_immutable BEFORE UPDATE ON message_revisions FOR EACH ROW EXECUTE FUNCTION reject_update();
--> statement-breakpoint
CREATE TRIGGER document_versions_immutable BEFORE UPDATE ON document_versions FOR EACH ROW EXECUTE FUNCTION reject_update();
--> statement-breakpoint
CREATE TRIGGER queue_events_immutable BEFORE UPDATE ON queue_events FOR EACH ROW EXECUTE FUNCTION reject_update();
--> statement-breakpoint
CREATE TRIGGER audit_events_immutable BEFORE UPDATE ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_update();
--> statement-breakpoint
-- Approvals may only be revoked (revoked_at/revoke_reason set once), never re-pointed.
CREATE OR REPLACE FUNCTION approvals_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.revision_id <> OLD.revision_id OR NEW.content_hash <> OLD.content_hash OR NEW.message_id <> OLD.message_id OR NEW.mailbox_id <> OLD.mailbox_id THEN
    RAISE EXCEPTION 'approvals cannot be re-pointed to other content';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'approval revocation is final';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER approvals_guard_trg BEFORE UPDATE ON approvals FOR EACH ROW EXECUTE FUNCTION approvals_guard();
