CREATE SCHEMA "audit";
--> statement-breakpoint
CREATE TYPE "public"."case_kind" AS ENUM('patient_complaint', 'ethics_notice');--> statement-breakpoint
CREATE TYPE "public"."case_outcome" AS ENUM('no_misconduct', 'warning', 'censure', 'reimbursement', 'retreatment', 'suspension', 'removal_from_register', 'amicable_settlement', 'referral_to_medical_expert', 'advisory_to_establishment', 'cease_and_desist_confirmed', 'complaint_dismissed');--> statement-breakpoint
CREATE TYPE "public"."case_state" AS ENUM('intake_received', 'awaiting_complainant_documents', 'under_scrutiny', 'awaiting_respondent_reply', 'ready_for_committee', 'awaiting_expert_report', 'awaiting_order_despatch', 'closed');--> statement-breakpoint
CREATE TYPE "public"."closure_reason" AS ENUM('complainant_unresponsive', 'amicable_settlement', 'decided_by_committee', 'withdrawn', 'no_jurisdiction', 'duplicate', 'court_seized', 'notice_complied_with', 'time_barred');--> statement-breakpoint
CREATE TYPE "public"."contact_channel" AS ENUM('email', 'phone_call', 'whatsapp', 'post', 'in_person', 'sms');--> statement-breakpoint
CREATE TYPE "public"."contact_direction" AS ENUM('in', 'out');--> statement-breakpoint
CREATE TYPE "public"."correspondence_kind" AS ENUM('ack_complaint', 'request_docs', 'request_docs_reminder', 'respondent_explanation_sought', 'respondent_reminder', 'respondent_final_notice', 'summons_complainant', 'summons_respondent', 'member_intimation', 'expert_referral_letter', 'expert_referral_copy_to_patient', 'expert_report_share', 'order_to_respondent', 'order_to_complainant', 'closure_intimation', 'ethics_explanation', 'ethics_cease_desist', 'reply_to_referring_authority', 'rti_reply_cover', 'inbound', 'other');--> statement-breakpoint
CREATE TYPE "public"."date_source" AS ENUM('recorded', 'from_physical_register', 'estimated_by_officer');--> statement-breakpoint
CREATE TYPE "public"."document_class" AS ENUM('complaint_material', 'respondent_explanation', 'expert_report', 'committee_record', 'outbound_letter', 'service_proof', 'legacy_register_extract', 'other');--> statement-breakpoint
CREATE TYPE "public"."document_status" AS ENUM('stored', 'misfiled_withdrawn');--> statement-breakpoint
CREATE TYPE "public"."followup_stage" AS ENUM('await_patient_docs', 'await_respondent_explanation', 'await_ev_explanation', 'await_gdc_report', 'await_order_despatch', 'await_compliance', 'await_despatch_entry', 'await_registrar_signature', 'await_authority_report_back', 'propose_ex_parte', 'propose_closure', 'no_next_step', 'ad_hoc');--> statement-breakpoint
CREATE TYPE "public"."followup_status" AS ENUM('open', 'snoozed', 'satisfied', 'escalated', 'superseded', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."intake_source" AS ENUM('direct_email', 'support_forward', 'dci_ndc_forward', 'police_forward', 'post', 'walk_in', 'suo_motu', 'other');--> statement-breakpoint
CREATE TYPE "public"."milestone" AS ENUM('received', 'acknowledged', 'documents_requested', 'documents_complete', 'respondent_notice_despatched', 'respondent_reply_received', 'respondent_declared_ex_parte', 'case_closed', 'case_reopened', 'expert_referral_despatched', 'expert_report_received', 'expert_report_shared', 'listed_for_sitting', 'heard', 'decision_recorded', 'order_despatched');--> statement-breakpoint
CREATE TYPE "public"."notice_state" AS ENUM('not_issued', 'awaiting_reply', 'replied', 'ex_parte', 'dropped');--> statement-breakpoint
CREATE TYPE "public"."party_kind" AS ENUM('person', 'organisation');--> statement-breakpoint
CREATE TYPE "public"."party_role" AS ENUM('complainant', 'patient', 'respondent_dentist', 'respondent_establishment', 'informant', 'witness', 'legal_representative');--> statement-breakpoint
CREATE TYPE "public"."council_role" AS ENUM('officer', 'committee_member', 'auditor');--> statement-breakpoint
CREATE TYPE "public"."service_mode" AS ENUM('email', 'registered_post_ad', 'speed_post', 'courier', 'hand_delivery', 'whatsapp');--> statement-breakpoint
CREATE TYPE "public"."waiting_on" AS ENUM('council_officer', 'complainant', 'respondent', 'expert_body', 'committee', 'nobody');--> statement-breakpoint
CREATE TABLE "app_user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"mobile" text,
	"full_name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_otp" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"attempts" text DEFAULT '0' NOT NULL,
	"request_ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_user_id" uuid NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"rotated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"family_id" uuid NOT NULL,
	"user_agent" text,
	"ip" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "council" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"address_lines" jsonb NOT NULL,
	"phone" text,
	"website" text,
	"official_email" text NOT NULL,
	"registrar_name" text NOT NULL,
	"registrar_title" text DEFAULT 'Registrar' NOT NULL,
	"president_title" text DEFAULT 'President' NOT NULL,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"production_authorised_at" timestamp with time zone,
	"is_synthetic" boolean DEFAULT false NOT NULL,
	"physical_register_retired_at" timestamp with time zone,
	"dual_running_started_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "council_config" (
	"council_id" uuid PRIMARY KEY NOT NULL,
	"config" jsonb NOT NULL,
	"schema_version" text DEFAULT '1' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "council_membership" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"council_id" uuid NOT NULL,
	"app_user_id" uuid NOT NULL,
	"role" "council_role" NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "council_office_holder" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"council_id" uuid NOT NULL,
	"office" text NOT NULL,
	"full_name" text NOT NULL,
	"designation" text,
	"starts_on" date NOT NULL,
	"ends_on" date
);
--> statement-breakpoint
CREATE TABLE "job_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_name" text NOT NULL,
	"logical_date" date NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text DEFAULT 'running' NOT NULL,
	"error" text,
	"stats" jsonb
);
--> statement-breakpoint
CREATE TABLE "case_file" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"council_id" uuid NOT NULL,
	"case_kind" "case_kind" DEFAULT 'patient_complaint' NOT NULL,
	"case_number" text NOT NULL,
	"fiscal_year" text NOT NULL,
	"register_sl_no" integer NOT NULL,
	"state" "case_state" DEFAULT 'intake_received' NOT NULL,
	"waiting_on" "waiting_on" GENERATED ALWAYS AS ((CASE state
            WHEN 'awaiting_complainant_documents'::case_state THEN 'complainant'::waiting_on
            WHEN 'awaiting_respondent_reply'::case_state      THEN 'respondent'::waiting_on
            WHEN 'awaiting_expert_report'::case_state         THEN 'expert_body'::waiting_on
            WHEN 'closed'::case_state                         THEN 'nobody'::waiting_on
            ELSE 'council_officer'::waiting_on
          END)) STORED,
	"waiting_since" timestamp with time zone DEFAULT now() NOT NULL,
	"on_hold" boolean DEFAULT false NOT NULL,
	"hold_reason" text,
	"held_since" timestamp with time zone,
	"intake_source" "intake_source" DEFAULT 'direct_email' NOT NULL,
	"external_ref_no" text,
	"external_authority_name" text,
	"external_due_at" date,
	"summary" text DEFAULT '' NOT NULL,
	"remarks" text,
	"documents_complete_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"closure_reason" "closure_reason",
	"closure_note" text,
	"is_backfilled" boolean DEFAULT false NOT NULL,
	"legacy_register_ref" text,
	"owner_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"deletion_reason" text,
	CONSTRAINT "case_file_closed_needs_reason" CHECK ((state <> 'closed') OR (closure_reason IS NOT NULL AND closed_at IS NOT NULL)),
	CONSTRAINT "case_file_hold_needs_reason" CHECK ((on_hold = false) OR (hold_reason IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "case_milestone" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"council_id" uuid NOT NULL,
	"case_file_id" uuid NOT NULL,
	"milestone" "milestone" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"date_source" date_source NOT NULL,
	"case_respondent_id" uuid,
	"seq_no" integer,
	"ref_table" text,
	"ref_id" uuid,
	"note" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_by" uuid
);
--> statement-breakpoint
CREATE TABLE "case_note" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"council_id" uuid NOT NULL,
	"case_file_id" uuid NOT NULL,
	"body" text NOT NULL,
	"supersedes_note_id" uuid,
	"amendment_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "case_party" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"council_id" uuid NOT NULL,
	"case_file_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"role" "party_role" NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_respondent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"council_id" uuid NOT NULL,
	"case_file_id" uuid NOT NULL,
	"case_party_id" uuid NOT NULL,
	"notice_state" "notice_state" DEFAULT 'not_issued' NOT NULL,
	"notice_count" integer DEFAULT 0 NOT NULL,
	"reply_due_at" date,
	"first_reply_at" timestamp with time zone,
	"ex_parte_eligible" boolean DEFAULT false NOT NULL,
	"ex_parte_at" timestamp with time zone,
	"ex_parte_reason" text,
	"dropped_at" timestamp with time zone,
	"dropped_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "case_respondent_ex_parte_needs_reason" CHECK ((ex_parte_at IS NULL) OR (ex_parte_reason IS NOT NULL)),
	CONSTRAINT "case_respondent_drop_needs_reason" CHECK ((dropped_at IS NULL) OR (dropped_reason IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "case_state_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"council_id" uuid NOT NULL,
	"case_file_id" uuid NOT NULL,
	"from_state" "case_state",
	"to_state" "case_state" NOT NULL,
	"event" text NOT NULL,
	"reason" text,
	"actor_user_id" uuid,
	"is_system" boolean DEFAULT false NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"council_id" uuid NOT NULL,
	"case_file_id" uuid NOT NULL,
	"party_id" uuid,
	"channel" "contact_channel" NOT NULL,
	"direction" "contact_direction" NOT NULL,
	"purpose" text,
	"summary" text NOT NULL,
	"outcome" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_by" uuid
);
--> statement-breakpoint
CREATE TABLE "party" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"council_id" uuid NOT NULL,
	"kind" "party_kind" DEFAULT 'person' NOT NULL,
	"full_name" text NOT NULL,
	"mobile" text,
	"mobile_normalised" text,
	"email" text,
	"address_lines" jsonb,
	"age_years" integer,
	"sex" text,
	"registered_dentist_id" uuid,
	"is_confidential" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registered_dentist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"council_id" uuid NOT NULL,
	"registration_no" text NOT NULL,
	"full_name" text NOT NULL,
	"qualification" text,
	"clinic_name" text,
	"address_lines" jsonb,
	"email" text,
	"mobile" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "respondent_notice" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"council_id" uuid NOT NULL,
	"case_respondent_id" uuid NOT NULL,
	"seq_no" integer NOT NULL,
	"correspondence_id" uuid,
	"sent_at" timestamp with time zone,
	"service_mode" "service_mode",
	"service_proof_document_id" uuid,
	"reply_due_at" date,
	"reply_received_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "follow_up" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"council_id" uuid NOT NULL,
	"case_file_id" uuid,
	"case_respondent_id" uuid,
	"stage" "followup_stage" NOT NULL,
	"waiting_on_kind" "waiting_on" NOT NULL,
	"waiting_on_party_id" uuid,
	"assignee_user_id" uuid,
	"title" text NOT NULL,
	"detail" text,
	"opened_on" date NOT NULL,
	"due_on" date NOT NULL,
	"is_statutory" boolean DEFAULT false NOT NULL,
	"status" "followup_status" DEFAULT 'open' NOT NULL,
	"escalation_level" integer DEFAULT 0 NOT NULL,
	"escalated_from_id" uuid,
	"snoozed_until" date,
	"snooze_count" integer DEFAULT 0 NOT NULL,
	"satisfied_at" timestamp with time zone,
	"satisfied_by" uuid,
	"satisfied_by_contact_event_id" uuid,
	"resolution_note" text,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "notification_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"council_id" uuid NOT NULL,
	"app_user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"channel" text DEFAULT 'email' NOT NULL,
	"logical_date" date NOT NULL,
	"subject" text,
	"item_count" integer,
	"sent_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "correspondence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"council_id" uuid NOT NULL,
	"case_file_id" uuid,
	"kind" "correspondence_kind" NOT NULL,
	"direction" "contact_direction" NOT NULL,
	"to_party_id" uuid,
	"to_name" text,
	"to_email" text,
	"from_email" text,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"template_version_id" uuid,
	"merge_context" jsonb,
	"sent_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	"despatch_no" text,
	"despatch_date" date,
	"despatch_register_page" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "correspondence_despatch_needs_date" CHECK ((despatch_no IS NULL) OR (despatch_date IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"council_id" uuid NOT NULL,
	"case_file_id" uuid,
	"title" text NOT NULL,
	"document_class" "document_class" DEFAULT 'complaint_material' NOT NULL,
	"status" "document_status" DEFAULT 'stored' NOT NULL,
	"misfiled_reason" text,
	"current_version_id" uuid,
	"physical_original_held" boolean DEFAULT false NOT NULL,
	"physical_returned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "document_access_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"council_id" uuid NOT NULL,
	"document_version_id" uuid NOT NULL,
	"app_user_id" uuid,
	"action" text NOT NULL,
	"ip" text,
	"user_agent" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"council_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"storage_key" text NOT NULL,
	"original_filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"uploaded_by" uuid
);
--> statement-breakpoint
CREATE TABLE "number_allocation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"council_id" uuid NOT NULL,
	"series" text NOT NULL,
	"fiscal_year" text NOT NULL,
	"value" integer NOT NULL,
	"formatted" text NOT NULL,
	"case_file_id" uuid,
	"allocated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"allocated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "number_sequence" (
	"council_id" uuid NOT NULL,
	"series" text NOT NULL,
	"fiscal_year" text NOT NULL,
	"next_value" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"council_id" uuid NOT NULL,
	"kind" "correspondence_kind" NOT NULL,
	"name" text NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"requires_registrar_signature" boolean DEFAULT false NOT NULL,
	"current_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "template_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"council_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"subject_tpl" text NOT NULL,
	"body" text NOT NULL,
	"published_at" timestamp with time zone,
	"published_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit"."events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"council_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"prev_hash" text,
	"hash" text NOT NULL,
	"canonical_payload" text NOT NULL,
	"action" text NOT NULL,
	"entity_table" text,
	"entity_id" uuid,
	"case_file_id" uuid,
	"actor_user_id" uuid,
	"actor_role" text,
	"before" jsonb,
	"after" jsonb,
	"ip" text,
	"user_agent" text,
	"request_id" uuid,
	"metadata" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit"."seal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"council_id" uuid NOT NULL,
	"head_seq" bigint NOT NULL,
	"head_hash" text NOT NULL,
	"signature" text NOT NULL,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"storage_key" text
);
--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_app_user_id_app_user_id_fk" FOREIGN KEY ("app_user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "council_config" ADD CONSTRAINT "council_config_council_id_council_id_fk" FOREIGN KEY ("council_id") REFERENCES "public"."council"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "council_membership" ADD CONSTRAINT "council_membership_council_id_council_id_fk" FOREIGN KEY ("council_id") REFERENCES "public"."council"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "council_membership" ADD CONSTRAINT "council_membership_app_user_id_app_user_id_fk" FOREIGN KEY ("app_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "council_office_holder" ADD CONSTRAINT "council_office_holder_council_id_council_id_fk" FOREIGN KEY ("council_id") REFERENCES "public"."council"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_file" ADD CONSTRAINT "case_file_council_id_council_id_fk" FOREIGN KEY ("council_id") REFERENCES "public"."council"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_file" ADD CONSTRAINT "case_file_owner_user_id_app_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_file" ADD CONSTRAINT "case_file_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_file" ADD CONSTRAINT "case_file_deleted_by_app_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_milestone" ADD CONSTRAINT "case_milestone_council_id_council_id_fk" FOREIGN KEY ("council_id") REFERENCES "public"."council"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_milestone" ADD CONSTRAINT "case_milestone_case_file_id_case_file_id_fk" FOREIGN KEY ("case_file_id") REFERENCES "public"."case_file"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_milestone" ADD CONSTRAINT "case_milestone_case_respondent_id_case_respondent_id_fk" FOREIGN KEY ("case_respondent_id") REFERENCES "public"."case_respondent"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_milestone" ADD CONSTRAINT "case_milestone_recorded_by_app_user_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_note" ADD CONSTRAINT "case_note_council_id_council_id_fk" FOREIGN KEY ("council_id") REFERENCES "public"."council"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_note" ADD CONSTRAINT "case_note_case_file_id_case_file_id_fk" FOREIGN KEY ("case_file_id") REFERENCES "public"."case_file"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_note" ADD CONSTRAINT "case_note_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_party" ADD CONSTRAINT "case_party_council_id_council_id_fk" FOREIGN KEY ("council_id") REFERENCES "public"."council"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_party" ADD CONSTRAINT "case_party_case_file_id_case_file_id_fk" FOREIGN KEY ("case_file_id") REFERENCES "public"."case_file"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_party" ADD CONSTRAINT "case_party_party_id_party_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."party"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_respondent" ADD CONSTRAINT "case_respondent_council_id_council_id_fk" FOREIGN KEY ("council_id") REFERENCES "public"."council"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_respondent" ADD CONSTRAINT "case_respondent_case_file_id_case_file_id_fk" FOREIGN KEY ("case_file_id") REFERENCES "public"."case_file"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_respondent" ADD CONSTRAINT "case_respondent_case_party_id_case_party_id_fk" FOREIGN KEY ("case_party_id") REFERENCES "public"."case_party"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_state_history" ADD CONSTRAINT "case_state_history_council_id_council_id_fk" FOREIGN KEY ("council_id") REFERENCES "public"."council"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_state_history" ADD CONSTRAINT "case_state_history_case_file_id_case_file_id_fk" FOREIGN KEY ("case_file_id") REFERENCES "public"."case_file"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_state_history" ADD CONSTRAINT "case_state_history_actor_user_id_app_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_event" ADD CONSTRAINT "contact_event_council_id_council_id_fk" FOREIGN KEY ("council_id") REFERENCES "public"."council"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_event" ADD CONSTRAINT "contact_event_case_file_id_case_file_id_fk" FOREIGN KEY ("case_file_id") REFERENCES "public"."case_file"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_event" ADD CONSTRAINT "contact_event_party_id_party_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."party"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_event" ADD CONSTRAINT "contact_event_recorded_by_app_user_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party" ADD CONSTRAINT "party_council_id_council_id_fk" FOREIGN KEY ("council_id") REFERENCES "public"."council"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party" ADD CONSTRAINT "party_registered_dentist_id_registered_dentist_id_fk" FOREIGN KEY ("registered_dentist_id") REFERENCES "public"."registered_dentist"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registered_dentist" ADD CONSTRAINT "registered_dentist_council_id_council_id_fk" FOREIGN KEY ("council_id") REFERENCES "public"."council"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "respondent_notice" ADD CONSTRAINT "respondent_notice_council_id_council_id_fk" FOREIGN KEY ("council_id") REFERENCES "public"."council"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "respondent_notice" ADD CONSTRAINT "respondent_notice_case_respondent_id_case_respondent_id_fk" FOREIGN KEY ("case_respondent_id") REFERENCES "public"."case_respondent"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_up" ADD CONSTRAINT "follow_up_council_id_council_id_fk" FOREIGN KEY ("council_id") REFERENCES "public"."council"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_up" ADD CONSTRAINT "follow_up_case_file_id_case_file_id_fk" FOREIGN KEY ("case_file_id") REFERENCES "public"."case_file"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_up" ADD CONSTRAINT "follow_up_case_respondent_id_case_respondent_id_fk" FOREIGN KEY ("case_respondent_id") REFERENCES "public"."case_respondent"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_up" ADD CONSTRAINT "follow_up_waiting_on_party_id_party_id_fk" FOREIGN KEY ("waiting_on_party_id") REFERENCES "public"."party"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_up" ADD CONSTRAINT "follow_up_assignee_user_id_app_user_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_up" ADD CONSTRAINT "follow_up_satisfied_by_app_user_id_fk" FOREIGN KEY ("satisfied_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_up" ADD CONSTRAINT "follow_up_satisfied_by_contact_event_id_contact_event_id_fk" FOREIGN KEY ("satisfied_by_contact_event_id") REFERENCES "public"."contact_event"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_up" ADD CONSTRAINT "follow_up_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_council_id_council_id_fk" FOREIGN KEY ("council_id") REFERENCES "public"."council"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_app_user_id_app_user_id_fk" FOREIGN KEY ("app_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correspondence" ADD CONSTRAINT "correspondence_council_id_council_id_fk" FOREIGN KEY ("council_id") REFERENCES "public"."council"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correspondence" ADD CONSTRAINT "correspondence_case_file_id_case_file_id_fk" FOREIGN KEY ("case_file_id") REFERENCES "public"."case_file"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correspondence" ADD CONSTRAINT "correspondence_to_party_id_party_id_fk" FOREIGN KEY ("to_party_id") REFERENCES "public"."party"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correspondence" ADD CONSTRAINT "correspondence_template_version_id_template_version_id_fk" FOREIGN KEY ("template_version_id") REFERENCES "public"."template_version"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correspondence" ADD CONSTRAINT "correspondence_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_council_id_council_id_fk" FOREIGN KEY ("council_id") REFERENCES "public"."council"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_case_file_id_case_file_id_fk" FOREIGN KEY ("case_file_id") REFERENCES "public"."case_file"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_access_log" ADD CONSTRAINT "document_access_log_council_id_council_id_fk" FOREIGN KEY ("council_id") REFERENCES "public"."council"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_access_log" ADD CONSTRAINT "document_access_log_document_version_id_document_version_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."document_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_access_log" ADD CONSTRAINT "document_access_log_app_user_id_app_user_id_fk" FOREIGN KEY ("app_user_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_version" ADD CONSTRAINT "document_version_council_id_council_id_fk" FOREIGN KEY ("council_id") REFERENCES "public"."council"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_version" ADD CONSTRAINT "document_version_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_version" ADD CONSTRAINT "document_version_uploaded_by_app_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_allocation" ADD CONSTRAINT "number_allocation_council_id_council_id_fk" FOREIGN KEY ("council_id") REFERENCES "public"."council"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_allocation" ADD CONSTRAINT "number_allocation_case_file_id_case_file_id_fk" FOREIGN KEY ("case_file_id") REFERENCES "public"."case_file"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_allocation" ADD CONSTRAINT "number_allocation_allocated_by_app_user_id_fk" FOREIGN KEY ("allocated_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_sequence" ADD CONSTRAINT "number_sequence_council_id_council_id_fk" FOREIGN KEY ("council_id") REFERENCES "public"."council"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template" ADD CONSTRAINT "template_council_id_council_id_fk" FOREIGN KEY ("council_id") REFERENCES "public"."council"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_version" ADD CONSTRAINT "template_version_council_id_council_id_fk" FOREIGN KEY ("council_id") REFERENCES "public"."council"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_version" ADD CONSTRAINT "template_version_template_id_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."template"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_version" ADD CONSTRAINT "template_version_published_by_app_user_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_user_email_uq" ON "app_user" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "auth_otp_email_ix" ON "auth_otp" USING btree (lower("email"),"created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_session_token_uq" ON "auth_session" USING btree ("refresh_token_hash");--> statement-breakpoint
CREATE INDEX "auth_session_user_ix" ON "auth_session" USING btree ("app_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "council_code_uq" ON "council" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "council_membership_uq" ON "council_membership" USING btree ("council_id","app_user_id","role");--> statement-breakpoint
CREATE INDEX "council_membership_user_ix" ON "council_membership" USING btree ("app_user_id");--> statement-breakpoint
CREATE INDEX "office_holder_council_ix" ON "council_office_holder" USING btree ("council_id","office");--> statement-breakpoint
CREATE UNIQUE INDEX "job_run_uq" ON "job_run" USING btree ("job_name","logical_date");--> statement-breakpoint
CREATE UNIQUE INDEX "case_file_number_uq" ON "case_file" USING btree ("council_id","case_number");--> statement-breakpoint
CREATE UNIQUE INDEX "case_file_serial_uq" ON "case_file" USING btree ("council_id","fiscal_year","register_sl_no");--> statement-breakpoint
CREATE INDEX "case_file_queue_ix" ON "case_file" USING btree ("council_id","state","waiting_since");--> statement-breakpoint
CREATE INDEX "case_file_waiting_ix" ON "case_file" USING btree ("council_id","waiting_on","waiting_since");--> statement-breakpoint
CREATE INDEX "case_milestone_case_ix" ON "case_milestone" USING btree ("council_id","case_file_id","occurred_at");--> statement-breakpoint
CREATE INDEX "case_note_case_ix" ON "case_note" USING btree ("council_id","case_file_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "case_party_uq" ON "case_party" USING btree ("case_file_id","party_id","role");--> statement-breakpoint
CREATE INDEX "case_party_case_ix" ON "case_party" USING btree ("council_id","case_file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "case_respondent_uq" ON "case_respondent" USING btree ("case_file_id","case_party_id");--> statement-breakpoint
CREATE INDEX "case_respondent_case_ix" ON "case_respondent" USING btree ("council_id","case_file_id","notice_state");--> statement-breakpoint
CREATE INDEX "case_state_history_case_ix" ON "case_state_history" USING btree ("council_id","case_file_id","occurred_at");--> statement-breakpoint
CREATE INDEX "contact_event_case_ix" ON "contact_event" USING btree ("council_id","case_file_id","occurred_at");--> statement-breakpoint
CREATE INDEX "party_council_name_ix" ON "party" USING btree ("council_id","full_name");--> statement-breakpoint
CREATE INDEX "party_mobile_ix" ON "party" USING btree ("council_id","mobile_normalised");--> statement-breakpoint
CREATE UNIQUE INDEX "registered_dentist_uq" ON "registered_dentist" USING btree ("council_id","registration_no");--> statement-breakpoint
CREATE INDEX "registered_dentist_name_ix" ON "registered_dentist" USING btree ("council_id","full_name");--> statement-breakpoint
CREATE UNIQUE INDEX "respondent_notice_uq" ON "respondent_notice" USING btree ("case_respondent_id","seq_no");--> statement-breakpoint
CREATE UNIQUE INDEX "follow_up_dedupe_uq" ON "follow_up" USING btree ("council_id","dedupe_key") WHERE status IN ('open','snoozed');--> statement-breakpoint
CREATE INDEX "follow_up_queue_ix" ON "follow_up" USING btree ("council_id","due_on") WHERE status IN ('open','snoozed');--> statement-breakpoint
CREATE INDEX "follow_up_case_ix" ON "follow_up" USING btree ("council_id","case_file_id","status");--> statement-breakpoint
CREATE INDEX "follow_up_group_ix" ON "follow_up" USING btree ("council_id","waiting_on_kind","due_on") WHERE status IN ('open','snoozed');--> statement-breakpoint
CREATE UNIQUE INDEX "notification_log_uq" ON "notification_log" USING btree ("app_user_id","kind","logical_date");--> statement-breakpoint
CREATE INDEX "correspondence_case_ix" ON "correspondence" USING btree ("council_id","case_file_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "correspondence_despatch_uq" ON "correspondence" USING btree ("council_id","despatch_no") WHERE despatch_no IS NOT NULL;--> statement-breakpoint
CREATE INDEX "document_case_ix" ON "document" USING btree ("council_id","case_file_id","created_at");--> statement-breakpoint
CREATE INDEX "document_access_log_ix" ON "document_access_log" USING btree ("council_id","document_version_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "document_version_uq" ON "document_version" USING btree ("document_id","version_no");--> statement-breakpoint
CREATE UNIQUE INDEX "document_version_key_uq" ON "document_version" USING btree ("storage_key");--> statement-breakpoint
CREATE UNIQUE INDEX "number_allocation_uq" ON "number_allocation" USING btree ("council_id","series","fiscal_year","value");--> statement-breakpoint
CREATE UNIQUE INDEX "number_sequence_pk" ON "number_sequence" USING btree ("council_id","series","fiscal_year");--> statement-breakpoint
CREATE UNIQUE INDEX "template_kind_uq" ON "template" USING btree ("council_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "template_version_uq" ON "template_version" USING btree ("template_id","version_no");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_events_seq_uq" ON "audit"."events" USING btree ("council_id","seq");--> statement-breakpoint
CREATE INDEX "audit_events_entity_ix" ON "audit"."events" USING btree ("council_id","entity_table","entity_id");--> statement-breakpoint
CREATE INDEX "audit_events_case_ix" ON "audit"."events" USING btree ("council_id","case_file_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_seal_uq" ON "audit"."seal" USING btree ("council_id","head_seq");