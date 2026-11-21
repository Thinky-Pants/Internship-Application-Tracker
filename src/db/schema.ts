/**
 * Relational data model. See docs/ARCHITECTURE.md for the rules that derive
 * company-level summaries from these records.
 *
 * Conventions
 * - Every owned row carries owner_id (single-owner today, explicit boundary).
 * - External identifiers (workbook Company_ID, Apollo IDs, Graph IDs) are text.
 * - Immutable tables (message_revisions, document_versions, queue_events,
 *   audit_events) are append-only; a trigger in the migration rejects UPDATE.
 * - is_demo separates seeded demo data from real imports.
 */

import {
  pgTable, uuid, text, integer, boolean, timestamp, jsonb, doublePrecision, numeric,
  uniqueIndex, index, primaryKey, bigint,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const created = () => ts("created_at").notNull().defaultNow();
const updated = () => ts("updated_at").notNull().defaultNow();

// ───────────────────────── Owner, auth, settings ─────────────────────────
export const owners = pgTable("owners", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  displayName: text("display_name").notNull().default(""),
  passwordHash: text("password_hash").notNull(),
  createdAt: created(),
});

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => owners.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: ts("expires_at").notNull(),
  createdAt: created(),
  userAgent: text("user_agent"),
}, (t) => [uniqueIndex("sessions_token_idx").on(t.tokenHash)]);

export const settings = pgTable("settings", {
  ownerId: uuid("owner_id").primaryKey().references(() => owners.id, { onDelete: "cascade" }),
  displayTimezone: text("display_timezone").notNull().default("Asia/Riyadh"),
  /** {days:[1..7 ISO weekday], start:"08:00", end:"18:00"} applied in the schedule's zone. */
  sendingWindow: jsonb("sending_window").notNull().default({ days: [1, 2, 3, 4, 5], start: "07:00", end: "18:00" }),
  /** Overdue work younger than this is spread through limits; older is held for review. */
  missedSendGraceMinutes: integer("missed_send_grace_minutes").notNull().default(120),
  /** When a reply/opt-out arrives from one contact: "pause_company" | "pause_contact_only". */
  companyCoordinationPolicy: text("company_coordination_policy").notNull().default("pause_company"),
  /** Max minutes since last successful mailbox sync before follow-ups are held. */
  followupMaxSyncAgeMinutes: integer("followup_max_sync_age_minutes").notNull().default(60),
  /** Reschedule keeps approval when content & recipients unchanged. */
  keepApprovalOnReschedule: boolean("keep_approval_on_reschedule").notNull().default(true),
  globalPause: boolean("global_pause").notNull().default(false),
  globalPauseReason: text("global_pause_reason"),
  globalPausedAt: ts("global_paused_at"),
  /** Editable heuristics for contact-role suggestions. */
  roleHeuristics: jsonb("role_heuristics").notNull().default({}),
  /** Editable Today priorities. */
  todayPriorities: jsonb("today_priorities").notNull().default({}),
  /** Map tiles/geocoder config (non-secret parts). */
  mapConfig: jsonb("map_config").notNull().default({}),
  setupCompletedAt: ts("setup_completed_at"),
  updatedAt: updated(),
});

// ───────────────────────── Companies & research ─────────────────────────
export const companies = pgTable("companies", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => owners.id, { onDelete: "cascade" }),
  externalId: text("external_id"),                // e.g. workbook Company_ID / Lead_ID (text)
  name: text("name").notNull(),
  originalName: text("original_name"),
  website: text("website"),
  domain: text("domain"),                         // normalized registrable host, no www
  description: text("description"),
  sizeText: text("size_text"),
  priority: text("priority").notNull().default("other"), // primary | reserve | lead | other
  fitScore: integer("fit_score"),
  matchTier: text("match_tier"),
  industryPrimary: text("industry_primary"),
  industrySecondary: text("industry_secondary"),
  regionGroup: text("region_group"),
  country: text("country"),
  countryCode: text("country_code"),
  city: text("city"),
  engineeringLocation: text("engineering_location"),
  engineeringActivity: text("engineering_activity"),
  potentialInternWork: text("potential_intern_work"),
  internshipEvidence: text("internship_evidence"),
  careersUrl: text("careers_url"),
  opportunityUrl: text("opportunity_url"),
  eligibilityStatus: text("eligibility_status"),
  eligibilityNotes: text("eligibility_notes"),
  foundedText: text("founded_text"),
  notes: text("notes"),
  researchNotes: text("research_notes"),
  parentCompanyId: uuid("parent_company_id"),
  /** Imported, historical outreach statement — NOT provider evidence. */
  importedOutreachStatus: text("imported_outreach_status"),
  discoveryStatus: text("discovery_status").notNull().default("not_researched"),
  discoveryUpdatedAt: ts("discovery_updated_at"),
  outreachClosed: boolean("outreach_closed").notNull().default(false),
  closedReason: text("closed_reason"),
  suppressed: boolean("suppressed").notNull().default(false),
  suppressedReason: text("suppressed_reason"),
  preferredContactId: uuid("preferred_contact_id"),
  selectedCvDocumentId: uuid("selected_cv_document_id"),
  nextAction: text("next_action"),
  nextActionDue: ts("next_action_due"),
  sourceSheet: text("source_sheet"),
  sourceRow: jsonb("source_row"),                 // original imported fields, verbatim
  /** field -> {source:"import"|"manual"|"apollo"|"ai", at:ISO, batchId?} */
  fieldProvenance: jsonb("field_provenance").notNull().default({}),
  importBatchId: uuid("import_batch_id"),
  revision: integer("revision").notNull().default(1),
  isDemo: boolean("is_demo").notNull().default(false),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => [
  index("companies_owner_idx").on(t.ownerId),
  index("companies_domain_idx").on(t.ownerId, t.domain),
  uniqueIndex("companies_external_idx").on(t.ownerId, t.externalId),
]);

