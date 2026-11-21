CREATE TABLE "company_external_ids" (
	"owner_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"value" text NOT NULL,
	"source_sheet" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_external_ids_owner_id_value_pk" PRIMARY KEY("owner_id","value")
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "engineering_location" text;--> statement-breakpoint
ALTER TABLE "company_external_ids" ADD CONSTRAINT "company_external_ids_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_external_ids" ADD CONSTRAINT "company_external_ids_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "extid_company_idx" ON "company_external_ids" USING btree ("company_id");