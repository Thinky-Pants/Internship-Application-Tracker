ALTER TABLE "messages" ADD COLUMN "provider_draft_fingerprint" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "provider_draft_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "scheduled_sends" ADD COLUMN "phase" text DEFAULT 'queued' NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_sends" ADD COLUMN "cancel_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "scheduled_sends" ADD COLUMN "reconcile_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_sends" ADD COLUMN "resolution_required" boolean DEFAULT false NOT NULL;