/** All known external IDs for a company (e.g. Company_ID and a Lead_ID for the same domain). */
export const companyExternalIds = pgTable("company_external_ids", {
  ownerId: uuid("owner_id").notNull().references(() => owners.id, { onDelete: "cascade" }),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  value: text("value").notNull(),
  sourceSheet: text("source_sheet"),
  createdAt: created(),
}, (t) => [primaryKey({ columns: [t.ownerId, t.value] }), index("extid_company_idx").on(t.companyId)]);

export const companyLocations = pgTable("company_locations", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  kind: text("kind").notNull().default("hq"),     // hq | engineering | office
  label: text("label"),
  city: text("city"),
  region: text("region"),
  country: text("country"),
  countryCode: text("country_code"),
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  precision: text("precision").notNull().default("unknown"), // address | city | country | unknown
  geocodeStatus: text("geocode_status").notNull().default("pending"), // pending | resolved | unresolved | manual
  geocodeProvider: text("geocode_provider"),
  geocodedAt: ts("geocoded_at"),
  timezone: text("timezone"),                     // IANA, suggestion only
  isPrimary: boolean("is_primary").notNull().default(false),
  createdAt: created(),
}, (t) => [index("locations_company_idx").on(t.companyId)]);

export const companyTags = pgTable("company_tags", {
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  tag: text("tag").notNull(),
  kind: text("kind").notNull().default("industry"),
}, (t) => [primaryKey({ columns: [t.companyId, t.kind, t.tag] })]);

export const companyEvidence = pgTable("company_evidence", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => owners.id, { onDelete: "cascade" }),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  externalId: text("external_id"),
  fieldSupported: text("field_supported"),
  url: text("url"),
  publisher: text("publisher"),
  publishedDate: text("published_date"),
  accessedDate: text("accessed_date"),
  summary: text("summary"),
  /** Approved facts may be used in AI drafting. */
  approvedForDrafting: boolean("approved_for_drafting").notNull().default(true),
  source: text("source").notNull().default("import"), // import | manual | ai_suggestion
  createdAt: created(),
}, (t) => [uniqueIndex("evidence_external_idx").on(t.ownerId, t.externalId), index("evidence_company_idx").on(t.companyId)]);

// ───────────────────────── Contacts & email addresses ─────────────────────────
export const contacts = pgTable("contacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => owners.id, { onDelete: "cascade" }),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  fullName: text("full_name").notNull(),
  firstName: text("first_name"),
  lastName: text("last_name"),
  title: text("title"),
  seniority: text("seniority"),
  department: text("department"),
  linkedinUrl: text("linkedin_url"),
  sourceUrl: text("source_url"),
  source: text("source").notNull().default("manual"), // manual | apollo_api | apollo_csv | website | ai_suggestion | import
  apolloPersonId: text("apollo_person_id"),
  apolloOrgId: text("apollo_org_id"),
  /** The contact's own location as reported — never copied to company location. */
  personLocation: text("person_location"),
  isPreferred: boolean("is_preferred").notNull().default(false),
  reviewStatus: text("review_status").notNull().default("candidate"), // candidate | reviewed | rejected
  suppressed: boolean("suppressed").notNull().default(false),
  notes: text("notes"),
  isDemo: boolean("is_demo").notNull().default(false),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => [
  index("contacts_company_idx").on(t.companyId),
  uniqueIndex("contacts_apollo_idx").on(t.ownerId, t.apolloPersonId),
]);

export const emailAddresses = pgTable("email_addresses", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => owners.id, { onDelete: "cascade" }),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
  address: text("address").notNull(),
  normalized: text("normalized").notNull(),
  kind: text("kind").notNull().default("named"),  // named | general | other
  source: text("source").notNull(),               // apollo_api | apollo_csv | website | manual | ai_guess | import
  sourceDetail: text("source_detail"),
  /** unknown | provider_verified | catch_all | invalid */
  quality: text("quality").notNull().default("unknown"),
  providerStatus: text("provider_status"),        // raw provider label, verbatim
  sourceVerifiedAt: ts("source_verified_at"),
  localCheckedAt: ts("local_checked_at"),
  bounceState: text("bounce_state").notNull().default("none"), // none | soft | hard
  bouncedAt: ts("bounced_at"),
  suppressed: boolean("suppressed").notNull().default(false),
  isPrimary: boolean("is_primary").notNull().default(false),
  createdAt: created(),
}, (t) => [uniqueIndex("email_norm_idx").on(t.ownerId, t.normalized), index("email_company_idx").on(t.companyId)]);

// ───────────────────────── Discovery ─────────────────────────
export const discoveryJobs = pgTable("discovery_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => owners.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),           // apollo | mock_apollo
  kind: text("kind").notNull().default("search"), // search | enrich
  status: text("status").notNull().default("pending"), // pending | running | paused | completed | cancelled
  filters: jsonb("filters").notNull().default({}),
  maxPerCompany: integer("max_per_company").notNull().default(5),
  creditBudget: numeric("credit_budget"),
  requestBudget: integer("request_budget"),
  creditsUsedActual: numeric("credits_used_actual").notNull().default("0"),
  creditsEstimated: numeric("credits_estimated").notNull().default("0"),
  requestsUsed: integer("requests_used").notNull().default(0),
  totalItems: integer("total_items").notNull().default(0),
  doneItems: integer("done_items").notNull().default(0),
  createdAt: created(),
  updatedAt: updated(),
});

export const discoveryAttempts = pgTable("discovery_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => owners.id, { onDelete: "cascade" }),
  jobId: uuid("job_id").references(() => discoveryJobs.id, { onDelete: "set null" }),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
  provider: text("provider").notNull(),
  kind: text("kind").notNull(),                   // search | enrich | csv_import | manual
  filters: jsonb("filters").notNull().default({}),
  priority: integer("priority").notNull().default(0),
  /** pending | running | completed | failed | blocked_access | blocked_budget | cancelled */
  status: text("status").notNull().default("pending"),
  /** match_found | no_match | insufficient_info | auth_error | access_denied | timeout | rate_limited | budget_exhausted | error | email_revealed | email_not_revealed */
  outcome: text("outcome"),
  errorMessage: text("error_message"),
  candidates: jsonb("candidates").notNull().default([]),
  creditsActual: numeric("credits_actual"),
  creditsEstimated: numeric("credits_estimated"),
  attemptCount: integer("attempt_count").notNull().default(0),
  retryAfter: ts("retry_after"),
  attemptedAt: ts("attempted_at"),
  completedAt: ts("completed_at"),
  createdAt: created(),
}, (t) => [index("attempts_company_idx").on(t.companyId), index("attempts_job_idx").on(t.jobId, t.status)]);

// ───────────────────────── Opportunities, campaigns, enrollments ─────────────────────────
export const opportunities = pgTable("opportunities", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => owners.id, { onDelete: "cascade" }),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
  roleTitle: text("role_title").notNull().default("Engineering internship (unspecified)"),
  locationText: text("location_text"),
  season: text("season"),
  startDate: text("start_date"),
  endDate: text("end_date"),
  deadline: text("deadline"),
  workingLanguage: text("working_language"),
  visaInfo: text("visa_info"),
  url: text("url"),
  /** prospect | applied_contacted | screening | interview | offer | rejected | withdrawn | closed */
  stage: text("stage").notNull().default("prospect"),
  nextAction: text("next_action"),
  nextActionDue: ts("next_action_due"),
  notes: text("notes"),
  isDemo: boolean("is_demo").notNull().default(false),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => [index("opps_company_idx").on(t.companyId)]);

export const campaigns = pgTable("campaigns", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => owners.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  paused: boolean("paused").notNull().default(false),
  pausedReason: text("paused_reason"),
  pausedAt: ts("paused_at"),
  isDemo: boolean("is_demo").notNull().default(false),
  createdAt: created(),
});

export const sequences = pgTable("sequences", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => owners.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** [{step:1, delayDays:5, templateId}] — delays anchor to the previous message's recorded sent time. */
  followups: jsonb("followups").notNull().default([]),
  createdAt: created(),
});

export const enrollments = pgTable("enrollments", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => owners.id, { onDelete: "cascade" }),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
  opportunityId: uuid("opportunity_id").references(() => opportunities.id, { onDelete: "set null" }),
  campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
  sequenceId: uuid("sequence_id").references(() => sequences.id, { onDelete: "set null" }),
  /** active | paused | stopped | completed */
  state: text("state").notNull().default("active"),
  stopReason: text("stop_reason"),
  pauseReason: text("pause_reason"),
  currentStep: integer("current_step").notNull().default(0),
  conversationId: uuid("conversation_id"),
  isDemo: boolean("is_demo").notNull().default(false),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => [index("enroll_company_idx").on(t.companyId)]);

// ───────────────────────── Mailboxes & sync ─────────────────────────
export const mailboxes = pgTable("mailboxes", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => owners.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),           // graph | mock
  emailAddress: text("email_address"),
  displayName: text("display_name"),
  providerUserId: text("provider_user_id"),
  tenantId: text("tenant_id"),
  /** unconfigured | connected | expired | restricted | disconnected | error */
  status: text("status").notNull().default("unconfigured"),
  statusReason: text("status_reason"),
  scopes: text("scopes"),
  accessTokenEnc: text("access_token_enc"),
  refreshTokenEnc: text("refresh_token_enc"),
  tokenExpiresAt: ts("token_expires_at"),
  dailyLimit: integer("daily_limit").notNull().default(40),
  hourlyLimit: integer("hourly_limit").notNull().default(10),
  minSpacingSeconds: integer("min_spacing_seconds").notNull().default(240),
  throttledUntil: ts("throttled_until"),
  lastSyncAt: ts("last_sync_at"),
  lastSyncError: text("last_sync_error"),
  initialSyncDays: integer("initial_sync_days").notNull().default(90),
  connectedAt: ts("connected_at"),
  isDemo: boolean("is_demo").notNull().default(false),
  createdAt: created(),
  updatedAt: updated(),
});

export const mailboxFolders = pgTable("mailbox_folders", {
  id: uuid("id").primaryKey().defaultRandom(),
  mailboxId: uuid("mailbox_id").notNull().references(() => mailboxes.id, { onDelete: "cascade" }),
  providerFolderId: text("provider_folder_id").notNull(),
  displayName: text("display_name").notNull(),
  role: text("role").notNull().default("other"),  // inbox | sentitems | junk | other
  tracked: boolean("tracked").notNull().default(true),
  deltaLink: text("delta_link"),
  lastSyncedAt: ts("last_synced_at"),
  lastError: text("last_error"),
  messageCount: integer("message_count").notNull().default(0),
}, (t) => [uniqueIndex("folder_provider_idx").on(t.mailboxId, t.providerFolderId)]);

export const mailboxSubscriptions = pgTable("mailbox_subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  mailboxId: uuid("mailbox_id").notNull().references(() => mailboxes.id, { onDelete: "cascade" }),
  providerSubscriptionId: text("provider_subscription_id").notNull(),
  resource: text("resource").notNull(),
  clientStateHash: text("client_state_hash").notNull(),
  expiresAt: ts("expires_at").notNull(),
  status: text("status").notNull().default("active"), // active | expired | removed | reauthorization_required
  lastNotificationAt: ts("last_notification_at"),
  createdAt: created(),
}, (t) => [uniqueIndex("sub_provider_idx").on(t.providerSubscriptionId)]);

export const webhookNotifications = pgTable("webhook_notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  dedupeKey: text("dedupe_key").notNull(),
  subscriptionId: text("subscription_id"),
  lifecycleEvent: text("lifecycle_event"),
  receivedAt: ts("received_at").notNull().defaultNow(),
  processedAt: ts("processed_at"),
  payload: jsonb("payload").notNull(),
}, (t) => [uniqueIndex("webhook_dedupe_idx").on(t.dedupeKey)]);

// ───────────────────────── Conversations & messages ─────────────────────────
export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => owners.id, { onDelete: "cascade" }),
  mailboxId: uuid("mailbox_id").references(() => mailboxes.id, { onDelete: "set null" }),
  companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
  contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
  opportunityId: uuid("opportunity_id").references(() => opportunities.id, { onDelete: "set null" }),
  providerConversationId: text("provider_conversation_id"),
  subject: text("subject"),
  lastMessageAt: ts("last_message_at"),
  /** matched | ambiguous | unmatched | manual */
  matchStatus: text("match_status").notNull().default("matched"),
  matchReason: text("match_reason"),
  unreadCount: integer("unread_count").notNull().default(0),
  summary: text("summary"),
  isDemo: boolean("is_demo").notNull().default(false),
  createdAt: created(),
}, (t) => [index("conv_provider_idx").on(t.mailboxId, t.providerConversationId)]);

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => owners.id, { onDelete: "cascade" }),
  mailboxId: uuid("mailbox_id").references(() => mailboxes.id, { onDelete: "set null" }),
  conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
  enrollmentId: uuid("enrollment_id").references(() => enrollments.id, { onDelete: "set null" }),
  companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
  contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
  campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
  direction: text("direction").notNull(),         // outbound | inbound
  /** initial | followup | reply | inbound | external_sent | historical */
  kind: text("kind").notNull().default("initial"),
  sequenceStep: integer("sequence_step").notNull().default(0),
  replyToMessageId: uuid("reply_to_message_id"),
  /** Outbound lifecycle (see docs/DISPATCH.md). Inbound rows use "received". */
  status: text("status").notNull().default("draft"),
  currentRevisionId: uuid("current_revision_id"),
  // provider identity / threading
  providerMessageId: text("provider_message_id"),   // immutable ID when available
  providerDraftId: text("provider_draft_id"),
  /** Provider-side fingerprint (Graph changeKey) right after our last write to the draft. */
  providerDraftFingerprint: text("provider_draft_fingerprint"),
  /** Revision the provider draft was built from. */
  providerDraftRevisionId: uuid("provider_draft_revision_id"),
  internetMessageId: text("internet_message_id"),
  providerConversationId: text("provider_conversation_id"),
  inReplyTo: text("in_reply_to"),
  referencesHeader: text("references_header"),
  providerFolderId: text("provider_folder_id"),
  webLink: text("web_link"),
  // denormalised view of content (authoritative content for outbound lives in revisions)
  fromAddress: text("from_address"),
  toAddresses: jsonb("to_addresses").notNull().default([]),
  ccAddresses: jsonb("cc_addresses").notNull().default([]),
  subject: text("subject"),
  bodyText: text("body_text"),
  bodyHtmlSanitized: text("body_html_sanitized"),
  hasAttachments: boolean("has_attachments").notNull().default(false),
  isRead: boolean("is_read").notNull().default(true),
  receivedAt: ts("received_at"),
  submittedAt: ts("submitted_at"),
  recordedSentAt: ts("recorded_sent_at"),
  /** app | provider_sync | historical_import | external_outlook */
  evidenceSource: text("evidence_source").notNull().default("app"),
  // reply classification
  category: text("category"),
  categorySource: text("category_source"),        // rule | ai | manual
  categoryConfidence: doublePrecision("category_confidence"),
  isAutomated: boolean("is_automated").notNull().default(false),
  isBounce: boolean("is_bounce").notNull().default(false),
  bouncedAddress: text("bounced_address"),
  needsReview: boolean("needs_review").notNull().default(false),
  reviewReason: text("review_reason"),
  isDemo: boolean("is_demo").notNull().default(false),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => [
  uniqueIndex("msg_provider_idx").on(t.mailboxId, t.providerMessageId),
  index("msg_internet_idx").on(t.internetMessageId),
  index("msg_company_idx").on(t.companyId),
  index("msg_conv_idx").on(t.conversationId),
]);

export const messageRevisions = pgTable("message_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  revisionNo: integer("revision_no").notNull(),
  mailboxId: uuid("mailbox_id"),
  subject: text("subject").notNull(),
  bodyHtml: text("body_html").notNull(),
  bodyText: text("body_text").notNull(),
  toAddresses: jsonb("to_addresses").notNull(),
  ccAddresses: jsonb("cc_addresses").notNull().default([]),
  /** [{documentVersionId, filename, sha256, size}] */
  attachments: jsonb("attachments").notNull().default([]),
  contentHash: text("content_hash").notNull(),
  templateId: uuid("template_id"),
  createdBy: text("created_by").notNull().default("user"), // user | template | ai_suggestion | import
  createdAt: created(),
}, (t) => [uniqueIndex("rev_no_idx").on(t.messageId, t.revisionNo)]);

export const approvals = pgTable("approvals", {
  id: uuid("id").primaryKey().defaultRandom(),
  messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  revisionId: uuid("revision_id").notNull().references(() => messageRevisions.id),
  contentHash: text("content_hash").notNull(),
  mailboxId: uuid("mailbox_id").notNull(),
  approvedAt: ts("approved_at").notNull().defaultNow(),
  approvedVia: text("approved_via").notNull().default("review"), // review | send_now | batch
  revokedAt: ts("revoked_at"),
  revokeReason: text("revoke_reason"),
}, (t) => [index("approvals_msg_idx").on(t.messageId)]);

// ───────────────────────── Scheduling & dispatch ─────────────────────────
export const scheduledSends = pgTable("scheduled_sends", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => owners.id, { onDelete: "cascade" }),
  messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  revisionId: uuid("revision_id").notNull().references(() => messageRevisions.id),
  approvalId: uuid("approval_id").references(() => approvals.id),
  mailboxId: uuid("mailbox_id").notNull().references(() => mailboxes.id),
  campaignId: uuid("campaign_id"),
  /** scheduled | held | paused | dispatching | submitted | recorded_sent | uncertain | failed | cancelled | superseded */
  state: text("state").notNull().default("scheduled"),
  plannedAt: ts("planned_at").notNull(),          // UTC instant
  intentLocal: text("intent_local").notNull(),    // "2027-01-11T07:00" as chosen
  intentZone: text("intent_zone").notNull(),      // IANA zone the intent is expressed in
  mode: text("mode").notNull(),                   // recipient_local | my_local
  dstResolution: text("dst_resolution"),          // none | shift_forward | earlier_offset | later_offset
  version: integer("version").notNull().default(1),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: ts("lease_expires_at"),
  attemptCount: integer("attempt_count").notNull().default(0),
  nextAttemptAt: ts("next_attempt_at"),
  holdReason: text("hold_reason"),
  lastError: text("last_error"),
  dispatchStartedAt: ts("dispatch_started_at"),
  submittedAt: ts("submitted_at"),
  recordedSentAt: ts("recorded_sent_at"),
  cancelledAt: ts("cancelled_at"),
  attemptKey: text("attempt_key"),                // local idempotency marker (not a provider guarantee)
  /** queued | claimed | draft_ready | send_requested | done — survives crashes to decide safe retry vs uncertain. */
  phase: text("phase").notNull().default("queued"),
  /** Set when the user cancels after the atomic claim; honoured only before send_requested. */
  cancelRequestedAt: ts("cancel_requested_at"),
  reconcileAttempts: integer("reconcile_attempts").notNull().default(0),
  resolutionRequired: boolean("resolution_required").notNull().default(false),
  isDemo: boolean("is_demo").notNull().default(false),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => [
  index("sched_due_idx").on(t.state, t.plannedAt),
  index("sched_msg_idx").on(t.messageId),
]);

export const dispatchAttempts = pgTable("dispatch_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  scheduledSendId: uuid("scheduled_send_id").notNull().references(() => scheduledSends.id, { onDelete: "cascade" }),
  attemptNo: integer("attempt_no").notNull(),
  workerId: text("worker_id").notNull(),
  startedAt: ts("started_at").notNull().defaultNow(),
  finishedAt: ts("finished_at"),
  /** submitted | retryable_failure | terminal_failure | uncertain | skipped | held */
  outcome: text("outcome"),
  httpStatus: integer("http_status"),
  providerRequestId: text("provider_request_id"),
  errorSummary: text("error_summary"),
});

export const queueEvents = pgTable("queue_events", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  ownerId: uuid("owner_id").notNull(),
  scheduledSendId: uuid("scheduled_send_id"),
  messageId: uuid("message_id"),
  fromState: text("from_state"),
  toState: text("to_state").notNull(),
  reason: text("reason"),
  actor: text("actor").notNull(),                  // user | worker:<id> | system
  data: jsonb("data").notNull().default({}),
  at: ts("at").notNull().defaultNow(),
}, (t) => [index("qe_sched_idx").on(t.scheduledSendId)]);

/** Durable job queue / transactional outbox. Rows are written in the same transaction as the domain change. */
export const jobs = pgTable("jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id"),
  kind: text("kind").notNull(),
  payload: jsonb("payload").notNull().default({}),
  runAt: ts("run_at").notNull().defaultNow(),
  status: text("status").notNull().default("queued"), // queued | running | done | failed | cancelled
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(5),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: ts("lease_expires_at"),
  lastError: text("last_error"),
  dedupeKey: text("dedupe_key"),
  createdAt: created(),
  finishedAt: ts("finished_at"),
}, (t) => [index("jobs_due_idx").on(t.status, t.runAt), uniqueIndex("jobs_dedupe_idx").on(t.dedupeKey)]);

export const workerHeartbeats = pgTable("worker_heartbeats", {
  workerId: text("worker_id").primaryKey(),
  startedAt: ts("started_at").notNull(),
  lastBeatAt: ts("last_beat_at").notNull(),
  info: jsonb("info").notNull().default({}),
});

// ───────────────────────── Documents, templates, profile ─────────────────────────
export const documents = pgTable("documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => owners.id, { onDelete: "cascade" }),
  kind: text("kind").notNull().default("cv"),
  title: text("title").notNull(),
  description: text("description"),
  industryTags: jsonb("industry_tags").notNull().default([]),
  currentVersionId: uuid("current_version_id"),
  archived: boolean("archived").notNull().default(false),
  /** Future integration boundary for the separate CV creation app. */
  externalSource: text("external_source"),
  externalRef: text("external_ref"),
  isDemo: boolean("is_demo").notNull().default(false),
  createdAt: created(),
});

export const documentVersions = pgTable("document_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "restrict" }),
  versionNo: integer("version_no").notNull(),
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  sha256: text("sha256").notNull(),
  storageKey: text("storage_key").notNull(),
  note: text("note"),
  uploadedAt: ts("uploaded_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("docver_no_idx").on(t.documentId, t.versionNo)]);

export const templates = pgTable("templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => owners.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  kind: text("kind").notNull().default("initial"), // initial | followup | reply
  subject: text("subject").notNull(),
  bodyHtml: text("body_html").notNull(),
  requiredPlaceholders: jsonb("required_placeholders").notNull().default([]),
  isDemo: boolean("is_demo").notNull().default(false),
  createdAt: created(),
  updatedAt: updated(),
});

export const candidateProfile = pgTable("candidate_profile", {
  ownerId: uuid("owner_id").primaryKey().references(() => owners.id, { onDelete: "cascade" }),
  /** {name, education[], skills[], projects[{name,summary,skills[]}], achievements[], availability, statements[], signature} each item {text, verified:boolean} */
  data: jsonb("data").notNull().default({}),
  updatedAt: updated(),
});

// ───────────────────────── Tasks, imports, exports, AI, suppression, audit ─────────────────────────
export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => owners.id, { onDelete: "cascade" }),
  companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
  contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
  opportunityId: uuid("opportunity_id").references(() => opportunities.id, { onDelete: "set null" }),
  messageId: uuid("message_id"),
  kind: text("kind").notNull().default("reminder"), // reminder | research | interview_prep | reply | replacement_contact | review
  title: text("title").notNull(),
  dueAt: ts("due_at"),
  status: text("status").notNull().default("open"), // open | done | dismissed
  isDemo: boolean("is_demo").notNull().default(false),
  createdAt: created(),
  completedAt: ts("completed_at"),
}, (t) => [index("tasks_owner_due_idx").on(t.ownerId, t.status, t.dueAt)]);

export const importBatches = pgTable("import_batches", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => owners.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),                   // workbook | csv | apollo_csv
  filename: text("filename").notNull(),
  fileSha256: text("file_sha256").notNull(),
  storageKey: text("storage_key"),
  /** previewed | committed | rolled_back | correction_needed | failed */
  status: text("status").notNull().default("previewed"),
  sheetConfig: jsonb("sheet_config").notNull().default([]),
  report: jsonb("report").notNull().default({}),
  createdAt: created(),
  committedAt: ts("committed_at"),
  rolledBackAt: ts("rolled_back_at"),
});

export const importRows = pgTable("import_rows", {
  id: uuid("id").primaryKey().defaultRandom(),
  batchId: uuid("batch_id").notNull().references(() => importBatches.id, { onDelete: "cascade" }),
  sheet: text("sheet").notNull(),
  rowNumber: integer("row_number").notNull(),
  raw: jsonb("raw").notNull(),
  /** add | update | unchanged | duplicate_review | invalid | skip | evidence */
  action: text("action").notNull(),
  entityType: text("entity_type"),
  entityId: uuid("entity_id"),
  /** Values written by this import, to support safe rollback. */
  appliedFields: jsonb("applied_fields").notNull().default({}),
  issues: jsonb("issues").notNull().default([]),
}, (t) => [index("import_rows_batch_idx").on(t.batchId)]);

export const columnMappings = pgTable("column_mappings", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => owners.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  kind: text("kind").notNull(),                   // company | evidence | apollo_contacts
  headerSignature: text("header_signature").notNull(),
  mapping: jsonb("mapping").notNull(),
  createdAt: created(),
}, (t) => [uniqueIndex("mapping_sig_idx").on(t.ownerId, t.kind, t.headerSignature)]);

export const duplicateCandidates = pgTable("duplicate_candidates", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => owners.id, { onDelete: "cascade" }),
  batchId: uuid("batch_id").references(() => importBatches.id, { onDelete: "cascade" }),
  importRowId: uuid("import_row_id"),
  existingCompanyId: uuid("existing_company_id").references(() => companies.id, { onDelete: "cascade" }),
  incoming: jsonb("incoming").notNull(),
  reason: text("reason").notNull(),
  /** open | linked_existing | created_separate | dismissed */
  status: text("status").notNull().default("open"),
  resolvedAt: ts("resolved_at"),
  createdAt: created(),
});

export const exportBatches = pgTable("export_batches", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => owners.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  filters: jsonb("filters").notNull().default({}),
  rowCount: integer("row_count").notNull().default(0),
  createdAt: created(),
});

export const savedViews = pgTable("saved_views", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => owners.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  view: text("view").notNull().default("companies"),
  filters: jsonb("filters").notNull(),
  createdAt: created(),
});

export const aiJobs = pgTable("ai_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => owners.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),           // openai | anthropic | mock | manual_exchange
  model: text("model"),
  task: text("task").notNull(),                   // draft_email | suggest_cv | contact_priorities | summarize | classify_reply
  status: text("status").notNull().default("pending"), // pending | completed | failed | blocked_budget
  input: jsonb("input").notNull().default({}),
  result: jsonb("result"),
  error: text("error"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  usageIsEstimate: boolean("usage_is_estimate").notNull().default(true),
  createdAt: created(),
});

export const aiExchangePackages = pgTable("ai_exchange_packages", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => owners.id, { onDelete: "cascade" }),
  task: text("task").notNull(),
  schemaVersion: text("schema_version").notNull(),
  /** [{type:"company", id, revision}] */
  recordRefs: jsonb("record_refs").notNull(),
  createdAt: created(),
});

export const aiExchangeResults = pgTable("ai_exchange_results", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => owners.id, { onDelete: "cascade" }),
  packageId: uuid("package_id").notNull().references(() => aiExchangePackages.id, { onDelete: "cascade" }),
  recordType: text("record_type").notNull(),
  recordId: uuid("record_id").notNull(),
  recordRevision: integer("record_revision"),
  result: jsonb("result").notNull(),
  resultHash: text("result_hash").notNull(),
  /** pending | accepted | rejected | stale | invalid */
  status: text("status").notNull().default("pending"),
  issues: jsonb("issues").notNull().default([]),
  decidedAt: ts("decided_at"),
  createdAt: created(),
}, (t) => [uniqueIndex("aiex_hash_idx").on(t.packageId, t.resultHash)]);

export const suppressions = pgTable("suppressions", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => owners.id, { onDelete: "cascade" }),
  scope: text("scope").notNull(),                 // address | contact | company | domain
  value: text("value").notNull(),                 // normalized address / uuid / domain
  reason: text("reason").notNull(),
  createdAt: created(),
}, (t) => [uniqueIndex("supp_scope_idx").on(t.ownerId, t.scope, t.value)]);

export const auditEvents = pgTable("audit_events", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  ownerId: uuid("owner_id").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  action: text("action").notNull(),
  before: jsonb("before"),
  after: jsonb("after"),
  actor: text("actor").notNull().default("user"),
  at: ts("at").notNull().defaultNow(),
}, (t) => [index("audit_entity_idx").on(t.entityType, t.entityId)]);

export const providerCredentials = pgTable("provider_credentials", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => owners.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),           // apollo | openai | anthropic | geocoder
  secretEnc: text("secret_enc"),
  config: jsonb("config").notNull().default({}),
  /** unconfigured | connected | restricted | error */
  status: text("status").notNull().default("unconfigured"),
  statusReason: text("status_reason"),
  updatedAt: updated(),
}, (t) => [uniqueIndex("cred_provider_idx").on(t.ownerId, t.provider)]);

export const usageLedger = pgTable("usage_ledger", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => owners.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  unit: text("unit").notNull(),                   // credits | requests | input_tokens | output_tokens
  amount: numeric("amount").notNull(),
  isEstimate: boolean("is_estimate").notNull(),
  ref: text("ref"),
  at: ts("at").notNull().defaultNow(),
});

export const geocodeCache = pgTable("geocode_cache", {
  queryKey: text("query_key").primaryKey(),
  provider: text("provider").notNull(),
  result: jsonb("result"),
  createdAt: created(),
});

